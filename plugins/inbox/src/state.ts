/**
 * Persistent organize state for the inbox plugin.
 *
 * Stored as a single JSON document under the plugin state dir
 * (`HERDR_PLUGIN_STATE_DIR`, falling back to the platform state dir for
 * external clients). Writes are serialized through an exclusive lock file and
 * committed via tmp+rename so concurrent CLI/hook invocations cannot corrupt
 * or interleave state.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";

export const PLUGIN_ID = "rebuildup.inbox";
export const STATE_SCHEMA_VERSION = 1;

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

export interface AgentSessionRef {
  agent?: string;
  kind?: string;
  value?: string;
}

export interface SettledMark {
  at: string;
  /** state_change_seq observed when the pane was settled. */
  seq: number;
  agent_session?: AgentSessionRef | null;
}

export interface SnoozedMark {
  at: string;
  until: string;
  seq: number;
  agent_session?: AgentSessionRef | null;
}

export interface InboxEntry {
  pane_id: string;
  workspace_id?: string | undefined;
  settled?: SettledMark | undefined;
  snoozed?: SnoozedMark | undefined;
  updated_at: string;
}

export interface InboxState {
  version: typeof STATE_SCHEMA_VERSION;
  entries: Record<string, InboxEntry>;
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

export function emptyState(): InboxState {
  return { version: STATE_SCHEMA_VERSION, entries: {} };
}

export async function loadState(): Promise<InboxState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<InboxState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      return emptyState();
    }
    return { version: STATE_SCHEMA_VERSION, entries: parsed.entries };
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
        throw new Error("inbox state lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; mutations must be synchronous. */
export async function updateState<T>(mutate: (state: InboxState) => T | Promise<T>): Promise<T> {
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
