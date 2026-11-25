/**
 * Persistent task/run registry for rebuildup.automations.
 *
 * Stored as a single JSON document under the plugin state dir
 * (`HERDR_PLUGIN_STATE_DIR`, falling back to the platform state dir for
 * external clients). Tasks and runs are namespaced per herdr session —
 * `hostname + canonical socket path`, the same convention as
 * rebuildup.inbox — so schedules never leak across sessions/hosts
 * (contract §State and identity).
 *
 * Writes are serialized through an exclusive lock file and committed
 * via tmp+rename (AGENTS §4, ADR-0001) — identical discipline to
 * plugins/inbox, plugins/checkpoints, and plugins/handoff.
 */

import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginDirs, resolveSocketPath } from "../../../packages/herdr-client/src/socket";
import {
  AutomationsError,
  PLUGIN_ID,
  parseStoredRun,
  parseStoredTask,
  type RunRecord,
  STATE_SCHEMA_VERSION,
  type TaskRecord,
} from "./model";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

export { PLUGIN_ID };

/** Per-session registry: tasks by id, runs by id. */
export interface SessionRegistry {
  tasks: Record<string, TaskRecord>;
  runs: Record<string, RunRecord>;
}

export interface AutomationsState {
  version: typeof STATE_SCHEMA_VERSION;
  sessions: Record<string, SessionRegistry>;
}

export function emptyState(): AutomationsState {
  return { version: STATE_SCHEMA_VERSION, sessions: {} };
}

export function emptyRegistry(): SessionRegistry {
  return { tasks: {}, runs: {} };
}

/** Per-session registry, created on demand for writes. */
export function sessionRegistry(state: AutomationsState, sessionKey: string): SessionRegistry {
  const existing = state.sessions[sessionKey];
  if (existing) return existing;
  const created = emptyRegistry();
  state.sessions[sessionKey] = created;
  return created;
}

/** Read-only lookup; returns null when the session has no registry yet. */
export function peekRegistry(state: AutomationsState, sessionKey: string): SessionRegistry | null {
  return state.sessions[sessionKey] ?? null;
}

/**
 * Session discriminator for state namespacing: hostname plus the
 * canonical (symlink-resolved) socket path the command will talk to —
 * identical convention to rebuildup.inbox / rebuildup.checkpoints.
 */
export function sessionKeyFor(options: {
  session?: string | undefined;
  socketPath?: string | undefined;
}): string {
  const socketPath = options.socketPath ?? resolveSocketPath({ session: options.session });
  let canonical = socketPath;
  try {
    canonical = realpathSync(socketPath);
  } catch {
    canonical = path.resolve(socketPath);
  }
  return `${os.hostname()} ${canonical}`;
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

export async function loadState(): Promise<AutomationsState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AutomationsState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.sessions !== "object" ||
      parsed.sessions === null
    ) {
      return emptyState();
    }
    const sessions: Record<string, SessionRegistry> = {};
    for (const [key, value] of Object.entries(parsed.sessions)) {
      if (typeof value !== "object" || value === null) {
        throw new AutomationsError("state_corrupt", `session '${key}' registry is not an object`);
      }
      const v = value as Partial<SessionRegistry>;
      const tasksRaw = typeof v.tasks === "object" && v.tasks !== null ? v.tasks : {};
      const runsRaw = typeof v.runs === "object" && v.runs !== null ? v.runs : {};
      const tasks: Record<string, TaskRecord> = {};
      for (const [id, task] of Object.entries(tasksRaw)) {
        tasks[id] = parseStoredTask(task);
      }
      const runs: Record<string, RunRecord> = {};
      for (const [id, run] of Object.entries(runsRaw)) {
        runs[id] = parseStoredRun(run);
      }
      sessions[key] = { tasks, runs };
    }
    return { version: STATE_SCHEMA_VERSION, sessions };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  const file = lockPath();
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
        throw new AutomationsError(
          "lock_timeout",
          "automations state lock timed out; another command may be running",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/**
 * Read-modify-write under the exclusive lock; the mutation runs against
 * the freshly loaded state and the result is committed via tmp+rename.
 * Mutations should be synchronous (async work inside `mutate` holds
 * the lock — keep it short, same convention as plugins/inbox).
 */
export async function updateState<T>(
  mutate: (state: AutomationsState) => T | Promise<T>,
): Promise<T> {
  const release = await acquireLock();
  try {
    const state = await loadState();
    const result = await mutate(state);
    await mkdir(path.dirname(stateFilePath()), { recursive: true });
    const tmp = `${stateFilePath()}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, stateFilePath());
    return result;
  } finally {
    await release();
  }
}
