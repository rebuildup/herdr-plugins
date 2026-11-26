/**
 * Shared helpers for the rebuildup.mcp diagnostics TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033).
 *
 * Everything here is deliberately thin:
 *
 * - the TUI consumes the plugin's OWN public CLI (`src/cli.ts
 *   capability`) as a subprocess — the same contract document MCP
 *   clients read through `herdr_capability`, so CLI/MCP/TUI cannot
 *   drift. The MCP server itself is NEVER screen-ified (ADR-0025/0033:
 *   diagnostics only);
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open` action
 *   captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target.
 *   The mcp plugin has no mutations, so there is no mutation gate —
 *   every surface here is read-only by construction.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { HerdrRpcError, request, resolveTarget } from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";
import { PLUGIN_ID } from "./model";

export { PLUGIN_ID };

// --- pinned target identity -------------------------------------------------

/**
 * Origin context captured at launch. Fields are `null` when unknown —
 * the UI must render that honestly rather than guess "current" focus.
 */
export interface PinnedTarget {
  /** Workspace the UI was launched from (pane placement target). */
  workspaceId: string | null;
  tabId: string | null;
  /** Origin focused pane at launch — context identity, NOT the UI pane. */
  originPaneId: string | null;
  /** Origin cwd — display only (mcp resolves sessions, not cwds). */
  originCwd: string | null;
  /** Resolved herdr socket the UI talks to (display/diagnostics). */
  socketPath: string | null;
  /** Session name when the socket maps to a named session. */
  session: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Tolerant parse of `HERDR_PLUGIN_CONTEXT_JSON` (never throws). */
export function parsePluginContext(raw: string | undefined | null): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the pinned launch target. Precedence per field:
 * explicit `HERDR_TUI_*` env pins (set by the `open` action) →
 * `HERDR_PLUGIN_CONTEXT_JSON` origin fields → null.
 *
 * `HERDR_PANE_ID` is deliberately ignored: it identifies the UI pane
 * itself (surface identity), which is never a target.
 */
export function resolvePinnedTarget(env: NodeJS.ProcessEnv = process.env): PinnedTarget {
  const context = parsePluginContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const focusedPane =
    typeof context.focused_pane === "object" && context.focused_pane !== null
      ? (context.focused_pane as Record<string, unknown>)
      : {};

  const workspaceId = str(env.HERDR_TUI_WORKSPACE_ID) ?? str(context.workspace_id);
  const tabId = str(env.HERDR_TUI_TAB_ID) ?? str(context.tab_id);
  const originPaneId =
    str(env.HERDR_TUI_PANE_ID) ??
    str(context.focused_pane_id) ??
    str(focusedPane.pane_id) ??
    str(focusedPane.id);
  const originCwd =
    str(env.HERDR_TUI_CWD) ??
    str(focusedPane.cwd) ??
    str(context.cwd) ??
    str(context.workspace_cwd);

  let socketPath: string | null = null;
  let session: string | null = null;
  try {
    const resolved = resolveTarget({});
    socketPath = resolved.socketPath;
    session = resolved.session;
  } catch {
    // Target-resolution conflicts surface honestly through the CLI
    // subprocess anyway; the TUI only needs display values here.
  }

  return { workspaceId, tabId, originPaneId, originCwd, socketPath, session };
}

/** One-line human description of the pinned target for the status line. */
export function formatTargetLabel(target: PinnedTarget): string {
  const parts: string[] = [];
  if (target.session !== null) parts.push(`session ${target.session}`);
  if (target.workspaceId !== null) parts.push(`ws ${target.workspaceId}`);
  if (target.originPaneId !== null) parts.push(`pane ${target.originPaneId}`);
  if (target.originCwd !== null) parts.push(`cwd ${target.originCwd}`);
  return parts.length > 0 ? parts.join(" · ") : "no pinned target";
}

// --- pane opening (open action → plugin.pane.open) ---------------------------

/**
 * Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
 * `tab` per the tui-v1 placement policy: the mcp diagnostics surface is a
 * workspace-scale read-only browser, multi-instance safe, and pane-backed
 * so `plugin.pane.focus/close` keep working.
 */
export function buildPaneOpenParams(target: PinnedTarget): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (target.workspaceId !== null) env.HERDR_TUI_WORKSPACE_ID = target.workspaceId;
  if (target.tabId !== null) env.HERDR_TUI_TAB_ID = target.tabId;
  if (target.originPaneId !== null) env.HERDR_TUI_PANE_ID = target.originPaneId;
  if (target.originCwd !== null) env.HERDR_TUI_CWD = target.originCwd;

  const params: Record<string, unknown> = {
    plugin_id: PLUGIN_ID,
    entrypoint: "main",
    placement: "tab",
    env,
  };
  if (target.workspaceId !== null) params.workspace_id = target.workspaceId;
  return params;
}

/**
 * Open the mcp diagnostics pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openMcpPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/mcp`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/mcp
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the mcp CLI subprocess. */
export class McpCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "McpCliError";
  }
}

export interface CliRunOptions {
  /** Hard cap on the subprocess; default 120s (capability probes siblings). */
  timeoutMs?: number;
  /** AbortSignal (task cancel) — kills the child process. */
  signal?: AbortSignal;
}

function parseCliEnvelope(
  stdout: string,
  stderr: string,
  exitCode: number,
): Record<string, unknown> {
  // The CLI emits one pretty-printed JSON document on stdout; parse
  // the whole stream first, then fall back to per-line candidates for
  // compact single-line emitters.
  const trimmed = stdout.trim();
  if (trimmed !== "" && exitCode === 0) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not a single JSON document — try line-wise below
    }
  }
  const candidates = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .reverse();
  for (const line of candidates) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next line
    }
  }
  // Failure path: stderr carries {contract, ok:false, error:{code,message}}.
  let kind = "cli_error";
  let message = `mcp cli exited ${exitCode} with no JSON output`;
  let extra: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(stderr) as {
      error?: { code?: unknown; kind?: unknown; message?: unknown } & Record<string, unknown>;
    };
    const err = parsed.error;
    if (err && typeof err === "object") {
      if (typeof err.message === "string") message = err.message;
      if (typeof err.code === "string") kind = err.code;
      else if (typeof err.kind === "string") kind = err.kind;
      const { code: _c, kind: _k, message: _m, ...rest } = err;
      if (Object.keys(rest).length > 0) extra = rest;
    }
  } catch {
    const tail = stderr.trim().split("\n").slice(-3).join(" | ");
    if (tail !== "") message = `${message}: ${tail.slice(0, 400)}`;
  }
  throw new McpCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so `capability`
 * resolves the SAME herdr session the TUI was launched in (tui-v1 §3
 * identity pinning; mcp session resolution is socket/session-based and
 * deliberately ignores pane-scoped env, ADR-0025 §4). No shell, argv
 * only. The diagnostics surface only ever calls read commands
 * (`capability`); `serve` is never spawned.
 */
export function runMcpCli(
  args: readonly string[],
  options: CliRunOptions = {},
): Promise<Record<string, unknown>> {
  const root = pluginRoot();
  const cliPath = path.join(root, "src", "cli.ts");
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      child.kill();
      finish(() => reject(new McpCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new McpCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")));
    }, timeoutMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() => reject(new McpCliError(String(err), "cli_spawn_error")));
    });
    child.on("close", (code) => {
      finish(() => {
        try {
          resolve(parseCliEnvelope(stdout, stderr, code ?? -1));
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}

// --- payload → view formatting (pure, unit-tested) ----------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

// --- access levels ------------------------------------------------------------

/** Contract order: read-only < supervised < full (mcp-v1 "Access levels"). */
export const ACCESS_ORDER = ["read-only", "supervised", "full"] as const;
export type AccessLevelName = (typeof ACCESS_ORDER)[number];

export function accessRank(level: string): number {
  const idx = ACCESS_ORDER.indexOf(level as AccessLevelName);
  return idx === -1 ? -1 : idx;
}

/**
 * Deterministic availability of a tool at an access level, derived from
 * the tool's declared `access` floor (the same rule the server enforces
 * before dispatch — `capability_denied` below the floor). Returns null
 * when either side is unparseable so callers render `unknown` instead
 * of guessing.
 */
export function toolAvailableAt(toolAccess: unknown, level: unknown): boolean | null {
  if (typeof toolAccess !== "string" || typeof level !== "string") return null;
  const toolRank = accessRank(toolAccess);
  const levelRank = accessRank(level);
  if (toolRank === -1 || levelRank === -1) return null;
  return levelRank >= toolRank;
}

// --- capability payload rows ---------------------------------------------------

/** One row of the capability `tools[]` table. */
export interface ToolRow {
  name: string;
  access: string;
  readOnly: boolean;
  status: string;
  backs_onto: string;
}

export function asTools(value: unknown): ToolRow[] {
  return asArray(value)
    .map((t) => ({
      name: typeof t.name === "string" ? t.name : "?",
      access: typeof t.access === "string" ? t.access : "unknown",
      readOnly: t.read_only === true,
      status: typeof t.status === "string" ? t.status : "unknown",
      backs_onto: typeof t.backs_onto === "string" ? t.backs_onto : "unknown",
    }))
    .filter((t) => t.name !== "?");
}

/** Select-list row for one MCP tool. */
export function toolSelectItem(tool: ToolRow): SelectItem<ToolRow> {
  const kind = tool.readOnly ? "read" : "mutation";
  const denied = tool.status !== "implemented" ? `status ${tool.status}` : null;
  return {
    value: tool,
    label: tool.name,
    detail: [
      `${tool.access} · ${kind} · ${tool.status}`,
      tool.backs_onto,
      ...(denied !== null ? [denied] : []),
    ].join("\n"),
  };
}

/**
 * Full detail lines for one tool: declared fields plus the per-level
 * availability matrix (deterministic `access`-floor rule). Unparseable
 * levels render `unknown`, never a guess.
 */
export function formatToolLines(tool: ToolRow, negotiatedLevel: unknown): string[] {
  const lines = [
    `tool: ${tool.name}`,
    `access floor: ${tool.access}`,
    `read-only annotation: ${tool.readOnly ? "yes" : "no"}`,
    `status: ${tool.status}`,
    `backs onto: ${tool.backs_onto}`,
    `negotiated access level: ${fmt(negotiatedLevel)}`,
    "",
    "availability by access level:",
  ];
  for (const level of ACCESS_ORDER) {
    const avail = toolAvailableAt(tool.access, level);
    const verdict = avail === null ? "unknown" : avail ? "allowed" : "capability_denied";
    lines.push(`  ${level}: ${verdict}`);
  }
  lines.push(
    "",
    "note: the MCP server itself is not screen-ified — this is the",
    "declared tool surface from `mcp capability`, diagnostics only.",
  );
  return lines;
}

/** One row of the capability `plugins[]` availability report. */
export interface PluginRow {
  plugin: string;
  contract: string;
  available: boolean;
  resolvedVia: string | null;
  error: string | null;
}

export function asPlugins(value: unknown): PluginRow[] {
  return asArray(value)
    .map((p) => ({
      plugin: typeof p.plugin === "string" ? p.plugin : "?",
      contract: typeof p.contract === "string" ? p.contract : "unknown",
      available: p.available === true,
      resolvedVia: typeof p.resolved_via === "string" ? p.resolved_via : null,
      error: typeof p.error === "string" ? p.error : null,
    }))
    .filter((p) => p.plugin !== "?");
}

/** Select-list row for one sibling-plugin availability entry. */
export function pluginSelectItem(plugin: PluginRow): SelectItem<PluginRow> {
  return {
    value: plugin,
    label: `${plugin.plugin} — ${plugin.available ? "available" : "unavailable"}`,
    detail: [
      `contract: ${plugin.contract}`,
      plugin.available
        ? `resolved via: ${plugin.resolvedVia ?? "unknown"}`
        : `error: ${plugin.error ?? "unknown"}`,
    ].join("\n"),
  };
}

/** Detail lines for one plugin availability entry (honest error text). */
export function formatPluginLines(plugin: PluginRow): string[] {
  const lines = [
    `plugin: ${plugin.plugin}`,
    `contract: ${plugin.contract}`,
    `available: ${plugin.available ? "yes" : "no"}`,
  ];
  if (plugin.available) {
    lines.push(`resolved via: ${plugin.resolvedVia ?? "unknown"}`);
  } else {
    lines.push(`error: ${plugin.error ?? "unknown"}`);
    lines.push(
      "",
      "an unavailable plugin makes its backing tools fail",
      "plugin_unavailable at call time — never a fabricated success.",
    );
  }
  return lines;
}

// --- overview summary ------------------------------------------------------------

function surfaceMap(payload: Record<string, unknown>): Record<string, unknown> {
  return asRecord(payload.surfaces) ?? {};
}

/**
 * Compact overview lines for the root view and the non-TTY fallback.
 * Every field comes straight from the `capability` document; absent
 * fields render `unknown` (contract item 9 — honest unsupported).
 */
export function formatOverviewLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const surfaces = surfaceMap(payload);
  const surfaceText = ["read", "mutation", "events"]
    .map((k) => `${k} ${fmt(surfaces[k])}`)
    .join(" · ");
  lines.push(
    `contract: ${fmt(payload.contract)} (${fmt(payload.contract_status)})`,
    `plugin: ${fmt(payload.plugin)} v${fmt(payload.version)}`,
    `surfaces: ${surfaceText}`,
  );

  const session = asRecord(payload.session) ?? {};
  const resolution = asRecord(payload.session_resolution) ?? {};
  const sessionText =
    session.reachable === true
      ? `reachable${typeof session.session_name === "string" ? ` (session ${session.session_name})` : ""}`
      : `unreachable${typeof session.error === "string" ? ` — ${session.error}` : ""}`;
  lines.push(
    `session: ${sessionText}`,
    `socket: ${fmt(payload.socket)}`,
    `resolved via: ${fmt(resolution.resolved_via)}${typeof resolution.session_name_flag === "string" ? ` (--session ${resolution.session_name_flag})` : ""}`,
  );

  const access = asRecord(payload.access_levels) ?? {};
  const levels = Array.isArray(access.levels)
    ? access.levels.filter((l): l is string => typeof l === "string")
    : [];
  lines.push(
    `access levels: ${levels.length > 0 ? levels.join(" < ") : "unknown"} (default ${fmt(access.default)})`,
    `negotiated: ${fmt(payload.negotiated_access_level)}`,
  );

  const tools = asTools(payload.tools);
  const plugins = asPlugins(payload.plugins);
  const unavailable = plugins.filter((p) => !p.available);
  lines.push(
    `tools: ${tools.length} declared (${tools.filter((t) => t.status === "implemented").length} implemented)`,
    `plugins: ${plugins.length - unavailable.length} available / ${unavailable.length} unavailable`,
  );
  for (const p of unavailable) {
    lines.push(`  unavailable: ${p.plugin} — ${p.error ?? "unknown"}`);
  }

  const remote = asRecord(payload.remote) ?? {};
  lines.push(
    `remote: ${fmt(remote.status)}${typeof remote.tracking === "string" ? ` (${remote.tracking})` : ""}`,
    `state: ${fmt(payload.state)}`,
    `config dir: ${fmt(payload.config_dir)}`,
  );
  return lines;
}

/**
 * Contract-reference lines: error model, upstream gaps, session
 * resolution rule, remote note — the static diagnostics an operator
 * needs alongside the live session report.
 */
export function formatReferenceLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const resolution = asRecord(payload.session_resolution) ?? {};
  if (typeof resolution.rule === "string") {
    lines.push("session resolution:", `  ${resolution.rule}`);
  }

  const codes = Array.isArray(payload.error_codes)
    ? payload.error_codes.filter((c): c is string => typeof c === "string")
    : [];
  lines.push(
    "",
    "error codes:",
    ...(codes.length > 0 ? codes.map((c) => `  ${c}`) : ["  (none reported)"]),
  );

  const gaps = asArray(payload.upstream_gaps);
  lines.push("", "upstream gaps:");
  if (gaps.length === 0) {
    lines.push("  (none reported)");
  }
  for (const gap of gaps) {
    lines.push(`  ${fmt(gap.id)} — ${fmt(gap.summary)}`);
    lines.push(`    v1: ${fmt(gap.v1)} · tracking: ${fmt(gap.tracking)}`);
  }

  const remote = asRecord(payload.remote) ?? {};
  if (typeof remote.note === "string") {
    lines.push("", "remote:", `  ${remote.note}`);
  }
  lines.push(
    "",
    "surface note:",
    "  diagnostics only — `serve` and tool invocation",
    "  stay on the stdio MCP path (ADR-0025/0033).",
  );
  return lines;
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof McpCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
