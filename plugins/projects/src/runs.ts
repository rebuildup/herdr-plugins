/**
 * Script run records for rebuildup.projects (#53).
 *
 * One JSON document at `<stateDir>/runs.json` holding every script run
 * the plugin has started, plus bounded per-run log files under
 * `<stateDir>/logs/<run_id>.log`. Same single-writer lock + tmp+rename
 * discipline as `state.ts`, but a dedicated lock file so registry writes
 * and run bookkeeping never contend.
 *
 * A record is persisted BEFORE the command is injected into the pane, so
 * a crash between surface creation and injection still leaves an honest
 * `running`/`unknown` trail rather than an untracked pane.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";
import { PLUGIN_ID } from "./state";

export const RUNS_SCHEMA_VERSION = 2;
/** v1 records (pre-#66) load and are upgraded in memory; v3+ reads as empty. */
const RUNS_READABLE_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

/**
 * Run lifecycle. `running` means the completion marker has not been
 * observed yet — it does NOT assert the process is alive (that is
 * re-checked lazily via ownership-verified `pane.get`). `stopping` means
 * a stop was requested (ctrl+c sent) but exit is NOT yet confirmed;
 * `stop_unconfirmed` means the bounded confirmation window elapsed
 * without evidence the process exited. `unknown` means the pane vanished
 * or the outcome can no longer be determined; it is never reported as
 * success (AGENTS §4).
 */
export type RunResult =
  | "running"
  | "stopping"
  | "stop_unconfirmed"
  | "success"
  | "failed"
  | "stopped"
  | "unknown";

/** Results that still address a live (or possibly live) execution pane. */
export const ACTIVE_RUN_RESULTS: ReadonlySet<RunResult> = new Set([
  "running",
  "stopping",
  "stop_unconfirmed",
]);

export interface RunScriptRef {
  id: string;
  name: string;
  command: string;
  source: string;
}

export interface RunRepoRef {
  root: string;
  remote: string | null;
}

export interface ScriptRun {
  run_id: string;
  project_id: string;
  script: RunScriptRef;
  repo: RunRepoRef;
  /** Dedicated execution surface created for this run. */
  pane_id: string;
  workspace_id: string;
  tab_id: string | null;
  /** Working directory the pane shell started in (repo root). */
  cwd: string;
  /** The exact line injected into the pane (marker suffix included). */
  command_line: string;
  /** Set when the command was too long for a single input line. */
  script_path: string | null;
  started_at: string;
  finished_at: string | null;
  /** Parsed from the completion marker only — never from pane text. */
  exit_code: number | null;
  result: RunResult;
  /**
   * Host identity (`os.hostname()`) of the machine whose herdr session
   * owns the pane. `null` on v1 records (unknown — ownership falls back
   * to the pane context check only). Schema v2 (#66).
   */
  host: string | null;
  /**
   * Session discriminator (`sessionKeyFor`: hostname + canonical socket
   * path) the pane lives in. `null` on v1 records. A record whose
   * session_key differs from the invoking socket is FOREIGN — the plugin
   * must never send input or close through the wrong session's socket
   * (pane ids like `w1:p1` collide across sessions).
   */
  session_key: string | null;
  /** ISO timestamp of the last accepted stop request (`stopping`). */
  stop_requested_at: string | null;
  /** Relative path under the plugin state dir, when a log was captured. */
  log_path: string | null;
  /** Last structured error observed (pane gone, socket failure, …). */
  error: string | null;
}

export interface RunsState {
  version: typeof RUNS_SCHEMA_VERSION;
  runs: Record<string, ScriptRun>;
}

export function emptyRuns(): RunsState {
  return { version: RUNS_SCHEMA_VERSION, runs: {} };
}

export function runsFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "runs.json");
}

export function runsDir(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "runs");
}

export function runLogPath(runId: string): string {
  return path.join(runsDir(), `${runId}.log`);
}

function lockPath(): string {
  return `${runsFilePath()}.lock`;
}

export async function loadRuns(): Promise<RunsState> {
  let raw: string;
  try {
    raw = await readFile(runsFilePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRuns();
    throw err;
  }
  // Run records are audit data, not authoritative config: a corrupt file
  // reads as empty rather than failing every scripts command. Destructive
  // recovery is left to the operator (the file is never auto-repaired).
  let parsed: Partial<RunsState> | null;
  try {
    parsed = JSON.parse(raw) as Partial<RunsState> | null;
  } catch {
    return emptyRuns();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.version !== "number" ||
    !RUNS_READABLE_VERSIONS.has(parsed.version) ||
    typeof parsed.runs !== "object" ||
    parsed.runs === null
  ) {
    return emptyRuns();
  }
  // Normalize on load: v1 records lack the v2 ownership/stop fields;
  // fill them with null so every consumer sees the full shape. Writes
  // always emit the current schema version.
  const runs: Record<string, ScriptRun> = {};
  for (const [id, run] of Object.entries(parsed.runs)) {
    if (typeof run !== "object" || run === null) continue;
    const record = run as Partial<ScriptRun>;
    runs[id] = {
      ...record,
      host: typeof record.host === "string" ? record.host : null,
      session_key: typeof record.session_key === "string" ? record.session_key : null,
      stop_requested_at:
        typeof record.stop_requested_at === "string" ? record.stop_requested_at : null,
    } as ScriptRun;
  }
  return { version: RUNS_SCHEMA_VERSION, runs };
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return async () => {
        await rm(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const info = await stat(file);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(file, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("projects runs lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; mutations must be synchronous. */
export async function updateRuns<T>(mutate: (state: RunsState) => T | Promise<T>): Promise<T> {
  const release = await acquireLock(lockPath());
  try {
    const state = await loadRuns();
    const result = await mutate(state);
    await mkdir(path.dirname(runsFilePath()), { recursive: true });
    const tmp = `${runsFilePath()}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, runsFilePath());
    return result;
  } finally {
    await release();
  }
}

/**
 * Write a bounded log tail for a run. Keeps at most `maxBytes` from the
 * END of `text` (run output of interest is the tail); the file always
 * starts on a line boundary when possible. Returns the stored path.
 */
export async function writeRunLog(runId: string, text: string, maxBytes: number): Promise<string> {
  let body = text;
  const buf = Buffer.from(body, "utf8");
  if (buf.length > maxBytes) {
    const tail = buf.subarray(buf.length - maxBytes);
    const nl = tail.indexOf(0x0a);
    body = (nl >= 0 && nl < tail.length - 1 ? tail.subarray(nl + 1) : tail).toString("utf8");
    body = `… [truncated to last ${maxBytes} bytes]\n${body}`;
  }
  const file = runLogPath(runId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
}

export async function readRunLog(runId: string): Promise<string | null> {
  try {
    return await readFile(runLogPath(runId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
