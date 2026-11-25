/**
 * Tool registry + handlers for `rebuildup.mcp` (contract
 * `herdr-plugins.mcp/v1`, T2 #138 read surface).
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
  type AgentInfo,
  type AgentReadResult,
  agentGet,
  agentList,
  agentRead,
  type CallOptions,
  HerdrRpcError,
  paneAgentEntries,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
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
  PLANNED_PLUGIN_CONTRACTS,
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

/** Map a sibling-CLI failure kind/message onto the contract error codes. */
function mapPluginErrorKind(kind: string | undefined, message: string): McpErrorCode {
  const k = (kind ?? "").toLowerCase();
  const m = message.toLowerCase();
  if (k.includes("not_found") || k.includes("no_pane_cwd") || m.includes("not found")) {
    return "not_found";
  }
  if (k.includes("not_a_repo") || k.includes("bare_repo")) return "unsupported";
  if (k.includes("git_missing")) return "unsupported";
  if (k.includes("session") || k.includes("socket") || k.includes("unreachable")) {
    return "session_unreachable";
  }
  if (k.includes("invalid") || k.includes("usage") || k.includes("required")) {
    return "invalid_params";
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
 * Run a sibling plugin read command and return its JSON document.
 * Resolution failure → `plugin_unavailable`; non-zero exit → mapped
 * contract error with the child's `error.kind` preserved in details.
 */
async function pluginRead(
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

// --- Capability ----------------------------------------------------------------

/** Per-plugin availability for `herdr_capability` / CLI `capability`. */
export async function pluginAvailability(
  ctx: Pick<ToolContext, "probePlugin">,
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (const [pluginId, contract] of [
    ...Object.entries(READ_PLUGIN_CONTRACTS),
    ...Object.entries(PLANNED_PLUGIN_CONTRACTS),
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
];

// Planned tools still appear in tools/list (contract "unsupported"
// semantics) but have no handler until T3/T4.
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
    return pluginRead(
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
    return pluginRead(
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
    const out = await pluginRead(ctx, "rebuildup.git", READ_PLUGIN_CONTRACTS["rebuildup.git"], [
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
    const out = await pluginRead(
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
    const out = await pluginRead(
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
    return pluginRead(
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
    return pluginRead(ctx, "rebuildup.usage", READ_PLUGIN_CONTRACTS["rebuildup.usage"], cliArgs);
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
