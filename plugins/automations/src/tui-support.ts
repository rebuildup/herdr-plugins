/**
 * Shared helpers for the rebuildup.automations interactive TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033).
 *
 * Everything here is deliberately thin:
 *
 * - the TUI consumes the plugin's OWN public CLI (`src/cli.ts`) as a
 *   subprocess for every read and mutation — the same contract
 *   CLI/MCP/GUI consumers use, so CLI/MCP/GUI behavior cannot drift;
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open` action
 *   captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`, and every CLI call
 *   carries `--socket <resolved>` so reads/mutations land on the SAME
 *   herdr session (and therefore the same session-namespaced task
 *   registry) the UI was launched in — this is what makes schedule
 *   management work GUI-less on WSL/SSH/headless hosts.
 *   `HERDR_PANE_ID` is the UI pane's own surface identity and is NEVER
 *   used as a target.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { HerdrRpcError, request, resolveTarget } from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";
import {
  type Destination,
  HOOK_EVENT_NAMES,
  PLUGIN_ID,
  type RunView,
  type Schedule,
  type TaskView,
} from "./model";

export { HOOK_EVENT_NAMES, PLUGIN_ID };

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
  /** Origin cwd — informational only. */
  originCwd: string | null;
  /** Resolved herdr socket the UI talks to (pinned via `--socket`). */
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

/**
 * CLI argv suffix pinning the resolved socket so every subprocess hits
 * the same herdr session the TUI was launched in (tui-v1 §3.1). The
 * automations CLI parses global flags position-independently, so the
 * suffix may be appended after the command args. Empty when the
 * socket could not be resolved — the child then falls back to the
 * ambient env, which is the same resolution the pane inherited.
 */
export function pinnedCliArgs(target: PinnedTarget): string[] {
  return target.socketPath !== null ? ["--socket", target.socketPath] : [];
}

// --- pane opening (open action → plugin.pane.open) ---------------------------

/**
 * Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
 * `tab` per the tui-v1 placement policy: the automations surface is a
 * workspace-scale browser, multi-instance safe, and pane-backed so
 * `plugin.pane.focus/close` keep working.
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
 * Open the automations TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openAutomationsPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/automations`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/automations
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the automations CLI subprocess. */
export class AutomationsCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "AutomationsCliError";
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
  // compact single-line emitters (`watch` JSONL is never invoked here).
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
  let message = `automations cli exited ${exitCode} with no JSON output`;
  let extra: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(stderr) as {
      error?: { code?: unknown; kind?: unknown; message?: unknown } & Record<string, unknown>;
    };
    const err = parsed.error;
    if (err && typeof err === "object") {
      if (typeof err.message === "string") message = err.message;
      if (typeof err.code === "string") kind = err.code;
      const { code: _c, message: _m, ...rest } = err;
      if (Object.keys(rest).length > 0) extra = rest;
    }
  } catch {
    const tail = stderr.trim().split("\n").slice(-3).join(" | ");
    if (tail !== "") message = `${message}: ${tail.slice(0, 400)}`;
  }
  throw new AutomationsCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 */
export function runAutomationsCli(
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
      finish(() => reject(new AutomationsCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new AutomationsCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
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
      finish(() => reject(new AutomationsCliError(String(err), "cli_spawn_error")));
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

/**
 * Start the opt-in `watch` driver as a DETACHED background process
 * (`bun src/cli.ts watch --socket <pinned>`). The pane UI must not own
 * a long-running loop (tui-v1 §1: the pane process terminates when the
 * UI exits); the watch process registers/removes its own pid-checked
 * driver record exactly like a CLI-invoked `watch`. Returns the child
 * pid for display; the driver record is the honest status source.
 */
export function startWatchDetached(target: PinnedTarget): number {
  const root = pluginRoot();
  const cliPath = path.join(root, "src", "cli.ts");
  const args = [cliPath, "watch", ...pinnedCliArgs(target)];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child.pid ?? -1;
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
 * (e.g. "create", "run-now", "schedule install").
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

// --- payload → view formatting (pure, unit-tested) ----------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export function asTaskView(value: unknown): TaskView | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  if (typeof rec.task_id !== "string" || typeof rec.name !== "string") return null;
  return value as TaskView;
}

export function asTaskViews(value: unknown): TaskView[] {
  return Array.isArray(value) ? value.map(asTaskView).filter((t): t is TaskView => t !== null) : [];
}

export function asRunViews(value: unknown): RunView[] {
  return Array.isArray(value)
    ? (value.filter(
        (v): v is RunView => typeof v === "object" && v !== null && "task_id" in v,
      ) as RunView[])
    : [];
}

/** One-line schedule summary for list/detail rendering. */
export function scheduleSummary(schedule: Schedule | Record<string, unknown> | null): string {
  const s = asRecord(schedule);
  if (s === null) return "unknown";
  const type = fmt(s.type);
  switch (type) {
    case "interval":
      return `every ${fmt(s.every_ms)}ms`;
    case "fixed_time": {
      const parts = [`at ${fmt(s.time_of_day)}`];
      if (Array.isArray(s.weekdays) && s.weekdays.length > 0) {
        parts.push(`weekdays ${s.weekdays.join(",")}`);
      }
      if (typeof s.time_zone === "string" && s.time_zone !== "") {
        parts.push(`tz ${s.time_zone}`);
      }
      return parts.join(" · ");
    }
    case "once":
      return `once at ${fmt(s.run_at)}`;
    case "event": {
      const parts = [`on ${fmt(s.on)}`];
      const filter = asRecord(s.filter);
      if (filter !== null && Object.keys(filter).length > 0) {
        parts.push(`filter ${JSON.stringify(filter)}`);
      }
      if (typeof s.debounce_ms === "number") parts.push(`debounce ${s.debounce_ms}ms`);
      if (typeof s.cooldown_ms === "number") parts.push(`cooldown ${s.cooldown_ms}ms`);
      if (typeof s.max_fires === "number") parts.push(`max ${s.max_fires}`);
      return parts.join(" · ");
    }
    default:
      return `type ${type} ${JSON.stringify(s)}`;
  }
}

/** One-line destination summary for list/detail rendering. */
export function destinationSummary(
  destination: Destination | Record<string, unknown> | null,
): string {
  const d = asRecord(destination);
  if (d === null) return "unknown";
  const kind = fmt(d.kind);
  if (kind === "pane") return `pane ${fmt(d.pane_id)}`;
  if (kind === "launch") {
    const surface = asRecord(d.surface);
    const surfaceText =
      surface === null
        ? "?"
        : surface.new_workspace === true
          ? "new workspace"
          : typeof surface.workspace_id === "string"
            ? `ws ${surface.workspace_id}`
            : typeof surface.tab_id === "string"
              ? `tab ${surface.tab_id}`
              : "?";
    const via = typeof d.via === "string" && d.via !== "" ? ` via ${d.via}` : "";
    return `launch ${fmt(d.agent)} → ${surfaceText}${via}`;
  }
  return `kind ${kind} ${JSON.stringify(d)}`;
}

/** Select-list row for one task view. */
export function taskSelectItem(task: TaskView): SelectItem<TaskView> {
  const badges = [
    task.enabled ? null : "disabled",
    task.missed_total > 0 ? `${task.missed_total} missed` : null,
  ].filter((b): b is string => b !== null);
  const suffix = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
  const next = task.next_run_at !== null ? `next ${task.next_run_at}` : "no next run";
  return {
    value: task,
    label: `${task.name} (${task.task_id})${suffix}`,
    detail: [
      `schedule: ${scheduleSummary(task.schedule)}`,
      `destination: ${destinationSummary(task.destination)}`,
      `driver: ${task.driver.state} — ${task.driver.detail}`,
      `${next} · runs ${task.run_count} · misfire ${task.misfire}`,
    ].join("\n"),
  };
}

/** Header lines describing one task (detail view top section). */
export function taskHeaderLines(task: TaskView): string[] {
  return [
    `task_id: ${task.task_id}`,
    `name: ${task.name}`,
    `enabled: ${task.enabled} · misfire: ${task.misfire} · runs: ${task.run_count}`,
    `schedule: ${scheduleSummary(task.schedule)}`,
    `destination: ${destinationSummary(task.destination)}`,
    `driver: ${task.driver.state} — ${task.driver.detail}`,
    `next_run_at: ${task.next_run_at ?? "none"}`,
    `missed: ${task.missed_total}${task.missed_truncated ? " (truncated)" : ""}`,
    `created: ${task.created_at} by ${task.created_by}`,
    `updated: ${task.updated_at}`,
    `enabled_at: ${task.enabled_at} · disabled_at: ${task.disabled_at ?? "—"}`,
    `last_run_at: ${task.last_run_at ?? "never"}`,
  ];
}

/** Select-list row for one run (stored or derived-missed). */
export function runSelectItem(run: RunView): SelectItem<RunView> {
  const derived = "derived" in run && run.derived === true;
  const scheduled = run.scheduled_for ?? "manual";
  const label = `${run.status}${derived ? " (derived)" : ""} · ${run.task_id} · ${scheduled}`;
  return {
    value: run,
    label,
    detail: [
      `run_id: ${run.run_id ?? "(derived — not stored)"}`,
      `trigger: ${run.trigger} · status: ${run.status}`,
      `scheduled_for: ${run.scheduled_for ?? "n/a (manual)"}`,
      `created: ${run.created_at ?? "n/a"} · started: ${run.started_at ?? "—"} · finished: ${run.finished_at ?? "—"}`,
      run.error !== null ? `error: ${run.error.code} — ${run.error.message}` : null,
    ]
      .filter((l): l is string => l !== null)
      .join("\n"),
  };
}

/** Detail lines for one run record (stored or derived). */
export function runDetailLines(run: RunView): string[] {
  const out: string[] = [];
  out.push(`run_id: ${run.run_id ?? "(derived — not a stored record)"}`);
  out.push(`task_id: ${run.task_id}`);
  out.push(`trigger: ${run.trigger} · status: ${run.status}`);
  out.push(`scheduled_for: ${run.scheduled_for ?? "n/a (manual trigger)"}`);
  if ("derived" in run && run.derived === true) {
    out.push("derived: true — owed occurrence with no stored run; `reconcile` materializes it");
  }
  out.push(`created_at: ${run.created_at ?? "n/a"}`);
  out.push(`started_at: ${run.started_at ?? "—"}`);
  out.push(`finished_at: ${run.finished_at ?? "—"}`);
  const snapshot = asRecord(run.destination_snapshot);
  if (snapshot !== null) {
    out.push(`destination_snapshot: ${JSON.stringify(snapshot)}`);
  }
  const result = asRecord(run.result);
  if (result !== null) {
    out.push(`result.summary: ${fmt(result.summary)}`);
    out.push(`result.agent_status: ${fmt(result.agent_status)}`);
    out.push(`result.agent_status_at: ${fmt(result.agent_status_at)}`);
  }
  if (run.error !== null) {
    out.push(`error: ${run.error.code} — ${run.error.message}`);
  }
  return out;
}

/**
 * Format a `runs` payload into detail lines. Derived missed entries
 * are labeled honestly (`derived`, `run_id: null`) — they are owed
 * occurrences, not stored records.
 */
export function formatRunsPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const runs = asRunViews(payload.runs);
  lines.push(`runs${payload.task ? ` — task ${fmt(payload.task)}` : ""}`);
  if (runs.length === 0) {
    lines.push("(no runs recorded)");
    return lines;
  }
  for (const run of runs) {
    const derived = "derived" in run && run.derived === true;
    lines.push(
      `${run.status}${derived ? " (derived)" : ""} — ${run.task_id} · ${run.scheduled_for ?? "manual"}`,
    );
    lines.push(`  run_id: ${run.run_id ?? "(derived)"} · trigger: ${run.trigger}`);
    if (run.error !== null) lines.push(`  error: ${run.error.code} — ${run.error.message}`);
  }
  return lines;
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof AutomationsCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
