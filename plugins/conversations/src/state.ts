/**
 * Persistent index state for rebuildup.conversations.
 *
 * `state.json` holds the per-transcript registry (identity binding,
 * scan cursors, counters). Normalized events are appended to
 * `events/<key>.jsonl` — append-only, one JSON object per line, so a
 * later read API (#87/#88) can stream them without re-parsing provider
 * transcripts. Writes are serialized through an exclusive lock file
 * and committed via tmp+rename; event appends happen inside the same
 * locked section so concurrent CLI invocations cannot interleave
 * (AGENTS §4, same discipline as plugins/projects).
 */

import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";
import type { ConversationEvent, ConversationsState, SessionRecord } from "./model";

export const PLUGIN_ID = "rebuildup.conversations";
export const STATE_SCHEMA_VERSION = 1;

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 25;

export function emptyState(): ConversationsState {
  return { version: STATE_SCHEMA_VERSION, sessions: {} };
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

export async function loadState(): Promise<ConversationsState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ConversationsState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.sessions !== "object" ||
      parsed.sessions === null
    ) {
      return emptyState();
    }
    return { version: STATE_SCHEMA_VERSION, sessions: parsed.sessions };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
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
        throw new Error("conversations state lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; I/O inside is allowed. */
export async function updateState<T>(
  mutate: (state: ConversationsState) => T | Promise<T>,
): Promise<T> {
  const release = await acquireLock(lockPath());
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

// --- Event log -------------------------------------------------------------

/** Filesystem-safe event-log name for a session record key. */
export function eventsFileName(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`;
}

export function eventsFilePath(key: string): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "events", eventsFileName(key));
}

/** Replace the event log (used when a transcript is re-indexed from 0). */
export async function writeEventsFile(key: string, events: ConversationEvent[]): Promise<void> {
  const file = eventsFilePath(key);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(
    tmp,
    events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""),
  );
  await rename(tmp, file);
}

export async function appendEvents(key: string, events: ConversationEvent[]): Promise<void> {
  if (events.length === 0) return;
  const file = eventsFilePath(key);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export function newSessionRecord(
  provider: string,
  sessionId: string,
  transcriptPath: string,
  cwd: string | null,
): SessionRecord {
  return {
    key: `${provider}:${sessionId}`,
    provider,
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    status: "ok",
    error: null,
    identity: null,
    cursor: null,
    guard_hash: null,
    turn_count: 0,
    event_count: 0,
    first_event_at: null,
    last_event_at: null,
    last_indexed_at: null,
  };
}
