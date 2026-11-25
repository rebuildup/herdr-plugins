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
import os from "node:os";
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
  sessionKeyFor,
  type WorkspaceCreatedResult,
  workspaceCreate,
} from "../../../packages/herdr-client/src/index";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";
import {
  ACTIVE_RUN_RESULTS,
  loadRuns,
  type RunResult,
  readRunLog,
  runsDir as runsDirPath,
  type ScriptRun,
  type ShellFamily,
  type ShellSource,
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
/** Bounded window to confirm a stop request actually ended the process. */
export const DEFAULT_STOP_CONFIRM_MS = 5_000;
/** Hard cap on stop-confirmation polls regardless of configured timings. */
const MAX_STOP_CONFIRM_ATTEMPTS = 20;

export function runMarkerToken(runId: string): string {
  return `${MARKER_PREFIX}${runId}__`;
}

/** Regex matching ONLY the marker's echoed output (`=digits`), never the
 * echoed input line (which contains the family-specific rc expression,
 * never bare digits). Identical across shell families (#67): every
 * wrapper prints `__HERDR_DONE_<id>__=<integer>`. */
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

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// --- Shell family detection (#67) ------------------------------------------
//
// `scripts run` injects into whatever shell the dedicated pane spawned.
// The completion-marker line is shell-specific, so the family must be
// known BEFORE composing the command line. Sources, in precedence order:
//   1. explicit `--shell` flag (`auto` disables the override),
//   2. `pane.process_info` foreground process name,
//   3. conservative host-OS default (`win32` → cmd, else sh) — recorded
//      as `shell_source:"host_default"` so the fallback is never silent.
// A foreground process that is positively NOT a shell fails
// `not_a_shell`; a recognized-but-unsupported shell (fish, nu, …) fails
// `shell_unknown`. The runner never guesses a wrong-shell wrapper.

/** `--shell` values accepted by `scripts run`. */
export type ShellOverride = "auto" | ShellFamily;

export const SHELL_OVERRIDE_VALUES: readonly ShellOverride[] = ["auto", "sh", "cmd", "powershell"];

/** POSIX-family shells whose `$?` exit-status syntax the `sh` wrapper uses. */
const SH_SHELL_NAMES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "mksh",
  "ksh93",
  "yash",
]);
const CMD_SHELL_NAMES: ReadonlySet<string> = new Set(["cmd"]);
const POWERSHELL_NAMES: ReadonlySet<string> = new Set(["powershell", "pwsh"]);
/** Recognized shells with syntax the wrappers do not support. */
const UNSUPPORTED_SHELL_NAMES: ReadonlySet<string> = new Set([
  "fish",
  "nu",
  "xonsh",
  "elvish",
  "tcsh",
  "csh",
]);

/** Bounded retries while a fresh pane's shell reaches the foreground. */
const SHELL_DETECT_ATTEMPTS = 3;
const SHELL_DETECT_DELAY_MS = 150;

function baseName(value: string): string {
  const tail = value.split(/[\\/]/).pop() ?? value;
  return tail.toLowerCase().replace(/\.exe$/, "");
}

/** Candidate executable names for one foreground process entry. */
function processNameCandidates(proc: {
  name?: string | undefined;
  argv0?: string | null | undefined;
  cmdline?: string | null | undefined;
}): string[] {
  const out: string[] = [];
  if (typeof proc.name === "string" && proc.name.length > 0) out.push(proc.name);
  if (typeof proc.argv0 === "string" && proc.argv0.length > 0) out.push(proc.argv0);
  if (typeof proc.cmdline === "string" && proc.cmdline.length > 0) {
    out.push(proc.cmdline.trim().split(/\s+/)[0] ?? "");
  }
  return out.map(baseName).filter((n) => n.length > 0);
}

type NameVerdict = ShellFamily | "unsupported_shell" | null;

function classifyShellName(name: string): NameVerdict {
  if (SH_SHELL_NAMES.has(name)) return "sh";
  if (CMD_SHELL_NAMES.has(name)) return "cmd";
  if (POWERSHELL_NAMES.has(name)) return "powershell";
  if (UNSUPPORTED_SHELL_NAMES.has(name)) return "unsupported_shell";
  return null;
}

export interface ShellDetection {
  family: ShellFamily;
  source: ShellSource;
}

/**
 * Determine the pane's shell family. Throws structured errors
 * (`shell_unknown` / `not_a_shell`) when the foreground process is
 * positively identified as an unsupported shell or a non-shell; falls
 * back to the host-OS default only when detection is inconclusive
 * (empty foreground, `process_info` transport failure).
 */
export async function detectShellFamily(
  transport: ScriptTransport,
  paneId: string,
  opts: {
    override?: ShellOverride | undefined;
    /** `os.platform()` of the host running the herdr session. */
    platform: string;
    sleep?: ((ms: number) => Promise<void>) | undefined;
    attempts?: number | undefined;
  },
): Promise<ShellDetection> {
  if (opts.override !== undefined && opts.override !== "auto") {
    return { family: opts.override, source: "flag" };
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, opts.attempts ?? SHELL_DETECT_ATTEMPTS);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let info: PaneProcessInfo;
    try {
      info = await transport.paneProcessInfo(paneId);
    } catch {
      // Transport failure is inconclusive, not proof of a non-shell:
      // fall through to the documented host-OS default.
      break;
    }
    const procs = info.foreground_processes;
    if (procs.length === 0) {
      if (attempt + 1 < attempts) await sleep(SHELL_DETECT_DELAY_MS);
      continue;
    }
    // The pane's own shell is `shell_pid` when reported; prefer it, then
    // scan the rest of the foreground group for any recognizable shell.
    const ordered = [...procs].sort((a, b) => {
      const ap = info.shell_pid !== null && a.pid === info.shell_pid ? 0 : 1;
      const bp = info.shell_pid !== null && b.pid === info.shell_pid ? 0 : 1;
      return ap - bp;
    });
    let unsupported: string | null = null;
    for (const proc of ordered) {
      for (const candidate of processNameCandidates(proc)) {
        const verdict = classifyShellName(candidate);
        if (typeof verdict === "string" && verdict !== "unsupported_shell") {
          return { family: verdict, source: "process_info" };
        }
        if (verdict === "unsupported_shell" && unsupported === null) {
          unsupported = candidate;
        }
      }
    }
    if (unsupported !== null) {
      throw structuredError(
        `pane shell is not supported by scripts run: ${unsupported} ` +
          `(supported: sh-family, cmd, powershell; override with --shell)`,
        "shell_unknown",
      );
    }
    // Non-empty foreground with no recognizable shell → the pane is not
    // running a supported shell; never guess a wrapper.
    const names = procs
      .flatMap((p) => processNameCandidates(p))
      .slice(0, 3)
      .join(", ");
    throw structuredError(
      `pane foreground is not a supported shell (processes: ${names || "unknown"}); ` +
        `refusing to guess a wrapper — pass --shell to override`,
      "not_a_shell",
    );
  }
  // Inconclusive detection → documented conservative default.
  return {
    family: opts.platform === "win32" ? "cmd" : "sh",
    source: "host_default",
  };
}

// --- Command line / marker -------------------------------------------------

export interface CommandLine {
  /**
   * Lines sent via `pane.send_input` (Enter appended per line). Always
   * two entries: the user command (or script-file invocation) followed
   * by the marker echo line. Sending them as separate input lines —
   * each its own parsed command — avoids cmd.exe's parse-time
   * `%ERRORLEVEL%` expansion pitfall and works uniformly across
   * sh/cmd/powershell.
   */
  lines: string[];
  /** Absolute script-file path when the command could not be inlined. */
  scriptPath: string | null;
}

/**
 * Marker echo line per shell family. Each is a separate input line, so
 * the rc expression is evaluated AFTER the user command finished:
 * - sh: `$?` (POSIX exit status).
 * - cmd: `%ERRORLEVEL%` expands when THIS line is parsed — correct
 *   because it is its own command line, not `cmd1 & echo ...` on one.
 * - powershell: `$LASTEXITCODE` covers native commands; for cmdlet-only
 *   scripts it is `$null`, so fall back to `$?` (boolean → 0/1). The
 *   subexpression keeps the whole thing one line.
 */
export function markerLine(family: ShellFamily, runId: string): string {
  const token = runMarkerToken(runId);
  switch (family) {
    case "cmd":
      return `echo ${token}=%ERRORLEVEL%`;
    case "powershell":
      return `echo "${token}=$( if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } )"`;
    case "sh":
      return `echo ${token}=$?`;
  }
}

function scriptFileFor(family: ShellFamily, runId: string, dir: string): string {
  switch (family) {
    case "cmd":
      return path.join(dir, `${runId}.cmd`);
    case "powershell":
      return path.join(dir, `${runId}.ps1`);
    case "sh":
      return path.join(dir, `${runId}.sh`);
  }
}

function scriptContent(family: ShellFamily, command: string): string {
  switch (family) {
    case "cmd":
      // .cmd batch files are line-oriented; CRLF is the safe encoding.
      return `${command.replace(/\r\n|\r|\n/g, "\r\n")}\r\n`;
    case "powershell":
      return `${command}\n`;
    case "sh":
      return `#!/bin/sh\n${command}\n`;
  }
}

/** Short invocation line that runs the script file under its family. */
function scriptInvokeLine(family: ShellFamily, scriptPath: string): string {
  switch (family) {
    case "cmd":
      return `call "${scriptPath}"`;
    case "powershell":
      return `& ${psQuote(scriptPath)}`;
    case "sh":
      return `sh ${shQuote(scriptPath)}`;
  }
}

/**
 * Build the injected input lines for one shell family. The user command
 * (or a script-file invocation for newline/>`MAX_INLINE_COMMAND_CHARS`
 * commands) is line 1; the family-specific marker echo is line 2.
 * Script files live under the runs dir (`<runId>.sh|.cmd|.ps1`) and are
 * retained like run logs — they are the audit trail for what ran.
 */
export async function buildCommandLine(
  runId: string,
  command: string,
  dir: string,
  family: ShellFamily,
): Promise<CommandLine> {
  const marker = markerLine(family, runId);
  if (!command.includes("\n") && command.length + marker.length + 1 <= MAX_INLINE_COMMAND_CHARS) {
    return { lines: [command, marker], scriptPath: null };
  }
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const scriptPath = scriptFileFor(family, runId, dir);
  await writeFile(scriptPath, scriptContent(family, command));
  if (family === "sh") await chmod(scriptPath, 0o755);
  return { lines: [scriptInvokeLine(family, scriptPath), marker], scriptPath };
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
  /** Bounded window confirming the process actually exited after stop. */
  stopConfirmMs?: number | undefined;
  /**
   * Session discriminator (`sessionKeyFor`) of the socket this transport
   * talks to; recorded on new runs and checked before every pane action.
   * Defaults to the ambient socket resolution.
   */
  sessionKey?: string | undefined;
  /** Hostname recorded on new runs; defaults to `os.hostname()`. */
  host?: string | undefined;
  /**
   * Host platform (`os.platform()`) used for the conservative
   * shell-family fallback when `pane.process_info` detection is
   * inconclusive. Injectable for tests.
   */
  platform?: string | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

interface ResolvedDeps {
  waitTimeoutMs: number;
  logMaxBytes: number;
  stopGraceMs: number;
  stopConfirmMs: number;
  sessionKey: string;
  host: string;
  platform: string;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function resolveDeps(deps: RunnerDeps): ResolvedDeps {
  return {
    waitTimeoutMs: deps.waitTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    logMaxBytes: deps.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES,
    stopGraceMs: deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    stopConfirmMs: deps.stopConfirmMs ?? DEFAULT_STOP_CONFIRM_MS,
    sessionKey: deps.sessionKey ?? sessionKeyFor({}),
    host: deps.host ?? os.hostname(),
    platform: deps.platform ?? os.platform(),
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

// --- Pane ownership re-validation (#66) ------------------------------------
//
// herdr socket panes carry no server-side ownership token (ADR-0010), so
// before ANY input/close/read targeted at a recorded pane the plugin
// re-validates the ownership tuple persisted at creation:
//   host + session_key (which herdr session/socket the pane lives in)
//   + pane_id (never reused by herdr) + workspace_id/tab_id context.
// A mismatch or `pane_not_found` means the recorded pane is stale or the
// id now resolves to a foreign pane — the plugin must NEVER send input
// or close in that case.

export type PaneOwnership =
  | { kind: "owned"; pane: PaneInfo }
  | { kind: "gone" }
  | { kind: "foreign"; detail: string }
  | { kind: "pane_mismatch"; detail: string }
  | { kind: "unreachable"; error: unknown };

function paneContextMismatch(run: ScriptRun, pane: PaneInfo): string | null {
  if (typeof pane.pane_id === "string" && pane.pane_id !== run.pane_id) {
    return `pane_id mismatch: recorded ${run.pane_id}, got ${pane.pane_id}`;
  }
  if (
    run.workspace_id.length > 0 &&
    typeof pane.workspace_id === "string" &&
    pane.workspace_id !== run.workspace_id
  ) {
    return `workspace mismatch: recorded ${run.workspace_id}, got ${pane.workspace_id}`;
  }
  if (run.workspace_id.length > 0 && typeof pane.workspace_id !== "string") {
    return `workspace unverifiable: recorded ${run.workspace_id}, pane.get returned none`;
  }
  if (run.tab_id !== null && typeof pane.tab_id === "string" && pane.tab_id !== run.tab_id) {
    return `tab mismatch: recorded ${run.tab_id}, got ${pane.tab_id}`;
  }
  if (run.tab_id !== null && typeof pane.tab_id !== "string") {
    return `tab unverifiable: recorded ${run.tab_id}, pane.get returned none`;
  }
  return null;
}

/**
 * Verify that `run`'s recorded pane is still the pane this transport's
 * session owns. `foreign` (host/session_key recorded and different)
 * short-circuits BEFORE any socket call — a same-named pane id in another
 * session is a different pane. `pane_mismatch` means `pane.get`
 * succeeded but the returned pane's workspace/tab context disagrees with
 * the record (defensive: herdr documents pane ids as never reused).
 */
async function checkPaneOwnership(
  run: ScriptRun,
  d: ResolvedDeps,
  transport: ScriptTransport,
): Promise<PaneOwnership> {
  if (run.host !== null && run.host !== d.host) {
    return {
      kind: "foreign",
      detail: `host mismatch: recorded ${run.host}, current ${d.host}`,
    };
  }
  if (run.session_key !== null && run.session_key !== d.sessionKey) {
    return {
      kind: "foreign",
      detail: `session mismatch: run belongs to a different herdr session/socket`,
    };
  }
  let pane: PaneInfo;
  try {
    pane = await transport.paneGet(run.pane_id);
  } catch (err) {
    if (isPaneGoneError(err)) return { kind: "gone" };
    return { kind: "unreachable", error: err };
  }
  const mismatch = paneContextMismatch(run, pane);
  if (mismatch !== null) return { kind: "pane_mismatch", detail: mismatch };
  return { kind: "owned", pane };
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
   * `--shell` override: `auto` (default) detects via `pane.process_info`
   * with a host-OS fallback; `sh`/`cmd`/`powershell` force the family.
   */
  shell?: ShellOverride | undefined;
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

  // Shell family must be known before composing the marker line (#67).
  // A structured detection failure closes the fresh pane and aborts —
  // no run record, no guessed wrapper, no orphaned input.
  let detection: ShellDetection;
  try {
    detection = await detectShellFamily(deps.transport, paneId, {
      override: input.shell,
      platform: d.platform,
      sleep: d.sleep,
    });
  } catch (err) {
    try {
      await deps.transport.paneClose(paneId);
    } catch {
      // Best-effort cleanup; the structured error is what matters.
    }
    throw err;
  }

  const { lines, scriptPath } = await buildCommandLine(
    runId,
    input.script.command,
    runsDirPath(),
    detection.family,
  );

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
    command_line: lines.join("\n"),
    script_path: scriptPath === null ? null : relativeToStateDir(scriptPath),
    shell_family: detection.family,
    shell_source: detection.source,
    started_at: iso(d),
    finished_at: null,
    exit_code: null,
    result: "running",
    host: d.host,
    session_key: d.sessionKey,
    stop_requested_at: null,
    log_path: null,
    error: null,
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
    // Two input lines per run: the command (or script invocation), then
    // the marker echo. The shell queues line 2 behind line 1, so the rc
    // expression is evaluated only after the command finishes — and each
    // line is parsed separately, which is what makes cmd.exe's
    // `%ERRORLEVEL%` correct here.
    for (const text of lines) {
      await deps.transport.paneSendInput(paneId, { text, keys: ["Enter"] });
    }
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
  action: "stopped" | "already_finished" | "pane_gone" | "stale_pane" | "stop_unconfirmed";
}

/** Results `scripts stop` will still act on (request or confirm a stop). */
const STOPPABLE_RESULTS: ReadonlySet<RunResult> = ACTIVE_RUN_RESULTS;

/**
 * Confirm a stop request actually ended the process, bounded by
 * `stopConfirmMs`. Evidence accepted (never inferred from ctrl+c alone):
 * the pane is gone (`pane.get` → not_found) OR `pane.process_info`
 * reports an empty foreground process list (shell regained the tty).
 * Transport errors during polling are inconclusive, not fatal — the
 * bounded window decides.
 */
async function confirmStop(
  d: ResolvedDeps,
  run: ScriptRun,
  transport: ScriptTransport,
): Promise<"stopped" | "unconfirmed"> {
  const interval = Math.max(d.stopGraceMs, 1);
  const attempts = Math.max(
    1,
    Math.min(MAX_STOP_CONFIRM_ATTEMPTS, Math.ceil(d.stopConfirmMs / interval)),
  );
  for (let i = 0; i < attempts; i += 1) {
    try {
      await transport.paneGet(run.pane_id);
    } catch (err) {
      if (isPaneGoneError(err)) return "stopped";
      // Unreachable socket: inconclusive; keep polling within the bound.
    }
    try {
      const info = await transport.paneProcessInfo(run.pane_id);
      if (info.foreground_processes.length === 0) return "stopped";
    } catch (err) {
      if (isPaneGoneError(err)) return "stopped";
      // Inconclusive; keep polling.
    }
    if (i + 1 < attempts) await d.sleep(interval);
  }
  return "unconfirmed";
}

/**
 * Stop every active run matched by `target`. `target` is a run_id
 * (exact or unique prefix) or a project id (all its stoppable runs).
 *
 * Ownership is re-validated via `pane.get` BEFORE any input/close/read:
 * a foreign-session record or a mismatched pane context yields a
 * `stale_pane` outcome and ZERO side effects on the pane. A `running`
 * run is sent ctrl+c and recorded `stopping` (request accepted — NOT
 * yet stopped); exit is confirmed within `stopConfirmMs` via pane
 * absence or an empty foreground process list, then recorded `stopped`.
 * Without evidence inside the window the run is `stop_unconfirmed` —
 * ctrl+c alone is never treated as stopped.
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
    if (!STOPPABLE_RESULTS.has(record.result)) {
      outcomes.push({ run: record, action: "already_finished" });
      continue;
    }

    // Ownership gate: no input/close/read may reach a pane whose
    // recorded host/session/pane context does not verify.
    const ownership = await checkPaneOwnership(record, d, deps.transport);
    if (ownership.kind === "foreign") {
      // The record belongs to another host/session: leave the result
      // untouched (a later correctly-scoped invocation can still act)
      // but record why nothing happened.
      await markRun(record.run_id, { error: ownership.detail });
      const fresh = (await loadRuns()).runs[record.run_id];
      if (fresh) outcomes.push({ run: fresh, action: "stale_pane" });
      continue;
    }
    if (ownership.kind === "pane_mismatch") {
      // Same session but the pane id now resolves to a different
      // workspace/tab context: the recorded pane is gone → unknown.
      await markRun(record.run_id, {
        result: "unknown",
        finished_at: iso(d),
        error: `stale_pane: ${ownership.detail}`,
      });
      const fresh = (await loadRuns()).runs[record.run_id];
      if (fresh) outcomes.push({ run: fresh, action: "stale_pane" });
      continue;
    }
    if (ownership.kind === "unreachable") {
      throw ownership.error instanceof Error
        ? ownership.error
        : structuredError(String(ownership.error), "script_run_error");
    }
    if (ownership.kind === "gone") {
      // The dedicated pane vanished. For a `running` run the outcome is
      // undetermined → unknown. For stopping/stop_unconfirmed the pane
      // being gone IS the exit evidence → stopped.
      const result: RunResult = record.result === "running" ? "unknown" : "stopped";
      await markRun(record.run_id, {
        result,
        finished_at: iso(d),
        error: result === "unknown" ? "pane gone before stop could be confirmed" : null,
      });
      const fresh = (await loadRuns()).runs[record.run_id];
      if (fresh) {
        if (result === "stopped") await reportRunState(deps, fresh, "stopped");
        outcomes.push({ run: fresh, action: result === "stopped" ? "stopped" : "pane_gone" });
      }
      continue;
    }

    const run = { ...record };
    try {
      // Only `running` needs the interrupt; `stopping`/`stop_unconfirmed`
      // retries go straight to close+confirm (ctrl+c was already sent).
      if (record.result === "running") {
        await deps.transport.paneSendKeys(run.pane_id, ["ctrl+c"]);
        await markRun(run.run_id, {
          result: "stopping",
          stop_requested_at: iso(d),
          error: null,
        });
        const stopping = (await loadRuns()).runs[run.run_id];
        if (stopping) await reportRunState(deps, stopping, "stopping");
      }
    } catch (err) {
      if (isPaneGoneError(err)) {
        await markRun(run.run_id, {
          result: record.result === "running" ? "unknown" : "stopped",
          finished_at: iso(d),
          error: err instanceof Error ? err.message : String(err),
        });
        const fresh = (await loadRuns()).runs[run.run_id];
        if (fresh) {
          const action = fresh.result === "stopped" ? "stopped" : "pane_gone";
          if (action === "stopped") await reportRunState(deps, fresh, "stopped");
          outcomes.push({ run: fresh, action });
        }
        continue;
      }
      throw err;
    }

    await d.sleep(d.stopGraceMs);
    // Best-effort log capture before closing the pane (ownership was
    // verified above; a mid-stop pane loss is tolerated).
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
      // Close failure is NOT proof of stop — confirmation below decides.
    }

    const confirmed = await confirmStop(d, run, deps.transport);
    if (confirmed === "stopped") {
      await markRun(run.run_id, {
        result: "stopped",
        finished_at: iso(d),
        error: null,
      });
      const fresh = (await loadRuns()).runs[run.run_id];
      if (fresh) {
        await reportRunState(deps, fresh, "stopped");
        outcomes.push({ run: fresh, action: "stopped" });
      }
    } else {
      // Never claim stopped without evidence: the process may still be
      // running. `scripts results`/`logs` keep re-checking ownership.
      const error =
        "stop_unconfirmed: no pane-exit or foreground-process evidence within the confirmation window";
      await markRun(run.run_id, { result: "stop_unconfirmed", error });
      const fresh = (await loadRuns()).runs[run.run_id];
      if (fresh) {
        await reportRunState(deps, fresh, "stop_unconfirmed");
        outcomes.push({ run: fresh, action: "stop_unconfirmed" });
      }
    }
  }
  return outcomes;
}

// --- results / logs --------------------------------------------------------

/**
 * Promote a `stopping`/`stop_unconfirmed` record to `stopped` when exit
 * evidence appears (pane gone or empty foreground process list), or keep
 * it active. Returns the result to persist, or null to leave unchanged.
 */
async function reconcileStopState(
  run: ScriptRun,
  transport: ScriptTransport,
): Promise<RunResult | null> {
  try {
    await transport.paneGet(run.pane_id);
  } catch (err) {
    if (isPaneGoneError(err)) return "stopped";
    return null; // unreachable: liveness unknown, keep the record
  }
  try {
    const info = await transport.paneProcessInfo(run.pane_id);
    if (info.foreground_processes.length === 0) return "stopped";
  } catch (err) {
    if (isPaneGoneError(err)) return "stopped";
    return null;
  }
  return null;
}

/**
 * List run records, optionally filtered by project. Active records
 * (`running`/`stopping`/`stop_unconfirmed`) are reconciled lazily AFTER
 * ownership re-validation (#66):
 * - foreign host/session records are never touched through this socket
 *   (error annotated, result preserved for the owning session);
 * - a vanished pane flips `running` → `unknown`, and confirms
 *   `stopping`/`stop_unconfirmed` → `stopped` (pane absence IS the exit
 *   evidence once a stop was requested);
 * - a pane whose workspace/tab context disagrees with the record is
 *   `unknown` — the recorded pane is gone;
 * - socket failures leave the record unchanged — liveness is unknown,
 *   not fabricated.
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
    if (!ACTIVE_RUN_RESULTS.has(run.result)) {
      reconciled.push(run);
      continue;
    }
    const ownership = await checkPaneOwnership(run, d, deps.transport);
    if (ownership.kind === "foreign") {
      // Never probe a foreign pane; annotate why and preserve the result
      // so the owning session's invocation can still reconcile it.
      if (run.error !== ownership.detail) {
        await markRun(run.run_id, { error: ownership.detail });
      }
      const fresh = (await loadRuns()).runs[run.run_id];
      reconciled.push(fresh ?? { ...run, error: ownership.detail });
      continue;
    }
    if (ownership.kind === "unreachable") {
      reconciled.push(run);
      continue;
    }
    if (ownership.kind === "pane_mismatch") {
      await markRun(run.run_id, {
        result: "unknown",
        finished_at: iso(d),
        error: `stale_pane: ${ownership.detail}`,
      });
      const fresh = (await loadRuns()).runs[run.run_id];
      reconciled.push(fresh ?? { ...run, result: "unknown" });
      continue;
    }
    if (ownership.kind === "gone") {
      // running → outcome undetermined (unknown); stopping states → the
      // pane being gone confirms the stop (stopped).
      const result: RunResult = run.result === "running" ? "unknown" : "stopped";
      await markRun(run.run_id, {
        result,
        finished_at: iso(d),
        error: result === "unknown" ? (run.error ?? "pane gone before completion marker") : null,
      });
      const fresh = (await loadRuns()).runs[run.run_id];
      reconciled.push(fresh ?? { ...run, result });
      continue;
    }
    // owned: `running` stays running (marker simply not seen yet);
    // stopping states may now have exit evidence.
    if (run.result === "running") {
      reconciled.push(run);
      continue;
    }
    const promoted = await reconcileStopState(run, deps.transport);
    if (promoted !== null) {
      await markRun(run.run_id, { result: promoted, finished_at: iso(d), error: null });
      const fresh = (await loadRuns()).runs[run.run_id];
      reconciled.push(fresh ?? { ...run, result: promoted });
    } else {
      reconciled.push(run);
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

  // No stored log: a live bounded read is only attempted for ACTIVE runs
  // whose recorded pane passes ownership re-validation (#66) — a foreign
  // or mismatched pane is never read.
  if (!ACTIVE_RUN_RESULTS.has(run.result)) {
    return { run, log: null, log_path: run.log_path };
  }
  const ownership = await checkPaneOwnership(run, d, deps.transport);
  if (ownership.kind === "foreign" || ownership.kind === "pane_mismatch") {
    const error =
      ownership.kind === "pane_mismatch" ? `stale_pane: ${ownership.detail}` : ownership.detail;
    if (ownership.kind === "pane_mismatch") {
      await markRun(run.run_id, {
        result: "unknown",
        finished_at: iso(d),
        error,
      });
      const updated = (await loadRuns()).runs[run.run_id] ?? { ...run, result: "unknown" as const };
      return { run: updated, log: null, log_path: updated.log_path };
    }
    await markRun(run.run_id, { error });
    const fresh = (await loadRuns()).runs[run.run_id] ?? { ...run, error };
    return { run: fresh, log: null, log_path: fresh.log_path };
  }
  if (ownership.kind === "gone") {
    // running → outcome undetermined; stopping states → pane absence
    // confirms the stop.
    const result: RunResult = run.result === "running" ? "unknown" : "stopped";
    await markRun(run.run_id, {
      result,
      finished_at: iso(d),
      error: result === "unknown" ? "pane gone before log capture" : null,
    });
    const updated = (await loadRuns()).runs[run.run_id] ?? { ...run, result };
    return { run: updated, log: null, log_path: updated.log_path };
  }
  if (ownership.kind === "unreachable") {
    return { run, log: null, log_path: run.log_path };
  }

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
    if (isPaneGoneError(err)) {
      const result: RunResult = run.result === "running" ? "unknown" : "stopped";
      await markRun(run.run_id, {
        result,
        finished_at: iso(d),
        error: result === "unknown" ? (err instanceof Error ? err.message : String(err)) : null,
      });
      const updated = (await loadRuns()).runs[run.run_id] ?? { ...run, result };
      return { run: updated, log: null, log_path: updated.log_path };
    }
    return { run, log: null, log_path: run.log_path };
  }
}
