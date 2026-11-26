/**
 * Shared helpers for the rebuildup.projects interactive TUI surface
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
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { HerdrRpcError, request, resolveTarget } from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";
import { PLUGIN_ID, type Project } from "./state";

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
  /** Origin cwd — a repo-registration hint only, never auto-applied. */
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

// --- pane opening (open action → plugin.pane.open) ---------------------------

/**
 * Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
 * `tab` per the tui-v1 placement policy: the projects registry is a
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
 * Open the projects TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openProjectsPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/projects`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/projects
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the projects CLI subprocess. */
export class ProjectsCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "ProjectsCliError";
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
  let message = `projects cli exited ${exitCode} with no JSON output`;
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
  throw new ProjectsCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 */
export function runProjectsCli(
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
      finish(() => reject(new ProjectsCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new ProjectsCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
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
      finish(() => reject(new ProjectsCliError(String(err), "cli_spawn_error")));
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
 * (e.g. "repos add", "settings set", "scripts run").
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

/** Select-list row for one registry project. */
export function projectSelectItem(project: Project): SelectItem<Project> {
  const badges = [project.pinned ? "pinned" : null, project.archived ? "archived" : null].filter(
    (b): b is string => b !== null,
  );
  const suffix = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
  const repos = project.repos.length;
  return {
    value: project,
    label: `${project.title} (${project.id})${suffix}`,
    detail: [
      `id: ${project.id}`,
      `title: ${project.title}`,
      `repos: ${repos}`,
      ...project.repos.map((r) => `  ${r.root}${r.remote !== null ? ` ← ${r.remote}` : ""}`),
      `pinned: ${project.pinned} · archived: ${project.archived}`,
      `created: ${project.created_at}`,
      `updated: ${project.updated_at}`,
    ].join("\n"),
  };
}

/** Header lines describing one project (detail view top section). */
export function projectHeaderLines(project: Project): string[] {
  return [
    `id: ${project.id}`,
    `title: ${project.title}`,
    `pinned: ${project.pinned} · archived: ${project.archived}`,
    `repos: ${project.repos.length}`,
    `created: ${project.created_at}`,
    `updated: ${project.updated_at}`,
  ];
}

interface WorktreePaneJson {
  pane_id?: unknown;
  cwd?: unknown;
  status?: unknown;
  status_error?: unknown;
}

interface WorktreeJson {
  path?: unknown;
  branch?: unknown;
  dirty?: unknown;
  open_workspace_id?: unknown;
  panes_unavailable?: unknown;
  panes?: unknown;
}

function formatWorktreeLines(wt: WorktreeJson): string[] {
  const pathValue = fmt(wt.path);
  const flags = [
    wt.branch !== null && wt.branch !== undefined ? `branch ${fmt(wt.branch)}` : null,
    wt.dirty === true ? "dirty" : wt.dirty === false ? "clean" : "dirty unknown",
    wt.open_workspace_id ? `ws ${fmt(wt.open_workspace_id)}` : "not open",
  ].filter((f): f is string => f !== null);
  const lines = [`  worktree ${pathValue} — ${flags.join(" · ")}`];
  const panes = Array.isArray(wt.panes) ? (wt.panes as WorktreePaneJson[]) : [];
  if (wt.panes_unavailable === true) {
    lines.push("    panes: unavailable (stale workspace id or unreachable snapshot)");
  }
  for (const pane of panes) {
    const paneId = fmt(pane.pane_id);
    const cwd = typeof pane.cwd === "string" ? ` cwd ${pane.cwd}` : "";
    const status = asRecord(pane.status);
    const branch = status !== null ? fmt(status.branch) : "no status";
    const serr = asRecord(pane.status_error);
    const statusText =
      status !== null
        ? `status ok (branch ${branch})`
        : `status error: ${fmt(serr?.kind ?? "unknown")}`;
    lines.push(`    pane ${paneId}${cwd} — ${statusText}`);
  }
  return lines;
}

/**
 * Format a `repos list <project>` payload for a read-only detail view.
 * Every absent/unreachable field renders as `unknown`/explicit error —
 * nothing is fabricated (contract item 9).
 */
export function formatReposPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const projectId = fmt(payload.project_id);
  lines.push(`repos list — project ${projectId}`);
  const repos = asArray(payload.repos);
  if (repos.length === 0) {
    lines.push("(no registered repos)");
  }
  for (const repo of repos) {
    lines.push(`repo ${fmt(repo.root)}`);
    lines.push(`  remote: ${fmt(repo.remote)} · added: ${fmt(repo.added_at)}`);
    lines.push(
      `  branch: ${fmt(repo.branch)} · dirty: ${fmt(repo.dirty)} · submodules: ${fmt(repo.has_submodules)}`,
    );
    const wtsError = asRecord(repo.worktrees_error);
    if (wtsError !== null) {
      lines.push(
        `  worktrees: unavailable (${fmt(wtsError.reason)}${typeof wtsError.detail === "string" ? ` — ${wtsError.detail}` : ""})`,
      );
    } else if (repo.worktrees === null || repo.worktrees === undefined) {
      lines.push("  worktrees: unknown");
    } else {
      const worktrees = Array.isArray(repo.worktrees) ? (repo.worktrees as WorktreeJson[]) : [];
      if (worktrees.length === 0) {
        lines.push("  worktrees: none reported by herdr");
      }
      for (const wt of worktrees) lines.push(...formatWorktreeLines(wt));
    }
  }
  for (const skip of asArray(payload.skipped)) {
    lines.push(`skipped ${fmt(skip.root)} — ${fmt(skip.reason)}`);
  }
  for (const skip of asArray(payload.worktrees_skipped)) {
    const detail = typeof skip.detail === "string" ? ` — ${skip.detail}` : "";
    lines.push(`worktree skipped ${fmt(skip.path)} — ${fmt(skip.reason)}${detail}`);
  }
  return lines;
}

/** Format a `scripts list <project>` payload (resolved script defs). */
export function formatScriptsPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`scripts — project ${fmt(payload.project_id)} · repo ${fmt(payload.repo_root)}`);
  const scripts = asArray(payload.scripts);
  if (scripts.length === 0) {
    lines.push("(no scripts resolved)");
    return lines;
  }
  for (const s of scripts) {
    const flags = [
      s.runOnWorktreeCreate === true ? "runOnWorktreeCreate" : null,
      s.runOnSettle === true ? "runOnSettle" : null,
      s.stopOnSettle === true ? "stopOnSettle" : null,
    ].filter((f): f is string => f !== null);
    const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    lines.push(`${fmt(s.name)} (${fmt(s.id)})${suffix}`);
    lines.push(`  command: ${fmt(s.command)}`);
    lines.push(`  source: ${fmt(s.source)}`);
  }
  return lines;
}

/** Format a `scripts results [project]` payload (run records). */
export function formatRunsPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`script runs${payload.project_id ? ` — project ${fmt(payload.project_id)}` : ""}`);
  const runs = asArray(payload.runs);
  if (runs.length === 0) {
    lines.push("(no runs recorded)");
    return lines;
  }
  for (const run of runs) {
    const script = asRecord(run.script) ?? {};
    const repo = asRecord(run.repo) ?? {};
    lines.push(
      `${fmt(run.run_id)} — ${fmt(script.name)} → ${fmt(run.result)} (exit ${fmt(run.exit_code)})`,
    );
    lines.push(
      `  repo ${fmt(repo.root)} · pane ${fmt(run.pane_id)} · started ${fmt(run.started_at)}`,
    );
    if (typeof run.finished_at === "string") lines.push(`  finished ${run.finished_at}`);
    if (typeof run.error === "string" && run.error !== "") lines.push(`  error: ${run.error}`);
    const trigger = asRecord(run.trigger);
    if (trigger !== null) lines.push(`  trigger: ${fmt(trigger.kind)}`);
  }
  return lines;
}

/** Format a `discover` payload: candidate repos + honestly-skipped cwds. */
export function formatDiscoverPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push("discover — repos reachable from session pane cwds");
  const repos = asArray(payload.repos);
  if (repos.length === 0) lines.push("(no repos discovered)");
  for (const repo of repos) {
    const owner =
      repo.registered_project_id === null || repo.registered_project_id === undefined
        ? "unregistered"
        : `registered → ${fmt(repo.registered_project_id)}`;
    lines.push(`${fmt(repo.root)} — ${owner}`);
  }
  for (const skip of asArray(payload.skipped)) {
    lines.push(`skipped ${fmt(skip.cwd)} — ${fmt(skip.reason)}`);
  }
  return lines;
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof ProjectsCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
