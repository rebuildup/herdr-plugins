/**
 * Script execution engine for `rebuildup.projects` (#53, ADR-0010).
 *
 * Executes resolved project scripts in dedicated herdr panes created via
 * the Socket API (`workspace.create` → `pane.send_input` →
 * `pane.wait_for_output`). Completion is detected ONLY by a per-run
 * output marker (`__HERDR_DONE_<run-id>__=<exit code>`); exit status is
 * parsed from that marker's digits, never inferred from pane text,
 * process liveness, or pane close events. A run whose pane vanishes
 * before the marker is recorded `unknown` — never fabricated success.
 *
 * The transport is an interface so tests can drive the whole state
 * machine without a live herdr; `herdrTransport()` adapts the typed
 * wrappers in `packages/herdr-client`.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  type CallOptions,
  type OutputMatchedResult,
  type PaneInfo,
  type PaneProcessInfo,
  type PaneReadResult,
  paneClose,
  paneGet,
  paneProcessInfo,
  paneRead,
  paneSendInput,
  paneSendKeys,
  paneWaitForOutput,
  reportPaneMetadata,
  type WorkspaceCreatedResult,
  workspaceCreate,
} from "../../../packages/herdr-client/src/index";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";
import {
  loadRuns,
  type RunResult,
  type RunTrigger,
  readRunLog,
  runsDir as runsDirPath,
  type ScriptRun,
  updateRuns,
  writeRunLog,
} from "./runs";
import { PLUGIN_ID, type Project } from "./state";

// --- Transport -------------------------------------------------------------

export interface ScriptTransport {
  workspaceCreate(params: {
    cwd?: string | undefined;
    label?: string | undefined;
    focus?: boolean | undefined;
  }): Promise<WorkspaceCreatedResult>;
  paneSendInput(
    paneId: string,
    params: { text?: string | undefined; keys?: string[] | undefined },
  ): Promise<unknown>;
  paneSendKeys(paneId: string, keys: string[]): Promise<unknown>;
  paneWaitForOutput(params: {
    pane_id: string;
    source: "visible" | "recent" | "recent_unwrapped" | "detection";
    match: { type: "substring" | "regex"; value: string };
    timeout_ms?: number | undefined;
    lines?: number | undefined;
    strip_ansi?: boolean | undefined;
  }): Promise<OutputMatchedResult>;
  paneProcessInfo(paneId: string): Promise<PaneProcessInfo>;
  paneGet(paneId: string): Promise<PaneInfo>;
  paneRead(
    paneId: string,
    params: {
      source: "visible" | "recent" | "recent_unwrapped" | "detection";
      lines?: number | undefined;
    },
  ): Promise<PaneReadResult>;
  paneClose(paneId: string): Promise<unknown>;
  reportMetadata(paneId: string, tokens: Record<string, string | null>): Promise<unknown>;
}

/** Adapt the herdr-client wrappers to ScriptTransport for one invocation. */
export function herdrTransport(options: CallOptions = {}): ScriptTransport {
  return {
    workspaceCreate: (params) => workspaceCreate(params, options),
    paneSendInput: (paneId, params) => paneSendInput(paneId, params, options),
    paneSendKeys: (paneId, keys) => paneSendKeys(paneId, keys, options),
    paneWaitForOutput: (params) =>
      // The socket request must outlive the server-side wait or the client
      // gives up first; callers pass timeout_ms well under this ceiling.
      paneWaitForOutput(params, { ...options, timeoutMs: (params.timeout_ms ?? 0) + 30_000 }),
    paneProcessInfo: (paneId) => paneProcessInfo(paneId, options),
    paneGet: (paneId) => paneGet(paneId, options),
    paneRead: (paneId, params) => paneRead(paneId, { ...params, strip_ansi: true }, options),
    paneClose: (paneId) => paneClose(paneId, options),
    reportMetadata: (paneId, tokens) =>
      reportPaneMetadata(paneId, tokens, { ...options, source: PLUGIN_ID }),
  };
}

// --- Error classification --------------------------------------------------

const TIMEOUT_RE = /timeout|timed out/i;
const PANE_GONE_RE = /not_found|no_such|gone|exited|missing|closed/i;

export function isWaitTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code !== undefined && TIMEOUT_RE.test(code)) return true;
    return TIMEOUT_RE.test(err.message);
  }
  return false;
}

export function isPaneGoneError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code !== undefined && PANE_GONE_RE.test(code)) return true;
    return PANE_GONE_RE.test(err.message);
  }
  return false;
}

function structuredError(message: string, kind: string): Error & { kind: string } {
  return Object.assign(new Error(message), { kind });
}

// --- Command line / marker -------------------------------------------------

export const MARKER_PREFIX = "__HERDR_DONE_";
/** Inline input cap; longer or multi-line commands go through a script file. */
export const MAX_INLINE_COMMAND_CHARS = 4_000;
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
export const DEFAULT_LOG_MAX_BYTES = 65_536;
export const DEFAULT_STOP_GRACE_MS = 2_000;

export function runMarkerToken(runId: string): string {
  return `${MARKER_PREFIX}${runId}__`;
}

/** Regex matching ONLY the marker's echoed output (`=digits`), never the
 * echoed input line (which contains literal `$?`). */
export function runMarkerRegex(runId: string): string {
  return `${MARKER_PREFIX}${runId}__=(-?\\d+)`;
}

/** Extract the LAST marker exit code from pane text; null when absent. */
export function parseMarkerExitCode(text: string, runId: string): number | null {
  const re = new RegExp(`${MARKER_PREFIX}${runId}__=(-?\\d+)`, "g");
  let last: RegExpExecArray | null = null;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    last = match;
  }
  if (last === null) return null;
  const code = Number.parseInt(last[1] as string, 10);
  return Number.isFinite(code) ? code : null;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface CommandLine {
  /** The single line sent via `pane.send_input` (Enter appended by keys). */
  line: string;
  /** Absolute script-file path when the command could not be inlined. */
  scriptPath: string | null;
}

/**
 * Build the injected line. The marker suffix is appended to the SAME input
 * line so `cmd; echo MARKER=$?` reports the command's own exit status.
 * Commands containing newlines or exceeding the inline cap are written to
 * an executable `/bin/sh` script file under the runs dir and invoked by
 * path (documented POSIX-sh limitation for that edge case).
 */
export async function buildCommandLine(
  runId: string,
  command: string,
  dir: string,
): Promise<CommandLine> {
  const token = runMarkerToken(runId);
  const suffix = `; echo ${token}=$?`;
  if (!command.includes("\n") && command.length + suffix.length <= MAX_INLINE_COMMAND_CHARS) {
    return { line: `${command}${suffix}`, scriptPath: null };
  }
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const scriptPath = `${dir}/${runId}.sh`;
  await writeFile(scriptPath, `#!/bin/sh\n${command}\n`);
  await chmod(scriptPath, 0o755);
  return { line: `${shQuote(scriptPath)}${suffix}`, scriptPath };
}

// --- Run record helpers ----------------------------------------------------

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Metadata token name `script_<slug>`, capped at herdr's 32-char limit. */
export function scriptTokenName(scriptName: string): string {
  const slug = scriptName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `script_${slug || "unnamed"}`;
  return base.slice(0, 32).replace(/-+$/, "");
}

function stateDir(): string {
  return pluginDirs(PLUGIN_ID).stateDir;
}

/** Store paths in run records relative to the plugin state dir. */
function relativeToStateDir(file: string): string {
  return path.relative(stateDir(), file).split(path.sep).join("/");
}

async function reportRunState(deps: RunnerDeps, run: ScriptRun, state: RunResult): Promise<void> {
  try {
    await deps.transport.reportMetadata(run.pane_id, {
      [scriptTokenName(run.script.name)]: state,
    });
  } catch {
    // Metadata is display-only; a projection failure must not fail a run.
  }
}

export interface RunnerDeps {
  transport: ScriptTransport;
  /** Wait ceiling for the completion marker (server-side + client). */
  waitTimeoutMs?: number | undefined;
  /** Byte cap for persisted run logs (tail kept). */
  logMaxBytes?: number | undefined;
  /** Grace period between ctrl+c and pane.close on stop. */
  stopGraceMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

interface ResolvedDeps {
  waitTimeoutMs: number;
  logMaxBytes: number;
  stopGraceMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function resolveDeps(deps: RunnerDeps): ResolvedDeps {
  return {
    waitTimeoutMs: deps.waitTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    logMaxBytes: deps.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES,
    stopGraceMs: deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? (() => new Date()),
  };
}

function iso(d: ResolvedDeps): string {
  return d.now().toISOString();
}

async function captureLog(d: ResolvedDeps, run: ScriptRun, text: string | null): Promise<void> {
  if (text === null || text.length === 0) return;
  const file = await writeRunLog(run.run_id, text, d.logMaxBytes);
  run.log_path = relativeToStateDir(file);
}

async function markRun(runId: string, patch: Partial<ScriptRun>): Promise<void> {
  await updateRuns((state) => {
    const existing = state.runs[runId];
    if (existing) state.runs[runId] = { ...existing, ...patch };
  });
}

// --- start -----------------------------------------------------------------

export interface StartRunInput {
  project: Project;
  /** Resolved script definition chosen by the caller. */
  script: { id: string; name: string; command: string; source: string };
  /** Canonical member repo root the script executes against. */
  repoRoot: string;
  remote: string | null;
  /**
   * Run origin (#180). Defaults to `{kind:"manual"}`; the trigger drain
   * passes `{kind:"worktree.created", worktree_path, event_received_at}`.
   */
  trigger?: RunTrigger;
}

/**
 * Create the execution surface, persist the run record, inject the
 * command, and wait for the completion marker up to `waitTimeoutMs`.
 *
 * Result semantics:
 * - marker matched → `success` (exit 0) / `failed` (non-zero), `exit_code`
 *   parsed from the marker only.
 * - wait timed out → stays `running`; the pane is left alone and
 *   `scripts results` re-checks liveness lazily. Never killed implicitly.
 * - pane vanished / gone errors → `unknown`, never success.
 * - other transport errors → stays `running` with `error` recorded.
 */
export async function startRun(input: StartRunInput, deps: RunnerDeps): Promise<ScriptRun> {
  const d = resolveDeps(deps);
  const runId = newRunId();
  const regex = runMarkerRegex(runId);

  const { line, scriptPath } = await buildCommandLine(runId, input.script.command, runsDirPath());

  const created = await deps.transport.workspaceCreate({
    cwd: input.repoRoot,
    label: `script: ${input.script.name} (${input.project.id})`,
    focus: false,
  });
  const paneId = created.root_pane.pane_id as string;
  const workspaceId =
    (created.workspace as { workspace_id?: string }).workspace_id ??
    (created.root_pane as { workspace_id?: string }).workspace_id ??
    "";
  const tabId =
    (created.tab as { tab_id?: string }).tab_id ??
    (created.root_pane as { tab_id?: string }).tab_id ??
    null;

  const run: ScriptRun = {
    run_id: runId,
    project_id: input.project.id,
    script: {
      id: input.script.id,
      name: input.script.name,
      command: input.script.command,
      source: input.script.source,
    },
    repo: { root: input.repoRoot, remote: input.remote },
    pane_id: paneId,
    workspace_id: workspaceId,
    tab_id: tabId,
    cwd: input.repoRoot,
    command_line: line,
    script_path: scriptPath === null ? null : relativeToStateDir(scriptPath),
    started_at: iso(d),
    finished_at: null,
    exit_code: null,
    result: "running",
    log_path: null,
    error: null,
    trigger: input.trigger ?? { kind: "manual" },
  };

  // Persist BEFORE injecting: a crash after this point still leaves an
  // honest record of the pane we own.
  await updateRuns((state) => {
    state.runs[runId] = run;
  });

  /** Fresh stored record; concurrent `scripts stop` may have finalized it. */
  const storedRun = async (): Promise<ScriptRun> =>
    ((await loadRuns()).runs[runId] as ScriptRun | undefined) ?? run;

  const finish = async (patch: Partial<ScriptRun>, logText: string | null): Promise<ScriptRun> => {
    if (logText !== null) await captureLog(d, run, logText);
    // Merge onto the latest stored record so a concurrent `scripts stop`
    // (or another writer) is never clobbered by this stale in-memory copy.
    await updateRuns((state) => {
      const existing = state.runs[runId];
      if (existing) {
        state.runs[runId] = {
          ...existing,
          ...patch,
          log_path: run.log_path ?? existing.log_path,
        };
      }
    });
    const fresh = await storedRun();
    await reportRunState(deps, fresh, fresh.result);
    return fresh;
  };

  try {
    await deps.transport.paneSendInput(paneId, { text: line, keys: ["Enter"] });
  } catch (err) {
    const gone = isPaneGoneError(err);
    return finish(
      {
        result: gone ? "unknown" : "running",
        finished_at: gone ? iso(d) : null,
        error: `inject failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      null,
    );
  }

  await reportRunState(deps, run, "running");

  let matched: OutputMatchedResult;
  try {
    matched = await deps.transport.paneWaitForOutput({
      pane_id: paneId,
      source: "recent_unwrapped",
      match: { type: "regex", value: regex },
      timeout_ms: d.waitTimeoutMs,
    });
  } catch (err) {
    if (isWaitTimeoutError(err)) {
      // Bounded wait elapsed: leave the run `running` — never kill
      // implicitly. `scripts results`/`logs` re-check the pane lazily.
      // A concurrent stop may already have finalized the record.
      return storedRun();
    }
    if (isPaneGoneError(err)) {
      // If another writer already finalized the record (e.g. `scripts
      // stop` closed the pane), keep its truthful terminal state.
      const stored = await storedRun();
      if (stored.result !== "running") return stored;
      return finish(
        {
          result: "unknown",
          finished_at: iso(d),
          error: err instanceof Error ? err.message : String(err),
        },
        null,
      );
    }
    // Other transport failure: outcome undetermined; keep `running` and
    // record the error rather than fabricating a result.
    const message = err instanceof Error ? err.message : String(err);
    await markRun(runId, { error: message });
    return storedRun();
  }

  const text = matched.read?.text ?? "";
  const exitCode = parseMarkerExitCode(text, runId);
  // The regex matched server-side, so digits exist; a null parse means the
  // read payload was truncated oddly — report unknown, not success.
  const result: RunResult = exitCode === null ? "unknown" : exitCode === 0 ? "success" : "failed";
  return finish(
    {
      result,
      finished_at: iso(d),
      exit_code: exitCode,
      error: exitCode === null ? "marker matched but exit code unparsable" : null,
    },
    text,
  );
}

// --- stop ------------------------------------------------------------------

export interface StopOutcome {
  run: ScriptRun;
  action: "stopped" | "already_finished" | "pane_gone";
}

/**
 * Stop every `running` run matched by `target`. `target` is a run_id
 * (exact or unique prefix) or a project id (all its running runs).
 * Only the pane_id recorded in each run record is ever addressed.
 */
export async function stopRuns(target: string, deps: RunnerDeps): Promise<StopOutcome[]> {
  const d = resolveDeps(deps);
  const state = await loadRuns();
  const all = Object.values(state.runs);

  const exact = all.find((r) => r.run_id === target);
  let matched: ScriptRun[];
  if (exact) {
    matched = [exact];
  } else {
    const byPrefix = all.filter((r) => r.run_id.startsWith(target));
    if (byPrefix.length > 1) {
      throw structuredError(`ambiguous run id prefix: ${target}`, "ambiguous_run");
    }
    if (byPrefix.length === 1) {
      matched = byPrefix;
    } else {
      matched = all.filter((r) => r.project_id === target);
    }
  }
  if (matched.length === 0) {
    throw structuredError(`no runs found for: ${target}`, "run_not_found");
  }

  const outcomes: StopOutcome[] = [];
  for (const record of matched) {
    if (record.result !== "running") {
      outcomes.push({ run: record, action: "already_finished" });
      continue;
    }
    const run = { ...record };
    try {
      await deps.transport.paneSendKeys(run.pane_id, ["ctrl+c"]);
    } catch (err) {
      if (isPaneGoneError(err)) {
        await markRun(run.run_id, {
          result: "unknown",
          finished_at: iso(d),
          error: err instanceof Error ? err.message : String(err),
        });
        const updated = (await loadRuns()).runs[run.run_id];
        if (updated) outcomes.push({ run: updated, action: "pane_gone" });
        continue;
      }
      throw err;
    }
    await d.sleep(d.stopGraceMs);
    // Best-effort log capture before closing the pane.
    try {
      const read = await deps.transport.paneRead(run.pane_id, {
        source: "recent",
        lines: 500,
      });
      await captureLog(d, run, read.text ?? null);
      await markRun(run.run_id, { log_path: run.log_path });
    } catch {
      // Pane may already be gone; the stop itself still proceeds.
    }
    try {
      await deps.transport.paneClose(run.pane_id);
    } catch {
      // Already closed/exited — the run is stopped either way.
    }
    await markRun(run.run_id, {
      result: "stopped",
      finished_at: iso(d),
      error: null,
    });
    const updated = (await loadRuns()).runs[run.run_id];
    if (updated) {
      await reportRunState(deps, updated, "stopped");
      outcomes.push({ run: updated, action: "stopped" });
    }
  }
  return outcomes;
}

// --- results / logs --------------------------------------------------------

/**
 * List run records, optionally filtered by project. `running` records are
 * reconciled lazily: `pane.get` is re-checked and a vanished pane flips
 * the record to `unknown` (persisted). Socket failures leave the record
 * `running` — liveness is unknown, not fabricated.
 */
export async function listRuns(
  deps: RunnerDeps,
  filter: { projectId?: string | undefined } = {},
): Promise<ScriptRun[]> {
  const d = resolveDeps(deps);
  const state = await loadRuns();
  const runs = Object.values(state.runs)
    .filter((r) => filter.projectId === undefined || r.project_id === filter.projectId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));

  const reconciled: ScriptRun[] = [];
  for (const run of runs) {
    if (run.result !== "running") {
      reconciled.push(run);
      continue;
    }
    try {
      await deps.transport.paneGet(run.pane_id);
      reconciled.push(run);
    } catch (err) {
      if (isPaneGoneError(err)) {
        await markRun(run.run_id, {
          result: "unknown",
          finished_at: iso(d),
          error: err instanceof Error ? err.message : String(err),
        });
        const fresh = (await loadRuns()).runs[run.run_id];
        reconciled.push(fresh ?? { ...run, result: "unknown" });
      } else {
        reconciled.push(run);
      }
    }
  }
  return reconciled;
}

export interface RunLogResult {
  run: ScriptRun;
  /** Log text (bounded tail) or null when nothing could be captured. */
  log: string | null;
  log_path: string | null;
}

/**
 * Return the stored log for a run, capturing a bounded pane tail on
 * demand when no log exists yet and the pane is still alive.
 */
export async function runLog(runId: string, deps: RunnerDeps): Promise<RunLogResult> {
  const d = resolveDeps(deps);
  const state = await loadRuns();
  const run = state.runs[runId];
  if (!run) {
    throw structuredError(`run not found: ${runId}`, "run_not_found");
  }

  const stored = await readRunLog(run.run_id);
  if (stored !== null) {
    return { run, log: stored, log_path: run.log_path };
  }

  // No stored log: try a live bounded read for still-alive panes.
  try {
    const read = await deps.transport.paneRead(run.pane_id, {
      source: "recent",
      lines: 500,
    });
    await captureLog(d, run, read.text ?? null);
    await markRun(run.run_id, { log_path: run.log_path });
    const fresh = await readRunLog(run.run_id);
    const updated = (await loadRuns()).runs[run.run_id] ?? run;
    return { run: updated, log: fresh, log_path: updated.log_path };
  } catch (err) {
    if (run.result === "running" && isPaneGoneError(err)) {
      await markRun(run.run_id, {
        result: "unknown",
        finished_at: iso(d),
        error: err instanceof Error ? err.message : String(err),
      });
      const updated = (await loadRuns()).runs[run.run_id] ?? {
        ...run,
        result: "unknown" as const,
      };
      return { run: updated, log: null, log_path: updated.log_path };
    }
    return { run, log: null, log_path: run.log_path };
  }
}
