/**
 * Shared helpers for the rebuildup.controls interactive TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033).
 *
 * Same architecture as the rebuildup.projects TUI (#240):
 *
 * - every contract operation runs through this plugin's OWN CLI
 *   (`src/cli.ts`) as a subprocess — the same
 *   `herdr-plugins.controls/v1` surface CLI/MCP/GUI consumers use, so
 *   behavior cannot drift and the CLI's generation guards
 *   (`--expect-*` → `stale_generation`) stay the single enforcement
 *   point;
 * - agent/pane *enumeration* is a read-only `session.snapshot` through
 *   the documented socket API (the controls contract intentionally has
 *   no list command — enumeration is herdr state, not plugin state);
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open` action
 *   captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import {
  type AgentGetResult,
  type AgentInfo,
  agentGet,
  HerdrRpcError,
  type PaneInfo,
  request,
  resolveTarget,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";

export const PLUGIN_ID = "rebuildup.controls";
export const PLUGIN_VERSION = "0.6.0";

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
 * itself (surface identity), which is never a mutation target.
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

  return { workspaceId, tabId, originPaneId, socketPath, session };
}

/** One-line human description of the pinned target for the status line. */
export function formatTargetLabel(target: PinnedTarget): string {
  const parts: string[] = [];
  if (target.session !== null) parts.push(`session ${target.session}`);
  if (target.workspaceId !== null) parts.push(`ws ${target.workspaceId}`);
  if (target.originPaneId !== null) parts.push(`pane ${target.originPaneId}`);
  return parts.length > 0 ? parts.join(" · ") : "no pinned target";
}

// --- pane opening (open action → plugin.pane.open) ---------------------------

/**
 * Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
 * `tab` per the tui-v1 placement policy: the controls surface is a
 * workspace-scale agent browser, multi-instance safe, and pane-backed
 * so `plugin.pane.focus/close` keep working.
 */
export function buildPaneOpenParams(target: PinnedTarget): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (target.workspaceId !== null) env.HERDR_TUI_WORKSPACE_ID = target.workspaceId;
  if (target.tabId !== null) env.HERDR_TUI_TAB_ID = target.tabId;
  if (target.originPaneId !== null) env.HERDR_TUI_PANE_ID = target.originPaneId;

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
 * Open the controls TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openControlsPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/controls`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/controls
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the controls CLI subprocess. */
export class ControlsCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "ControlsCliError";
  }
}

export interface CliRunOptions {
  /** Hard cap on the subprocess; default 120s (reads). Long ops pass more. */
  timeoutMs?: number;
  /** AbortSignal (task cancel) — kills the child process. */
  signal?: AbortSignal;
}

function parseCliEnvelope(
  stdout: string,
  stderr: string,
  exitCode: number,
): Record<string, unknown> {
  // The CLI emits one JSON document on stdout (pretty-printed); parse
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
  // Failure path: stderr carries {contract, ok:false, error:{...}}.
  let kind = "cli_error";
  let message = `controls cli exited ${exitCode} with no JSON output`;
  let extra: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(stderr) as {
      error?: { code?: unknown; kind?: unknown; message?: unknown } & Record<string, unknown>;
    };
    const err = parsed.error;
    if (err && typeof err === "object") {
      if (typeof err.message === "string") message = err.message;
      if (typeof err.kind === "string") kind = err.kind;
      else if (typeof err.code === "string") kind = err.code;
      const { code: _c, kind: _k, message: _m, ...rest } = err;
      if (Object.keys(rest).length > 0) extra = rest;
    }
  } catch {
    const tail = stderr.trim().split("\n").slice(-3).join(" | ");
    if (tail !== "") message = `${message}: ${tail.slice(0, 400)}`;
  }
  throw new ControlsCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 */
export function runControlsCli(
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
      finish(() => reject(new ControlsCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new ControlsCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
      );
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
      finish(() => reject(new ControlsCliError(String(err), "cli_spawn_error")));
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

// --- mutation gating (capability / mutation_commands) ------------------------

/** Subset of the `capability` payload the TUI consults (tui-v1 §5.4). */
export interface CapabilityDoc {
  read_only?: boolean;
  mutation_commands?: unknown;
  [key: string]: unknown;
}

export interface MutationGate {
  allowed: boolean;
  /** Human-readable reason when disabled — rendered, never hidden. */
  reason: string | null;
}

/**
 * Fail-closed gate: a missing capability document disables ALL
 * mutations (honest unsupported, contract item 9/4). `command` is the
 * CLI command path exactly as listed in `mutation_commands`
 * (controls: "send", "command", "interrupt", "rename", "start").
 */
export function mutationAllowed(capability: CapabilityDoc | null, command: string): MutationGate {
  if (capability === null) {
    return {
      allowed: false,
      reason: "capability document unavailable — mutations disabled (fail closed)",
    };
  }
  if (capability.read_only === true) {
    return { allowed: false, reason: "plugin reports read_only" };
  }
  const commands = Array.isArray(capability.mutation_commands)
    ? capability.mutation_commands.filter((c): c is string => typeof c === "string")
    : [];
  if (!commands.includes(command)) {
    return {
      allowed: false,
      reason: `"${command}" is not in mutation_commands`,
    };
  }
  return { allowed: true, reason: null };
}

// --- session reads (documented socket API; never mutations) -------------------

export interface SessionAgents {
  panes: PaneInfo[];
  /** pane_id → AgentInfo, only panes herdr reports an agent for. */
  agents: Record<string, AgentInfo>;
  sessionName: string | null;
}

/**
 * Read-only enumeration for target selection. `session.snapshot` is the
 * documented public socket surface — the same data `agent.list`/GUI
 * consumers read. Never used for mutation decisions; every mutation
 * revalidates through the CLI's `agent.get` + `--expect-*` guards.
 */
export async function readSessionAgents(): Promise<SessionAgents> {
  const snapshot: SessionSnapshot = await sessionSnapshot({});
  return {
    panes: snapshot.panes ?? [],
    agents: snapshot.agents ?? {},
    sessionName: str(snapshot.session?.name),
  };
}

/** Read-only `agent.get` for detail refresh (generation signals). */
export async function readAgent(target: string): Promise<AgentGetResult> {
  return agentGet(target, {});
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof ControlsCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// --- payload → view formatting (pure, unit-tested) ----------------------------

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** One select-list row per agent-bearing pane in the session snapshot. */
export function agentSelectItem(
  pane: PaneInfo,
  agent: AgentInfo,
): SelectItem<{ paneId: string; agent: AgentInfo }> {
  const paneId = pane.pane_id;
  const kind = str(agent.agent) ?? "agent";
  const status = str(agent.agent_status) ?? "unknown";
  const seq = typeof agent.state_change_seq === "number" ? agent.state_change_seq : null;
  const cwd = str(agent.cwd ?? pane.cwd);
  const title = str(pane.title);
  const labelParts = [`${paneId}`, kind, status];
  if (title !== null) labelParts.push(title);
  const detail = [
    `pane: ${paneId}`,
    `agent: ${kind} · status: ${status}`,
    `state_change_seq: ${seq === null ? "unreported" : seq}`,
    `workspace: ${fmt(pane.workspace_id)} · tab: ${fmt(pane.tab_id)}`,
    `cwd: ${cwd ?? "unknown"}`,
    `session: ${fmt(asRecord(agent.agent_session)?.value)}`,
  ].join("\n");
  return {
    value: { paneId, agent },
    label: labelParts.join("  "),
    detail,
  };
}

/** Select-list row for a shell pane eligible for `start` (no live agent). */
export function shellPaneSelectItem(pane: PaneInfo, hasAgent: boolean): SelectItem<PaneInfo> {
  const cwd = str(pane.cwd);
  const title = str(pane.title);
  const label = `${pane.pane_id}${title !== null ? `  ${title}` : ""}${cwd !== null ? `  ${cwd}` : ""}`;
  return {
    value: pane,
    label,
    detail: [
      `pane: ${pane.pane_id}`,
      `workspace: ${fmt(pane.workspace_id)} · tab: ${fmt(pane.tab_id)}`,
      `cwd: ${cwd ?? "unknown"}`,
      hasAgent
        ? "already runs an agent — agent.start would conflict"
        : "shell pane (no reported agent)",
    ].join("\n"),
    ...(hasAgent ? { disabled: true, disabledReason: "already has an agent" } : {}),
  };
}

/** Header lines describing a resolved agent identity (detail view top). */
export function identityLines(agent: AgentGetResult): string[] {
  const session = asRecord(agent.agent_session);
  return [
    `pane: ${fmt(agent.pane_id)}`,
    `agent: ${fmt(agent.agent)}`,
    `status: ${fmt(agent.agent_status)}`,
    `state_change_seq: ${fmt(agent.state_change_seq)}`,
    `workspace: ${fmt(agent.workspace_id)} · tab: ${fmt(agent.tab_id)}`,
    `cwd: ${fmt(agent.cwd ?? agent.foreground_cwd)}`,
    `agent_session: ${fmt(session?.value)} (${fmt(session?.kind)}/${fmt(session?.agent)})`,
    `interactive_ready: ${fmt(agent.interactive_ready)} · launch_pending: ${fmt(agent.launch_pending)}`,
  ];
}
