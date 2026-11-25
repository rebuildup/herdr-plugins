/**
 * Persistent handoff state for rebuildup.handoff.
 *
 * Stored as a single JSON document under the plugin state dir
 * (`HERDR_PLUGIN_STATE_DIR`, falling back to the platform state dir for
 * external clients). Writes are serialized through an exclusive lock file
 * and committed via tmp+rename so concurrent CLI invocations cannot
 * corrupt or interleave state — same discipline as plugins/inbox.
 *
 * Unlike inbox, records are NOT namespaced per session: a handoff's whole
 * purpose is to reference a source identity that may live in another
 * session (or host, for T3 #105). Each record carries its own
 * `transfer.session_key`; staleness checks compare only within that
 * namespace.
 */

import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginDirs, resolveSocketPath } from "../../../packages/herdr-client/src/socket";
import {
  type HandoffRecord,
  PLUGIN_ID as MODEL_PLUGIN_ID,
  parseHandoffRecord,
  STATE_SCHEMA_VERSION,
} from "./model";

export const PLUGIN_ID = MODEL_PLUGIN_ID;

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

/** Hard cap; oldest records are evicted first (terminal statuses preferred). */
export const MAX_HANDOFFS = 500;

export interface HandoffsState {
  version: typeof STATE_SCHEMA_VERSION;
  handoffs: Record<string, HandoffRecord>;
}

export function emptyState(): HandoffsState {
  return { version: STATE_SCHEMA_VERSION, handoffs: {} };
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

/**
 * Session discriminator for staleness checks: hostname plus the canonical
 * (symlink-resolved) socket path — the same convention as plugins/inbox.
 * Pane ids repeat across sessions, so `checkTransfer` only compares a
 * record against a snapshot from its own `session_key`.
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

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "superseded"]);

/**
 * Evict oldest records until under `max`. Terminal-status records go first;
 * among equals, oldest `created_at` wins. Never evicts the record being
 * inserted in the same mutation when avoidable (caller inserts after).
 */
export function pruneHandoffs(
  handoffs: Record<string, HandoffRecord>,
  max: number = MAX_HANDOFFS,
): string[] {
  const ids = Object.keys(handoffs);
  if (ids.length <= max) return [];
  const ranked = ids
    .map((id) => ({ id, record: handoffs[id] as HandoffRecord }))
    .sort((a, b) => {
      const aTerm = TERMINAL.has(a.record.status) ? 0 : 1;
      const bTerm = TERMINAL.has(b.record.status) ? 0 : 1;
      if (aTerm !== bTerm) return aTerm - bTerm;
      return a.record.created_at.localeCompare(b.record.created_at);
    });
  const removed: string[] = [];
  for (const entry of ranked.slice(0, ids.length - max)) {
    delete handoffs[entry.id];
    removed.push(entry.id);
  }
  return removed;
}

export async function loadState(): Promise<HandoffsState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<HandoffsState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.handoffs !== "object" ||
      parsed.handoffs === null
    ) {
      return emptyState();
    }
    const handoffs: Record<string, HandoffRecord> = {};
    for (const [id, value] of Object.entries(parsed.handoffs)) {
      handoffs[id] = parseHandoffRecord(value);
    }
    return { version: STATE_SCHEMA_VERSION, handoffs };
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
        throw new Error("handoff state lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; mutations must be synchronous. */
export async function updateState<T>(mutate: (state: HandoffsState) => T | Promise<T>): Promise<T> {
  const release = await acquireLock();
  try {
    const state = await loadState();
    const result = await mutate(state);
    pruneHandoffs(state.handoffs);
    await mkdir(path.dirname(stateFilePath()), { recursive: true });
    const tmp = `${stateFilePath()}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, stateFilePath());
    return result;
  } finally {
    await release();
  }
}
