/**
 * Tool registry + handlers for `rebuildup.mcp` (contract
 * `herdr-plugins.mcp/v1`, T2 #138 read surface + T3 #139 mutation
 * surface).
 *
 * Every implemented tool returns a structured payload that the server
 * wraps as `{contract, ok:true, tool, result}` in `structuredContent`
 * (plus a JSON text representation). Failures throw `ToolError` with a
 * contract error code — never fabricated success.
 *
 * Identity echo (ADR-0025 §4): results that touch herdr objects carry
 * an `identity` block resolved live from `session.snapshot`/`agent.*`
 * — host, herdr session name, workspace/tab/pane ids, agent kind,
 * `agent_session`, `state_change_seq`. Optional `expect_*` arguments
 * on agent reads refuse mismatches with `stale_generation`.
 */

import os from "node:os";
import {
  AGENT_STATUSES,
  type AgentInfo,
  type AgentReadResult,
  type AgentStatus,
  agentGet,
  agentList,
  agentRead,
  type CallOptions,
  HerdrRpcError,
  paneAgentEntries,
  type SessionSnapshot,
  sessionSnapshot,
  workspaceCreate,
} from "../../../packages/herdr-client/src/index";
import { EventError, EventHub, parseSubscribeArgs, type SubscribeSpec } from "./events";
import {
  ACCESS_LEVELS,
  type AccessLevel,
  CONTRACT,
  CONTRACT_STATUS,
  DEFAULT_ACCESS_LEVEL,
  ERROR_CODES,
  type McpErrorCode,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SURFACE_STATUS,
  TOOL_TABLE,
  type ToolSpec,
  UPSTREAM_GAPS,
} from "./model";
import {
  MUTATION_PLUGIN_CONTRACTS,
  type PluginId,
  READ_PLUGIN_CONTRACTS,
  resolvePluginSource,
  runPluginCli,
} from "./plugincli";
import type { ResolvedTarget } from "./session";

// --- Errors ------------------------------------------------------------------

export class ToolError extends Error {
  readonly code: McpErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

function invalidParams(message: string, details?: Record<string, unknown>): never {
  throw new ToolError("invalid_params", message, details);
}

// --- Context -----------------------------------------------------------------

export type PluginRunner = (
  pluginId: PluginId,
  args: string[],
  options: { socketPath: string; timeoutMs?: number | undefined },
) => ReturnType<typeof runPluginCli>;

export type PluginProber = (pluginId: string) => ReturnType<typeof resolvePluginSource>;

export interface ToolContext {
  /** Resolved herdr socket path (fixed at server start). */
  socketPath: string;
  /** Named session when resolved via `--session`/`HERDR_SESSION`. */
  sessionName: string | undefined;
  /** Resolved-via tag for capability reporting. */
  resolvedVia: ResolvedTarget["resolvedVia"];
  accessLevel: AccessLevel;
  /** Wall-clock budget for upstream calls (default 30s). */
  timeoutMs: number;
  runPlugin: PluginRunner;
  probePlugin: PluginProber;
  /** In-process event subscription hub (T4, #140); closed on server stop. */
  events: EventHub;
}

export function defaultToolContext(target: ResolvedTarget, accessLevel: AccessLevel): ToolContext {
  return {
    socketPath: target.socketPath,
    sessionName: target.sessionName,
    resolvedVia: target.resolvedVia,
    accessLevel,
    timeoutMs: 30_000,
    runPlugin: runPluginCli,
    probePlugin: resolvePluginSource,
    events: new EventHub({ socketPath: target.socketPath, timeoutMs: 30_000 }),
  };
}

// --- Herdr error mapping ------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isSocketFailure(err: unknown): boolean {
  if (err instanceof HerdrRpcError) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /timed out|socket closed|ECONNREFUSED|ENOENT|ECONNRESET|EPIPE/i.test(message);
}

/** Map a thrown upstream error to a contract ToolError. */
function mapUpstreamError(err: unknown, what: string): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof HerdrRpcError) {
    const code = err.code.toLowerCase();
    if (code.includes("not_found") || code.includes("unknown")) {
      return new ToolError("not_found", `${what}: ${err.message}`, { upstream: err.code });
    }
    if (code.includes("timeout")) {
      return new ToolError("session_unreachable", `${what}: ${err.message}`, {
        upstream: err.code,
      });
    }
    return new ToolError("internal", `${what}: ${err.message}`, { upstream: err.code });
  }
  if (isSocketFailure(err)) {
    return new ToolError("session_unreachable", `${what}: herdr socket unreachable`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  return new ToolError("internal", `${what}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Map hub EventError onto ToolError; pass through everything else. */
function mapEventError(err: unknown, what: string): ToolError {
  if (err instanceof EventError) {
    return new ToolError(err.code, `${what}: ${err.message}`, err.details);
  }
  return mapUpstreamError(err, what);
}

function callOptions(ctx: ToolContext): CallOptions {
  return { socketPath: ctx.socketPath, timeoutMs: ctx.timeoutMs };
}

async function liveSnapshot(ctx: ToolContext): Promise<SessionSnapshot> {
  try {
    return await sessionSnapshot(callOptions(ctx));
  } catch (err) {
    throw mapUpstreamError(err, "session.snapshot");
  }
}

// --- Identity -----------------------------------------------------------------

interface IdentityFields {
  pane_id?: string | undefined;
  workspace_id?: string | undefined;
  tab_id?: string | undefined;
  agent?: string | undefined;
  agent_session?: AgentInfo["agent_session"] | undefined;
  state_change_seq?: number | undefined;
}

/**
 * Build the contract `identity` echo: host + resolved herdr session +
 * whatever object identity the caller resolved live. Undefined fields
 * are omitted (never fabricated).
 */
export function identityBlock(
  ctx: ToolContext,
  snapshot: SessionSnapshot | undefined,
  fields: IdentityFields = {},
): Record<string, unknown> {
  const identity: Record<string, unknown> = { host: os.hostname() };
  const sessionName = snapshot?.session?.name ?? ctx.sessionName;
  if (sessionName !== undefined) identity.herdr_session = sessionName;
  if (fields.pane_id !== undefined) identity.pane_id = fields.pane_id;
  if (fields.workspace_id !== undefined) identity.workspace_id = fields.workspace_id;
  if (fields.tab_id !== undefined) identity.tab_id = fields.tab_id;
  if (fields.agent !== undefined) identity.agent = fields.agent;
  if (fields.agent_session !== undefined && fields.agent_session !== null) {
    const s = fields.agent_session;
    const ref: Record<string, unknown> = {};
    if (typeof s.agent === "string") ref.agent = s.agent;
    if (typeof s.kind === "string") ref.kind = s.kind;
    if (typeof s.value === "string") ref.value = s.value;
    if (Object.keys(ref).length > 0) identity.agent_session = ref;
  }
  if (fields.state_change_seq !== undefined) identity.state_change_seq = fields.state_change_seq;
  return identity;
}

function agentIdentityFields(agent: AgentInfo): IdentityFields {
  const record = agent as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof record[key] === "number" ? (record[key] as number) : undefined;
  return {
    pane_id: str("pane_id"),
    workspace_id: str("workspace_id"),
    tab_id: str("tab_id"),
    agent: typeof agent.agent === "string" ? agent.agent : str("agent"),
    agent_session: agent.agent_session ?? undefined,
    state_change_seq: num("state_change_seq"),
  };
}

// --- Stale-generation guards (read-side expectation checks) --------------------

interface ExpectArgs {
  expect_state_seq?: unknown;
  expect_agent_session?: unknown;
  expect_pane?: unknown;
}

function checkExpectations(agent: AgentInfo, args: ExpectArgs): void {
  const fields = agentIdentityFields(agent);
  if (args.expect_state_seq !== undefined) {
    if (typeof args.expect_state_seq !== "number" || !Number.isFinite(args.expect_state_seq)) {
      invalidParams("expect_state_seq must be a number");
    }
    if (fields.state_change_seq !== args.expect_state_seq) {
      throw new ToolError(
        "stale_generation",
        `state_change_seq mismatch: expected ${args.expect_state_seq}, live ${fields.state_change_seq ?? "unknown"}`,
        { expected: args.expect_state_seq, live: fields.state_change_seq ?? null },
      );
    }
  }
  if (args.expect_agent_session !== undefined) {
    if (typeof args.expect_agent_session !== "string") {
      invalidParams("expect_agent_session must be a string");
    }
    const live =
      typeof agent.agent_session?.value === "string" ? agent.agent_session.value : undefined;
    if (live !== args.expect_agent_session) {
      throw new ToolError(
        "stale_generation",
        `agent_session mismatch: expected ${args.expect_agent_session}, live ${live ?? "unknown"}`,
        { expected: args.expect_agent_session, live: live ?? null },
      );
    }
  }
  if (args.expect_pane !== undefined) {
    if (typeof args.expect_pane !== "string") invalidParams("expect_pane must be a string");
    if (fields.pane_id !== args.expect_pane) {
      throw new ToolError(
        "stale_generation",
        `pane identity mismatch: expected ${args.expect_pane}, live ${fields.pane_id ?? "unknown"}`,
        { expected: args.expect_pane, live: fields.pane_id ?? null },
      );
    }
  }
}

/** Resolve an agent target live and verify its pane is in the snapshot. */
async function resolveAgent(
  ctx: ToolContext,
  target: string,
  args: ExpectArgs,
): Promise<{ agent: AgentInfo; snapshot: SessionSnapshot; identity: Record<string, unknown> }> {
  const snapshot = await liveSnapshot(ctx);
  let agent: AgentInfo;
  try {
    agent = await agentGet(target, callOptions(ctx));
  } catch (err) {
    throw mapUpstreamError(err, `agent.get ${target}`);
  }
  const fields = agentIdentityFields(agent);
  // A resolved agent whose pane is absent from the live snapshot is a
  // stale/reused identity — refuse rather than echo it (ADR-0025 §4).
  const paneId = fields.pane_id;
  if (paneId !== undefined && Array.isArray(snapshot.panes) && snapshot.panes.length > 0) {
    const present = snapshot.panes.some((p) => p.pane_id === paneId);
    if (!present) {
      throw new ToolError(
        "not_found",
        `agent ${target} resolved to pane ${paneId} which is not present in the live session snapshot`,
        { target, pane_id: paneId },
      );
    }
  }
  checkExpectations(agent, args);
  return { agent, snapshot, identity: identityBlock(ctx, snapshot, fields) };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    invalidParams(`missing or invalid required argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalidParams(`argument ${key} must be a string`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidParams(`argument ${key} must be a number`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalidParams(`argument ${key} must be a boolean`);
  return value;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    invalidParams(`argument ${key} must be an array of strings`);
  }
  return value as string[];
}

// --- Plugin CLI helpers --------------------------------------------------------

/**
 * Map a sibling-CLI failure kind/message onto the contract error codes.
 * Specific kinds are checked before the generic `session`/`not_found`
 * substrings so e.g. `resume_session_mismatch` never degrades to
 * `session_unreachable`. Kinds with no dedicated contract code keep
 * their original value in `details.plugin_kind` — the precise sibling
 * kind (e.g. `requires_interactive_input`) is never lost.
 */
function mapPluginErrorKind(kind: string | undefined, message: string): McpErrorCode {
  const k = (kind ?? "").toLowerCase();
  const m = message.toLowerCase();
  if (k.includes("stale")) return "stale_generation";
  if (k.includes("requires_interactive_input") || k.includes("agent_blocked")) {
    // herdr has no structured dialog/approval response API (ADR-0019,
    // upstream herdrdev/herdr#6196): a blocked agent cannot accept
    // agent.prompt — an upstream capability gap, surfaced honestly.
    return "upstream_gap";
  }
  if (
    k.includes("unsupported") ||
    k.includes("provider_unknown") ||
    k.includes("worktree_unsupported") ||
    k.includes("busy")
  ) {
    return "unsupported";
  }
  if (
    k.includes("unsafe_agent_argument") ||
    k.includes("invalid") ||
    k.includes("usage") ||
    k.includes("required")
  ) {
    return "invalid_params";
  }
  if (k.includes("no_agent_session") || k.includes("mismatch")) {
    return "invalid_params";
  }
  if (
    k.includes("not_found") ||
    k.includes("no_pane_cwd") ||
    k.includes("missing") ||
    m.includes("not found")
  ) {
    return "not_found";
  }
  if (k.includes("not_a_repo") || k.includes("bare_repo") || k.includes("git_missing")) {
    return "unsupported";
  }
  if (k.includes("session") || k.includes("socket") || k.includes("unreachable")) {
    return "session_unreachable";
  }
  return "internal";
}

function childErrorEnvelope(stderr: string): {
  kind: string | undefined;
  message: string | undefined;
} {
  try {
    const parsed = JSON.parse(stderr.trim().split("\n").pop() ?? "") as Record<string, unknown>;
    const error = asRecord(parsed.error);
    return {
      kind: typeof error.kind === "string" ? error.kind : undefined,
      message: typeof error.message === "string" ? error.message : undefined,
    };
  } catch {
    return { kind: undefined, message: undefined };
  }
}

/**
 * Run a sibling plugin CLI command (read or mutation) and return its
 * JSON document.
 * Resolution failure → `plugin_unavailable`; non-zero exit → mapped
 * contract error with the child's `error.kind` preserved in details.
 */
async function pluginCommand(
  ctx: ToolContext,
  pluginId: PluginId,
  pluginContract: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const res = await ctx.runPlugin(pluginId, args, {
    socketPath: ctx.socketPath,
    timeoutMs: ctx.timeoutMs,
  });
  if (!res.ok) {
    throw new ToolError("plugin_unavailable", res.error, { plugin: pluginId });
  }
  const { source, result } = res;
  if (result.status !== 0 || result.json === null) {
    const child = childErrorEnvelope(result.stderr);
    const message =
      child.message ??
      `plugin CLI exited with status ${result.status ?? "unknown"} and no JSON document`;
    throw new ToolError(mapPluginErrorKind(child.kind, message), `${pluginId}: ${message}`, {
      plugin: pluginId,
      plugin_kind: child.kind ?? null,
      exit_status: result.status,
    });
  }
  const json = result.json;
  if (json.ok === false || json.error !== undefined) {
    const error = asRecord(json.error);
    const kind = typeof error.kind === "string" ? error.kind : undefined;
    const message = typeof error.message === "string" ? error.message : "plugin command failed";
    throw new ToolError(mapPluginErrorKind(kind, message), `${pluginId}: ${message}`, {
      plugin: pluginId,
      plugin_kind: kind ?? null,
    });
  }
  return {
    plugin: pluginId,
    plugin_contract: pluginContract,
    resolved_via: source.resolved_via,
    result: json,
  };
}

/** Resolve a pane's workspace/tab/cwd identity from the live snapshot. */
async function paneIdentity(
  ctx: ToolContext,
  snapshot: SessionSnapshot,
  paneId: string,
): Promise<Record<string, unknown>> {
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
  if (pane === undefined) {
    throw new ToolError("not_found", `pane not found in live session snapshot: ${paneId}`, {
      pane_id: paneId,
    });
  }
  const identity = identityBlock(ctx, snapshot, {
    pane_id: paneId,
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
  });
  if (typeof pane.cwd === "string") identity.cwd = pane.cwd;
  return identity;
}

// --- Mutation helpers (T3, #139) ----------------------------------------------

/**
 * `rebuildup.controls` provider permission modes (controls/v1 launch
 * table, ADR-0018). Mirrored locally — the MCP plugin consumes
 * controls only through its CLI contract and never imports plugin
 * internals (ADR-0025 §3).
 */
export const CONTROLS_PERMISSION_MODES = [
  "supervised",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export type ControlsPermissionMode = (typeof CONTROLS_PERMISSION_MODES)[number];

/** Ordered least→most permissive; used for the access-level cap. */
const PERMISSION_MODE_RANK: Record<ControlsPermissionMode, number> = {
  supervised: 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/** The highest provider permission mode each MCP access level may launch. */
const ACCESS_PERMISSION_CAP: Record<AccessLevel, ControlsPermissionMode> = {
  "read-only": "supervised", // unreachable: agent_start requires supervised+
  supervised: "supervised",
  full: "full-access",
};

/**
 * Record of one side effect a mutation performed, echoed in the tool
 * result so callers can see exactly which herdr API / sibling-plugin
 * CLI call ran (contract "副作用の可視性" — herdr stays the authority,
 * the summary never replaces it).
 */
export interface MutationEffect {
  surface: "herdr" | string;
  method: string;
  detail?: Record<string, unknown>;
}

function pluginCliEffect(
  pluginId: PluginId,
  command: string,
  detail?: Record<string, unknown>,
): MutationEffect {
  return {
    surface: pluginId,
    method: `cli ${command}`,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** `expect_*` MCP args → controls `--expect-*` CLI flags. */
function expectCliArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const pane = optionalString(args, "expect_pane");
  if (pane !== undefined) out.push("--expect-pane", pane);
  const seq = optionalNumber(args, "expect_state_seq");
  if (seq !== undefined) out.push("--expect-state-seq", String(seq));
  const session = optionalString(args, "expect_agent_session");
  if (session !== undefined) out.push("--expect-agent-session", session);
  return out;
}

/** String-array arg validated against herdr's agent status enum. */
function optionalStatusArray(
  args: Record<string, unknown>,
  key: string,
): AgentStatus[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    invalidParams(`argument ${key} must be an array of strings`);
  }
  for (const status of value as string[]) {
    if (!(AGENT_STATUSES as readonly string[]).includes(status)) {
      invalidParams(
        `argument ${key} must contain only ${AGENT_STATUSES.join("|")}, got: ${status}`,
      );
    }
  }
  return value as AgentStatus[];
}

/** Flatten `until`-style status arrays into repeated CLI flags. */
function statusCliArgs(flag: string, statuses: AgentStatus[] | undefined): string[] {
  const out: string[] = [];
  for (const status of statuses ?? []) out.push(flag, status);
  return out;
}

/**
 * Identity echo for a just-launched agent: resolve the agent now
 * occupying `paneId` from a fresh snapshot; fall back to pane-level
 * identity when the agent record is not yet visible (never fabricated
 * — missing agent fields are simply absent).
 */
async function launchedAgentIdentity(
  ctx: ToolContext,
  paneId: string,
): Promise<Record<string, unknown>> {
  const snapshot = await liveSnapshot(ctx);
  const agent = snapshot.agents?.[paneId];
  if (agent !== undefined) {
    const fields = agentIdentityFields(agent);
    // Snapshot agent entries are keyed by pane_id and may omit the
    // field itself; backfill from the key, then from the pane record.
    if (fields.pane_id === undefined) fields.pane_id = paneId;
    if (fields.workspace_id === undefined || fields.tab_id === undefined) {
      const pane = (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
      fields.workspace_id ??= pane?.workspace_id;
      fields.tab_id ??= pane?.tab_id;
    }
    return identityBlock(ctx, snapshot, fields);
  }
  return paneIdentity(ctx, snapshot, paneId);
}

// --- Capability ----------------------------------------------------------------

/** Per-plugin availability for `herdr_capability` / CLI `capability`. */
export async function pluginAvailability(
  ctx: Pick<ToolContext, "probePlugin">,
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (const [pluginId, contract] of [
    ...Object.entries(READ_PLUGIN_CONTRACTS),
    ...Object.entries(MUTATION_PLUGIN_CONTRACTS),
  ] as Array<[string, string]>) {
    const probed = await ctx.probePlugin(pluginId);
    if (probed.ok) {
      entries.push({
        plugin: pluginId,
        contract,
        available: true,
        resolved_via: probed.source.resolved_via,
      });
    } else {
      entries.push({ plugin: pluginId, contract, available: false, error: probed.error });
    }
  }
  return entries;
}

// --- Tool definitions ------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  spec: ToolSpec;
}

const EXPECT_SCHEMA = {
  type: "object",
  properties: {
    expect_state_seq: { type: "number", description: "refuse with stale_generation on mismatch" },
    expect_agent_session: {
      type: "string",
      description: "expected live agent_session.value",
    },
    expect_pane: { type: "string", description: "expected live pane_id" },
  },
} as const;

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const AGENT_TARGET_SCHEMA = schema(
  {
    target: { type: "string", description: "herdr agent target (pane id or agent name)" },
    ...EXPECT_SCHEMA.properties,
  },
  ["target"],
);

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "herdr_capability",
    description:
      "Contract version, negotiated access level, resolved session target, tool table, and sibling-plugin availability for herdr-plugins.mcp/v1.",
    inputSchema: schema({}),
    spec: TOOL_TABLE.find((t) => t.name === "herdr_capability") as ToolSpec,
  },
  {
    name: "session_snapshot",
    description: "Live herdr session.snapshot: workspaces, tabs, panes, agents.",
    inputSchema: schema({}),
    spec: TOOL_TABLE.find((t) => t.name === "session_snapshot") as ToolSpec,
  },
  {
    name: "agent_list",
    description: "List agents in the resolved herdr session (agent.list).",
    inputSchema: schema({}),
    spec: TOOL_TABLE.find((t) => t.name === "agent_list") as ToolSpec,
  },
  {
    name: "agent_get",
    description:
      "Resolve an agent target to its live AgentInfo (pane/workspace/tab identity, status, state_change_seq, agent_session). Optional expect_* args refuse stale identities with stale_generation.",
    inputSchema: AGENT_TARGET_SCHEMA,
    spec: TOOL_TABLE.find((t) => t.name === "agent_get") as ToolSpec,
  },
  {
    name: "agent_read",
    description:
      "Bounded agent scrollback read (agent.read). Structured history is conversations_search/show.",
    inputSchema: schema(
      {
        target: { type: "string", description: "herdr agent target (pane id or agent name)" },
        source: {
          type: "string",
          enum: ["visible", "recent", "recent_unwrapped", "detection"],
          description: "read source (default recent)",
        },
        lines: { type: "number", description: "max lines" },
        format: { type: "string", enum: ["text", "ansi"], description: "default text" },
        strip_ansi: { type: "boolean", description: "strip ANSI escapes (default true)" },
        ...EXPECT_SCHEMA.properties,
      },
      ["target"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "agent_read") as ToolSpec,
  },
  {
    name: "workspace_list",
    description: "List workspaces in the resolved herdr session (from session.snapshot).",
    inputSchema: schema({}),
    spec: TOOL_TABLE.find((t) => t.name === "workspace_list") as ToolSpec,
  },
  {
    name: "pane_list",
    description: "List panes with their agent state (flattened session.snapshot).",
    inputSchema: schema({}),
    spec: TOOL_TABLE.find((t) => t.name === "pane_list") as ToolSpec,
  },
  {
    name: "conversations_search",
    description:
      "Search the rebuildup.conversations transcript index (substring match over event fields; paged via cursor).",
    inputSchema: schema(
      {
        query: { type: "string", description: "case-insensitive substring query" },
        pane: { type: "string", description: "filter by pane_id" },
        session_id: { type: "string", description: "filter by provider session id" },
        provider: { type: "string", description: "filter by provider id" },
        type: { type: "string", description: "filter by event type" },
        limit: { type: "number", description: "max results per page" },
        cursor: { type: "string", description: "opaque next_cursor from a previous page" },
      },
      ["query"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "conversations_search") as ToolSpec,
  },
  {
    name: "conversations_show",
    description:
      "Show indexed conversation events matching a ref (event_id / tool_use_id / session id) via rebuildup.conversations show.",
    inputSchema: schema(
      {
        ref: { type: "string", description: "event id, tool_use_id, or session reference" },
        pane: { type: "string", description: "filter by pane_id" },
        session_id: { type: "string", description: "filter by provider session id" },
        provider: { type: "string", description: "filter by provider id" },
      },
      ["ref"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "conversations_show") as ToolSpec,
  },
  {
    name: "git_status",
    description: "Git status for the repository containing a pane's cwd (rebuildup.git status).",
    inputSchema: schema({ pane_id: { type: "string" } }, ["pane_id"]),
    spec: TOOL_TABLE.find((t) => t.name === "git_status") as ToolSpec,
  },
  {
    name: "git_files",
    description:
      "Changed-file list for the repository containing a pane's cwd (rebuildup.git files).",
    inputSchema: schema(
      {
        pane_id: { type: "string" },
        path: { type: "array", items: { type: "string" }, description: "pathspec filters" },
      },
      ["pane_id"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "git_files") as ToolSpec,
  },
  {
    name: "git_log",
    description: "Git log for the repository containing a pane's cwd (rebuildup.git log).",
    inputSchema: schema(
      {
        pane_id: { type: "string" },
        limit: { type: "number" },
        skip: { type: "number" },
        all: { type: "boolean" },
        first_parent: { type: "boolean" },
        author: { type: "string" },
        grep: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        path: { type: "array", items: { type: "string" } },
      },
      ["pane_id"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "git_log") as ToolSpec,
  },
  {
    name: "projects_list",
    description: "List registered projects (rebuildup.projects list).",
    inputSchema: schema({ all: { type: "boolean", description: "include archived" } }),
    spec: TOOL_TABLE.find((t) => t.name === "projects_list") as ToolSpec,
  },
  {
    name: "usage_report",
    description:
      "Provider-reported token usage totals over the rebuildup.conversations index (rebuildup.usage usage). Read-only; does not refresh the index.",
    inputSchema: schema(
      {
        from: { type: "string", description: "ISO timestamp window start" },
        to: { type: "string", description: "ISO timestamp window end" },
        pane: { type: "string", description: "filter by pane_id" },
        session_id: { type: "string", description: "filter by provider session id" },
        provider: { type: "string", description: "filter by provider id" },
      },
      [],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "usage_report") as ToolSpec,
  },
  // --- Mutations (T3, #139) ---------------------------------------------------
  {
    name: "agent_prompt",
    description:
      "Submit prompt text to an agent (rebuildup.controls send → agent.prompt; blocked agents are refused upstream_gap/requires_interactive_input). Optional wait_until/timeout_ms observe post-submit status. expect_* args pin the agent generation; stale targets fail stale_generation before any input is sent.",
    inputSchema: schema(
      {
        target: { type: "string", description: "herdr agent target (pane id or agent name)" },
        text: {
          type: "string",
          description: "prompt text (must not start with '--')",
        },
        wait: { type: "boolean", description: "wait for a post-submit status (controls --wait)" },
        wait_until: {
          type: "array",
          items: { type: "string", enum: [...AGENT_STATUSES] },
          description: "statuses to wait for after submission",
        },
        timeout_ms: { type: "number", description: "wait timeout in ms" },
        ...EXPECT_SCHEMA.properties,
      },
      ["target", "text"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "agent_prompt") as ToolSpec,
  },
  {
    name: "agent_wait",
    description:
      "Block until an agent reaches one of until[] (default upstream idle/done/blocked) or timeout_ms elapses (rebuildup.controls wait → agent.wait). Read-level blocking observation; no mutation.",
    inputSchema: schema(
      {
        target: { type: "string", description: "herdr agent target (pane id or agent name)" },
        until: {
          type: "array",
          items: { type: "string", enum: [...AGENT_STATUSES] },
          description: "statuses to wait for",
        },
        timeout_ms: { type: "number", description: "wait timeout in ms" },
        ...EXPECT_SCHEMA.properties,
      },
      ["target"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "agent_wait") as ToolSpec,
  },
  {
    name: "agent_interrupt",
    description:
      "PTY-level key injection into an agent's terminal (rebuildup.controls interrupt → agent.send_keys; default esc). NOT a structured interrupt API — effect depends on the provider's keybindings.",
    inputSchema: schema(
      {
        target: { type: "string", description: "herdr agent target (pane id or agent name)" },
        keys: {
          type: "array",
          items: { type: "string" },
          description: 'key names to inject (e.g. ["esc"], ["ctrl+c"]); default ["esc"]',
        },
        ...EXPECT_SCHEMA.properties,
      },
      ["target"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "agent_interrupt") as ToolSpec,
  },
  {
    name: "agent_start",
    description:
      "Launch an agent in an existing shell pane (rebuildup.controls start → agent.start with the per-provider launch table). permission_mode is capped by the negotiated access level: supervised allows only 'supervised'; full allows all modes. extra_args are denylist-screened provider passthrough (no --unsafe-args equivalent).",
    inputSchema: schema(
      {
        pane_id: { type: "string", description: "existing pane at an interactive shell prompt" },
        agent: { type: "string", description: "provider agent kind (e.g. claude, codex)" },
        name: { type: "string", description: "agent name ([a-z][a-z0-9_-]{0,31})" },
        model: { type: "string" },
        reasoning: { type: "string" },
        permission_mode: {
          type: "string",
          enum: [...CONTROLS_PERMISSION_MODES],
          description: "provider permission mode; capped by access level",
        },
        resume: { type: "string", description: "raw provider session value to resume" },
        resume_from: {
          type: "string",
          description: "agent target whose reported agent_session to resume",
        },
        extra_args: {
          type: "array",
          items: { type: "string" },
          description: "provider CLI arg passthrough (--arg; denylist enforced, no unsafe opt-out)",
        },
        timeout_ms: { type: "number", description: "startup readiness timeout (3000,300000]" },
        wait: { type: "boolean", description: "post-launch agent.wait observation" },
        wait_until: {
          type: "array",
          items: { type: "string", enum: [...AGENT_STATUSES] },
        },
        wait_timeout_ms: { type: "number" },
        ...EXPECT_SCHEMA.properties,
      },
      ["pane_id", "agent"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "agent_start") as ToolSpec,
  },
  {
    name: "workspace_create",
    description:
      "Create a dedicated workspace+tab+root pane (herdr workspace.create). No env passthrough in v1 — pane environment is herdr's authority and tool arguments must never carry secrets.",
    inputSchema: schema({
      cwd: { type: "string", description: "working directory for the root pane" },
      label: { type: "string", description: "workspace label" },
      focus: {
        type: "boolean",
        description: "focus the new workspace (herdr default applies when omitted)",
      },
    }),
    spec: TOOL_TABLE.find((t) => t.name === "workspace_create") as ToolSpec,
  },
  {
    name: "handoff_invoke",
    description:
      "Invoke rebuildup.handoff execute/delegate/merge-back (ADR-0021 boundaries; same-session only, --remote is not exposed in v1). The handoff plugin owns record state and staleness gates; this tool only forwards the contract CLI call.",
    inputSchema: schema(
      {
        operation: {
          type: "string",
          enum: ["execute", "delegate", "merge-back"],
          description: "handoff operation",
        },
        id: {
          type: "string",
          description:
            "handoff id (execute) / parent handoff id (delegate) / child handoff id (merge-back)",
        },
        // execute/delegate target selection
        target_pane: { type: "string" },
        target_workspace: { type: "string" },
        new_workspace: { type: "boolean" },
        worktree: {
          type: "boolean",
          description: "execute/delegate: herdr worktree.create target",
        },
        worktree_branch: { type: "string" },
        worktree_base: { type: "string" },
        // launch hints
        provider: { type: "string", description: "opaque provider/route hint" },
        model: { type: "string" },
        strategy: { type: "string", enum: ["native_resume", "portable_context"] },
        task: { type: "string", description: "delegate/merge-back task text" },
        // payload flags (delegate/merge-back)
        note: { type: "string" },
        requirement: { type: "array", items: { type: "string" } },
        conversation: { type: "array", items: { type: "string" } },
        checkpoint: { type: "array", items: { type: "string" } },
        external: { type: "array", items: { type: "string" } },
        handoff: { type: "array", items: { type: "string" } },
        link_note: { type: "string" },
        // execution control
        wait_ms: { type: "number" },
        cleanup_on_failure: { type: "boolean" },
        no_execute: { type: "boolean", description: "delegate/merge-back: record intent only" },
        dry_run: { type: "boolean", description: "preview without mutating" },
      },
      ["operation", "id"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "handoff_invoke") as ToolSpec,
  },
  // --- Events (T4, #140) -----------------------------------------------------
  {
    name: "events_subscribe",
    description:
      "Subscribe to herdr session events (events.subscribe surface) as an in-process MCP subscription. types[] selects subscription types (default pane.agent_status_changed); filters pane_id/workspace_id/agent_status/agent narrow delivery client-side; pane-parameterized types are expanded across the resolved pane set. Returns subscription_id, covered pane_ids, an initial session.snapshot baseline, and the reconnect policy. Read-only observation; events are pulled via events_poll/events_wait — a socket drop is always reported as gap+resync notices, never as 'no events'.",
    inputSchema: schema(
      {
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "subscription types (e.g. pane.agent_status_changed, pane.output_matched, pane.scroll_changed, workspace.created, pane.closed, layout.updated); default [pane.agent_status_changed]",
        },
        pane_id: { type: "string", description: "restrict to one pane (must exist live)" },
        workspace_id: {
          type: "string",
          description: "restrict to panes in one workspace (must exist live)",
        },
        agent_status: {
          type: "string",
          enum: [...AGENT_STATUSES],
          description: "client-side + upstream filter on agent_status",
        },
        agent: {
          type: "string",
          description: "client-side filter on event agent/display_agent",
        },
        match: {
          type: "object",
          description: "required with pane.output_matched: {type: substring|regex, value}",
          properties: {
            type: { type: "string", enum: ["substring", "regex"] },
            value: { type: "string" },
          },
          required: ["type", "value"],
          additionalProperties: false,
        },
        source: {
          type: "string",
          enum: ["visible", "recent", "recent_unwrapped", "detection"],
          description: "pane.output_matched read source (default recent)",
        },
        lines: { type: "number", description: "pane.output_matched read window" },
        strip_ansi: {
          type: "boolean",
          description: "pane.output_matched strip ANSI (default true upstream)",
        },
      },
      [],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "events_subscribe") as ToolSpec,
  },
  {
    name: "events_poll",
    description:
      "Non-blocking read of a subscription's buffered events/notices newer than cursor (default 0 = whole retained buffer, capped at 1000 items). Returns events[], gap/resync notices[], next_cursor, status, reconnects.",
    inputSchema: schema(
      {
        subscription_id: { type: "string" },
        cursor: { type: "number", description: "seq cursor from a previous next_cursor" },
      },
      ["subscription_id"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "events_poll") as ToolSpec,
  },
  {
    name: "events_wait",
    description:
      "Block until an event newer than cursor arrives on the subscription (or timeout_ms, default 30000, cap 120000). types[] optionally narrows matching event names. Returns the same shape as events_poll plus timed_out; gap/resync notices never satisfy the wait but are returned.",
    inputSchema: schema(
      {
        subscription_id: { type: "string" },
        cursor: { type: "number" },
        types: {
          type: "array",
          items: { type: "string" },
          description: "canonical event names to wait for",
        },
        timeout_ms: { type: "number" },
      },
      ["subscription_id"],
    ),
    spec: TOOL_TABLE.find((t) => t.name === "events_wait") as ToolSpec,
  },
  {
    name: "events_unsubscribe",
    description:
      "Tear down an event subscription; buffered items are discarded (counted in discarded_items).",
    inputSchema: schema({ subscription_id: { type: "string" } }, ["subscription_id"]),
    spec: TOOL_TABLE.find((t) => t.name === "events_unsubscribe") as ToolSpec,
  },
];

// Planned tools still appear in tools/list (contract "unsupported"
// semantics) but have no handler until their ticket lands.
const PLANNED_DEFINITIONS: ToolDefinition[] = TOOL_TABLE.filter(
  (spec) => !TOOL_DEFINITIONS.some((d) => d.name === spec.name),
).map((spec) => ({
  name: spec.name,
  description: `${spec.name} — planned (${spec.status}); lands in a later ticket of #30.`,
  inputSchema: schema({}),
  spec,
}));

export const ALL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  ...TOOL_DEFINITIONS,
  ...PLANNED_DEFINITIONS,
];

// --- Handlers --------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

const HANDLERS: Record<string, ToolHandler> = {
  async herdr_capability(_args, ctx) {
    return {
      contract: CONTRACT,
      contract_status: CONTRACT_STATUS,
      surfaces: SURFACE_STATUS,
      plugin: PLUGIN_ID,
      version: PLUGIN_VERSION,
      access_level: ctx.accessLevel,
      access_levels: { levels: [...ACCESS_LEVELS], default: DEFAULT_ACCESS_LEVEL },
      resolved_session: {
        socket: ctx.socketPath,
        session: ctx.sessionName ?? null,
        resolved_via: ctx.resolvedVia,
      },
      tools: TOOL_TABLE.map((t) => ({
        name: t.name,
        access: t.access,
        read_only: t.readOnly,
        status: t.status,
        backs_onto: t.backs_onto,
      })),
      plugins: await pluginAvailability(ctx),
      error_codes: [...ERROR_CODES],
      upstream_gaps: UPSTREAM_GAPS,
      remote: {
        status: "excluded_v1",
        tracking: "herdrdev/herdr#6199",
        note: "no inbound HTTP/OAuth in herdr; local stdio only",
      },
    };
  },

  async session_snapshot(_args, ctx) {
    const snapshot = await liveSnapshot(ctx);
    return {
      snapshot,
      identity: identityBlock(ctx, snapshot),
    };
  },

  async agent_list(_args, ctx) {
    const snapshot = await liveSnapshot(ctx);
    let list: unknown;
    try {
      list = await agentList(callOptions(ctx));
    } catch (err) {
      throw mapUpstreamError(err, "agent.list");
    }
    return { agents: asRecord(list).agents ?? [], identity: identityBlock(ctx, snapshot) };
  },

  async agent_get(args, ctx) {
    const target = requireString(args, "target");
    const { agent, identity } = await resolveAgent(ctx, target, args);
    return { agent, identity };
  },

  async agent_read(args, ctx) {
    const target = requireString(args, "target");
    const source = optionalString(args, "source") ?? "recent";
    if (!["visible", "recent", "recent_unwrapped", "detection"].includes(source)) {
      invalidParams(`invalid source: ${source}`);
    }
    const format = optionalString(args, "format") ?? "text";
    if (format !== "text" && format !== "ansi") invalidParams(`invalid format: ${format}`);
    const lines = optionalNumber(args, "lines");
    const stripAnsi = optionalBoolean(args, "strip_ansi") ?? true;
    const { identity } = await resolveAgent(ctx, target, args);
    let read: AgentReadResult;
    try {
      read = await agentRead(
        target,
        {
          source: source as "visible" | "recent" | "recent_unwrapped" | "detection",
          lines,
          format,
          stripAnsi,
        },
        callOptions(ctx),
      );
    } catch (err) {
      throw mapUpstreamError(err, `agent.read ${target}`);
    }
    return { read, identity };
  },

  async workspace_list(_args, ctx) {
    const snapshot = await liveSnapshot(ctx);
    return {
      workspaces: snapshot.workspaces ?? [],
      identity: identityBlock(ctx, snapshot),
    };
  },

  async pane_list(_args, ctx) {
    const snapshot = await liveSnapshot(ctx);
    return {
      panes: paneAgentEntries(snapshot).map(({ pane, agent }) => {
        // The wire carries agent_status on the pane itself; the
        // normalized agents map may have no entry for agent-less panes.
        const paneRecord = pane as Record<string, unknown>;
        const paneStatus =
          typeof paneRecord.agent_status === "string" ? paneRecord.agent_status : undefined;
        const paneSeq =
          typeof paneRecord.state_change_seq === "number" ? paneRecord.state_change_seq : undefined;
        return {
          ...pane,
          agent_status: agent.agent_status ?? paneStatus ?? null,
          state_change_seq: agent.state_change_seq ?? paneSeq ?? null,
          agent_session: agent.agent_session ?? null,
        };
      }),
      identity: identityBlock(ctx, snapshot),
    };
  },

  async conversations_search(args, ctx) {
    const query = requireString(args, "query");
    const cliArgs = ["search", query];
    const pane = optionalString(args, "pane");
    const sessionId = optionalString(args, "session_id");
    const provider = optionalString(args, "provider");
    const type = optionalString(args, "type");
    const limit = optionalNumber(args, "limit");
    const cursor = optionalString(args, "cursor");
    if (pane !== undefined) cliArgs.push("--pane", pane);
    if (sessionId !== undefined) cliArgs.push("--session-id", sessionId);
    if (provider !== undefined) cliArgs.push("--provider", provider);
    if (type !== undefined) cliArgs.push("--type", type);
    if (limit !== undefined) cliArgs.push("--limit", String(Math.floor(limit)));
    if (cursor !== undefined) cliArgs.push("--cursor", cursor);
    return pluginCommand(
      ctx,
      "rebuildup.conversations",
      READ_PLUGIN_CONTRACTS["rebuildup.conversations"],
      cliArgs,
    );
  },

  async conversations_show(args, ctx) {
    const ref = requireString(args, "ref");
    const cliArgs = ["show", ref];
    const pane = optionalString(args, "pane");
    const sessionId = optionalString(args, "session_id");
    const provider = optionalString(args, "provider");
    if (pane !== undefined) cliArgs.push("--pane", pane);
    if (sessionId !== undefined) cliArgs.push("--session-id", sessionId);
    if (provider !== undefined) cliArgs.push("--provider", provider);
    return pluginCommand(
      ctx,
      "rebuildup.conversations",
      READ_PLUGIN_CONTRACTS["rebuildup.conversations"],
      cliArgs,
    );
  },

  async git_status(args, ctx) {
    const paneId = requireString(args, "pane_id");
    const snapshot = await liveSnapshot(ctx);
    const identity = await paneIdentity(ctx, snapshot, paneId);
    const out = await pluginCommand(ctx, "rebuildup.git", READ_PLUGIN_CONTRACTS["rebuildup.git"], [
      "status",
      paneId,
    ]);
    return { ...out, identity };
  },

  async git_files(args, ctx) {
    const paneId = requireString(args, "pane_id");
    const paths = optionalStringArray(args, "path");
    const snapshot = await liveSnapshot(ctx);
    const identity = await paneIdentity(ctx, snapshot, paneId);
    const cliArgs = ["files", paneId];
    for (const p of paths ?? []) cliArgs.push("--path", p);
    const out = await pluginCommand(
      ctx,
      "rebuildup.git",
      READ_PLUGIN_CONTRACTS["rebuildup.git"],
      cliArgs,
    );
    return { ...out, identity };
  },

  async git_log(args, ctx) {
    const paneId = requireString(args, "pane_id");
    const snapshot = await liveSnapshot(ctx);
    const identity = await paneIdentity(ctx, snapshot, paneId);
    const cliArgs = ["log", paneId];
    const limit = optionalNumber(args, "limit");
    const skip = optionalNumber(args, "skip");
    const all = optionalBoolean(args, "all");
    const firstParent = optionalBoolean(args, "first_parent");
    const author = optionalString(args, "author");
    const grep = optionalString(args, "grep");
    const since = optionalString(args, "since");
    const until = optionalString(args, "until");
    const paths = optionalStringArray(args, "path");
    if (limit !== undefined) cliArgs.push("--limit", String(Math.floor(limit)));
    if (skip !== undefined) cliArgs.push("--skip", String(Math.floor(skip)));
    if (all === true) cliArgs.push("--all");
    if (firstParent === true) cliArgs.push("--first-parent");
    if (author !== undefined) cliArgs.push("--author", author);
    if (grep !== undefined) cliArgs.push("--grep", grep);
    if (since !== undefined) cliArgs.push("--since", since);
    if (until !== undefined) cliArgs.push("--until", until);
    for (const p of paths ?? []) cliArgs.push("--path", p);
    const out = await pluginCommand(
      ctx,
      "rebuildup.git",
      READ_PLUGIN_CONTRACTS["rebuildup.git"],
      cliArgs,
    );
    return { ...out, identity };
  },

  async projects_list(args, ctx) {
    const cliArgs = ["list"];
    if (optionalBoolean(args, "all") === true) cliArgs.push("--all");
    return pluginCommand(
      ctx,
      "rebuildup.projects",
      READ_PLUGIN_CONTRACTS["rebuildup.projects"],
      cliArgs,
    );
  },

  async usage_report(args, ctx) {
    const cliArgs = ["usage"];
    const from = optionalString(args, "from");
    const to = optionalString(args, "to");
    const pane = optionalString(args, "pane");
    const sessionId = optionalString(args, "session_id");
    const provider = optionalString(args, "provider");
    if (from !== undefined) cliArgs.push("--from", from);
    if (to !== undefined) cliArgs.push("--to", to);
    if (pane !== undefined) cliArgs.push("--pane", pane);
    if (sessionId !== undefined) cliArgs.push("--session-id", sessionId);
    if (provider !== undefined) cliArgs.push("--provider", provider);
    // Read-only surface: never pass --refresh (index mutation stays with
    // the conversations plugin's own commands).
    return pluginCommand(ctx, "rebuildup.usage", READ_PLUGIN_CONTRACTS["rebuildup.usage"], cliArgs);
  },

  // --- Mutation handlers (T3, #139) -------------------------------------------
  //
  // Every mutation handler: (1) is gated by TOOL_TABLE access level in
  // callTool before dispatch; (2) resolves the target live and applies
  // expect_* stale-generation guards BEFORE any side effect; (3) echoes
  // the contract identity block; (4) reports the executed herdr API /
  // sibling CLI call in `effects`.

  async agent_prompt(args, ctx) {
    const target = requireString(args, "target");
    const text = requireString(args, "text");
    // controls parses `--*` argv as flags; prompt text must be a
    // positional, so a leading-dash text would be silently re-parsed.
    if (text.startsWith("--")) {
      invalidParams("text must not start with '--' (controls CLI flag syntax)");
    }
    const wait = optionalBoolean(args, "wait");
    const waitUntil = optionalStatusArray(args, "wait_until");
    const timeoutMs = optionalNumber(args, "timeout_ms");
    // Resolve + generation-guard first: stale/reused identities are
    // refused before the controls CLI (and its agent.prompt) ever runs.
    const { identity } = await resolveAgent(ctx, target, args);
    const cliArgs = ["send", target, text];
    if (wait === true) cliArgs.push("--wait");
    cliArgs.push(...statusCliArgs("--wait-until", waitUntil));
    if (timeoutMs !== undefined) cliArgs.push("--timeout-ms", String(timeoutMs));
    cliArgs.push(...expectCliArgs(args));
    const out = await pluginCommand(
      ctx,
      "rebuildup.controls",
      MUTATION_PLUGIN_CONTRACTS["rebuildup.controls"],
      cliArgs,
    );
    return {
      ...out,
      identity,
      effects: [
        pluginCliEffect("rebuildup.controls", "send", {
          target,
          waited: wait === true || waitUntil !== undefined || timeoutMs !== undefined,
        }),
      ],
    };
  },

  async agent_wait(args, ctx) {
    const target = requireString(args, "target");
    const until = optionalStatusArray(args, "until");
    const timeoutMs = optionalNumber(args, "timeout_ms");
    const { identity } = await resolveAgent(ctx, target, args);
    const cliArgs = ["wait", target];
    cliArgs.push(...statusCliArgs("--until", until));
    if (timeoutMs !== undefined) cliArgs.push("--timeout-ms", String(timeoutMs));
    cliArgs.push(...expectCliArgs(args));
    const out = await pluginCommand(
      ctx,
      "rebuildup.controls",
      MUTATION_PLUGIN_CONTRACTS["rebuildup.controls"],
      cliArgs,
    );
    return {
      ...out,
      identity,
      effects: [pluginCliEffect("rebuildup.controls", "wait", { target })],
    };
  },

  async agent_interrupt(args, ctx) {
    const target = requireString(args, "target");
    const keys = optionalStringArray(args, "keys");
    const { identity } = await resolveAgent(ctx, target, args);
    const cliArgs = ["interrupt", target];
    for (const key of keys ?? []) cliArgs.push("--key", key);
    cliArgs.push(...expectCliArgs(args));
    const out = await pluginCommand(
      ctx,
      "rebuildup.controls",
      MUTATION_PLUGIN_CONTRACTS["rebuildup.controls"],
      cliArgs,
    );
    return {
      ...out,
      identity,
      effects: [
        pluginCliEffect("rebuildup.controls", "interrupt", {
          target,
          pty_level: true,
          keys: keys ?? ["esc"],
        }),
      ],
    };
  },

  async agent_start(args, ctx) {
    const paneId = requireString(args, "pane_id");
    const kind = requireString(args, "agent");
    const name = optionalString(args, "name");
    const model = optionalString(args, "model");
    const reasoning = optionalString(args, "reasoning");
    const permissionModeRaw = optionalString(args, "permission_mode");
    const resume = optionalString(args, "resume");
    const resumeFrom = optionalString(args, "resume_from");
    const extraArgs = optionalStringArray(args, "extra_args");
    const timeoutMs = optionalNumber(args, "timeout_ms");
    const wait = optionalBoolean(args, "wait");
    const waitUntil = optionalStatusArray(args, "wait_until");
    const waitTimeoutMs = optionalNumber(args, "wait_timeout_ms");

    if (resume !== undefined && resumeFrom !== undefined) {
      invalidParams("agent_start accepts at most one of resume / resume_from");
    }
    let permissionMode: ControlsPermissionMode | undefined;
    if (permissionModeRaw !== undefined) {
      if (!(CONTROLS_PERMISSION_MODES as readonly string[]).includes(permissionModeRaw)) {
        invalidParams(
          `permission_mode must be one of ${CONTROLS_PERMISSION_MODES.join("|")}, got: ${permissionModeRaw}`,
        );
      }
      permissionMode = permissionModeRaw as ControlsPermissionMode;
    }

    // Access-level permission cap (ADR-0025 §2, issue #139): an agent
    // MCP starts must never run with more provider permission than the
    // negotiated level. `supervised` pins the lowest mode (and refuses
    // higher requests); `full` passes the caller's choice through.
    // Evaluated before any socket call so over-cap requests fail
    // capability_denied without touching the session.
    const cap = ACCESS_PERMISSION_CAP[ctx.accessLevel];
    let effectiveMode: ControlsPermissionMode | undefined;
    if (permissionMode !== undefined) {
      if (PERMISSION_MODE_RANK[permissionMode] > PERMISSION_MODE_RANK[cap]) {
        throw new ToolError(
          "capability_denied",
          `permission_mode '${permissionMode}' exceeds the '${ctx.accessLevel}' access level (cap: '${cap}')`,
          {
            tool: "agent_start",
            requested: permissionMode,
            access_level: ctx.accessLevel,
            cap,
          },
        );
      }
      effectiveMode = permissionMode;
    } else if (ctx.accessLevel !== "full") {
      // No explicit mode: still pin the cap so the provider default can
      // never silently exceed the negotiated level.
      effectiveMode = cap;
    }

    // The pane must exist in the live snapshot before anything is
    // launched — a stale/reused pane id is refused, never started on.
    const snapshot = await liveSnapshot(ctx);
    const paneIdent = await paneIdentity(ctx, snapshot, paneId);

    const cliArgs = ["start", paneId, "--agent", kind];
    if (name !== undefined) cliArgs.push("--name", name);
    if (model !== undefined) cliArgs.push("--model", model);
    if (reasoning !== undefined) cliArgs.push("--reasoning", reasoning);
    if (effectiveMode !== undefined) cliArgs.push("--permission-mode", effectiveMode);
    if (resume !== undefined) cliArgs.push("--resume", resume);
    if (resumeFrom !== undefined) cliArgs.push("--resume-from", resumeFrom);
    for (const arg of extraArgs ?? []) cliArgs.push("--arg", arg);
    if (timeoutMs !== undefined) cliArgs.push("--timeout-ms", String(timeoutMs));
    if (wait === true) cliArgs.push("--wait");
    cliArgs.push(...statusCliArgs("--wait-until", waitUntil));
    if (waitTimeoutMs !== undefined) cliArgs.push("--wait-timeout-ms", String(waitTimeoutMs));
    cliArgs.push(...expectCliArgs(args));

    const out = await pluginCommand(
      ctx,
      "rebuildup.controls",
      MUTATION_PLUGIN_CONTRACTS["rebuildup.controls"],
      cliArgs,
    );
    const identity = await launchedAgentIdentity(ctx, paneId);
    return {
      ...out,
      identity,
      target_pane: paneIdent,
      effects: [
        pluginCliEffect("rebuildup.controls", "start", {
          pane_id: paneId,
          agent: kind,
          permission_mode: effectiveMode ?? null,
          permission_mode_capped: permissionMode !== effectiveMode,
        }),
      ],
    };
  },

  async workspace_create(args, ctx) {
    const cwd = optionalString(args, "cwd");
    const label = optionalString(args, "label");
    const focus = optionalBoolean(args, "focus");
    const params: Parameters<typeof workspaceCreate>[0] = {};
    if (cwd !== undefined) params.cwd = cwd;
    if (label !== undefined) params.label = label;
    if (focus !== undefined) params.focus = focus;
    let created: Awaited<ReturnType<typeof workspaceCreate>>;
    try {
      created = await workspaceCreate(params, callOptions(ctx));
    } catch (err) {
      throw mapUpstreamError(err, "workspace.create");
    }
    const snapshot = await liveSnapshot(ctx);
    const ws = created.workspace as Record<string, unknown>;
    const tab = created.tab as Record<string, unknown>;
    const rootPane = created.root_pane as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const identity = identityBlock(ctx, snapshot, {
      workspace_id: str(ws.workspace_id),
      tab_id: str(tab.tab_id),
      pane_id: str(rootPane.pane_id),
    });
    return {
      created: {
        workspace: created.workspace,
        tab: created.tab,
        root_pane: created.root_pane,
      },
      identity,
      effects: [
        {
          surface: "herdr",
          method: "workspace.create",
          detail: {
            cwd: cwd ?? null,
            label: label ?? null,
            focus: focus ?? null,
          },
        },
      ],
    };
  },

  async handoff_invoke(args, ctx) {
    const operation = requireString(args, "operation");
    if (!["execute", "delegate", "merge-back"].includes(operation)) {
      invalidParams(`operation must be execute|delegate|merge-back, got: ${operation}`);
    }
    const id = requireString(args, "id");

    // Per-operation flag allowlist → handoff CLI flags. Anything the
    // caller supplies outside the operation's surface is rejected
    // rather than silently dropped (honest params, no fabricated run).
    const OP_SPECS: Record<
      string,
      {
        value: Record<string, string>;
        bool: Record<string, string>;
        array: Record<string, string>;
        number: Record<string, string>;
      }
    > = {
      execute: {
        value: {
          target_pane: "--target-pane",
          target_workspace: "--target-workspace",
          worktree_branch: "--worktree-branch",
          worktree_base: "--worktree-base",
          provider: "--provider",
          model: "--model",
        },
        bool: {
          new_workspace: "--new-workspace",
          worktree: "--worktree",
          cleanup_on_failure: "--cleanup-on-failure",
          dry_run: "--dry-run",
        },
        array: {},
        number: { wait_ms: "--wait-ms" },
      },
      delegate: {
        value: {
          task: "--task",
          strategy: "--strategy",
          provider: "--provider",
          model: "--model",
          target_pane: "--target-pane",
          target_workspace: "--target-workspace",
          worktree_branch: "--worktree-branch",
          worktree_base: "--worktree-base",
          link_note: "--link-note",
          note: "--note",
        },
        bool: {
          new_workspace: "--new-workspace",
          worktree: "--worktree",
          cleanup_on_failure: "--cleanup-on-failure",
          no_execute: "--no-execute",
          dry_run: "--dry-run",
        },
        array: {
          requirement: "--requirement",
          conversation: "--conversation",
          checkpoint: "--checkpoint",
          external: "--external",
          handoff: "--handoff",
        },
        number: { wait_ms: "--wait-ms" },
      },
      "merge-back": {
        value: { task: "--task", link_note: "--link-note", note: "--note" },
        bool: { no_execute: "--no-execute", dry_run: "--dry-run" },
        array: {
          requirement: "--requirement",
          conversation: "--conversation",
          checkpoint: "--checkpoint",
          external: "--external",
          handoff: "--handoff",
        },
        number: { wait_ms: "--wait-ms" },
      },
    };
    const spec = OP_SPECS[operation] as (typeof OP_SPECS)[string];
    const allowed = new Set([
      ...Object.keys(spec.value),
      ...Object.keys(spec.bool),
      ...Object.keys(spec.array),
      ...Object.keys(spec.number),
    ]);
    const provided = Object.keys(args).filter(
      (k) => !["operation", "id"].includes(k) && args[k] !== undefined,
    );
    const rejected = provided.filter((k) => !allowed.has(k));
    if (rejected.length > 0) {
      invalidParams(
        `arguments not valid for handoff ${operation}: ${rejected.join(", ")} ` +
          `(valid: ${[...allowed].sort().join(", ")})`,
        { operation, rejected },
      );
    }

    // --worktree-branch/--worktree-base without --worktree is a usage
    // error upstream; surface it here with the same honesty.
    if (
      spec.bool.worktree !== undefined &&
      args.worktree !== true &&
      (args.worktree_branch !== undefined || args.worktree_base !== undefined)
    ) {
      invalidParams("worktree_branch/worktree_base require worktree: true");
    }

    const cliArgs = [operation, id];
    for (const [arg, flag] of Object.entries(spec.value)) {
      const value = optionalString(args, arg);
      if (value !== undefined) cliArgs.push(flag, value);
    }
    for (const [arg, flag] of Object.entries(spec.number)) {
      const value = optionalNumber(args, arg);
      if (value !== undefined) cliArgs.push(flag, String(value));
    }
    for (const [arg, flag] of Object.entries(spec.bool)) {
      if (optionalBoolean(args, arg) === true) cliArgs.push(flag);
    }
    for (const [arg, flag] of Object.entries(spec.array)) {
      for (const value of optionalStringArray(args, arg) ?? []) {
        cliArgs.push(flag, value);
      }
    }

    // Session-level identity echo: the record's own transfer identity
    // travels inside the handoff result; the MCP block pins the herdr
    // session this invocation targeted.
    const snapshot = await liveSnapshot(ctx);
    const out = await pluginCommand(
      ctx,
      "rebuildup.handoff",
      MUTATION_PLUGIN_CONTRACTS["rebuildup.handoff"],
      cliArgs,
    );
    return {
      ...out,
      identity: identityBlock(ctx, snapshot),
      effects: [pluginCliEffect("rebuildup.handoff", operation, { id })],
    };
  },

  // --- Event handlers (T4, #140) ------------------------------------------------
  //
  // Read-level observation only: subscriptions never mutate herdr state.
  // The hub owns the upstream events.subscribe connection(s); clients
  // pull buffered items via poll/wait. Every disconnect is reported as
  // gap+resync notices — never as "no events".

  async events_subscribe(args, ctx) {
    let spec: SubscribeSpec;
    try {
      spec = parseSubscribeArgs(args);
    } catch (err) {
      throw mapEventError(err, "events_subscribe");
    }
    let result: Awaited<ReturnType<EventHub["subscribe"]>>;
    try {
      result = await ctx.events.subscribe(spec);
    } catch (err) {
      throw mapEventError(err, "events_subscribe");
    }
    const snapshot = await liveSnapshot(ctx);
    return { ...result, identity: identityBlock(ctx, snapshot) };
  },

  async events_poll(args, ctx) {
    const subscriptionId = requireString(args, "subscription_id");
    const cursor = optionalNumber(args, "cursor");
    let result: ReturnType<EventHub["poll"]>;
    try {
      result = ctx.events.poll(subscriptionId, cursor);
    } catch (err) {
      throw mapEventError(err, "events_poll");
    }
    const snapshot = await liveSnapshot(ctx);
    return { ...result, identity: identityBlock(ctx, snapshot) };
  },

  async events_wait(args, ctx) {
    const subscriptionId = requireString(args, "subscription_id");
    const cursor = optionalNumber(args, "cursor");
    const types = optionalStringArray(args, "types");
    const timeoutMs = optionalNumber(args, "timeout_ms");
    const options: { cursor?: number; types?: string[]; timeoutMs?: number } = {};
    if (cursor !== undefined) options.cursor = cursor;
    if (types !== undefined) options.types = types;
    if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
    let result: Awaited<ReturnType<EventHub["wait"]>>;
    try {
      result = await ctx.events.wait(subscriptionId, options);
    } catch (err) {
      throw mapEventError(err, "events_wait");
    }
    const snapshot = await liveSnapshot(ctx);
    return { ...result, identity: identityBlock(ctx, snapshot) };
  },

  async events_unsubscribe(args, ctx) {
    const subscriptionId = requireString(args, "subscription_id");
    let result: ReturnType<EventHub["unsubscribe"]>;
    try {
      result = ctx.events.unsubscribe(subscriptionId);
    } catch (err) {
      throw mapEventError(err, "events_unsubscribe");
    }
    const snapshot = await liveSnapshot(ctx);
    return { ...result, identity: identityBlock(ctx, snapshot) };
  },
};

// --- Dispatch ---------------------------------------------------------------------

const ACCESS_RANK: Record<AccessLevel, number> = { "read-only": 0, supervised: 1, full: 2 };

export function findTool(name: string): ToolDefinition | undefined {
  return ALL_TOOL_DEFINITIONS.find((d) => d.name === name);
}

/**
 * Dispatch one `tools/call`. Returns the MCP result object; throws
 * `ToolError` for contract-level failures (mapped to `isError`
 * results by the server) — protocol errors are the server's job.
 */
export async function callTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<{ payload: unknown; isError: boolean; error?: ToolError }> {
  const def = findTool(name);
  if (def === undefined) {
    return {
      payload: null,
      isError: true,
      error: new ToolError("invalid_params", `unknown tool: ${name}`),
    };
  }
  // Access-level enforcement before any dispatch (T3 McpToolAccess
  // semantics): below-level calls fail capability_denied and change
  // nothing — including for not-yet-implemented tools.
  if (ACCESS_RANK[def.spec.access] > ACCESS_RANK[ctx.accessLevel]) {
    return {
      payload: null,
      isError: true,
      error: new ToolError(
        "capability_denied",
        `tool ${name} requires access level '${def.spec.access}'; server runs at '${ctx.accessLevel}'`,
        { tool: name, required: def.spec.access, negotiated: ctx.accessLevel },
      ),
    };
  }
  if (def.spec.status !== "implemented" || HANDLERS[name] === undefined) {
    return {
      payload: null,
      isError: true,
      error: new ToolError(
        "unsupported",
        `tool ${name} is planned but not implemented yet (status: ${def.spec.status})`,
        { tool: name, ticket: "#139/#140" },
      ),
    };
  }
  const args =
    rawArgs === undefined || rawArgs === null ? {} : (rawArgs as Record<string, unknown>);
  if (typeof args !== "object" || Array.isArray(args)) {
    return {
      payload: null,
      isError: true,
      error: new ToolError("invalid_params", "tools/call arguments must be an object"),
    };
  }
  try {
    const result = await HANDLERS[name]?.(args, ctx);
    return { payload: { contract: CONTRACT, ok: true, tool: name, result }, isError: false };
  } catch (err) {
    if (err instanceof ToolError) {
      return {
        payload: null,
        isError: true,
        error: err,
      };
    }
    return {
      payload: null,
      isError: true,
      error: new ToolError("internal", err instanceof Error ? err.message : String(err)),
    };
  }
}
