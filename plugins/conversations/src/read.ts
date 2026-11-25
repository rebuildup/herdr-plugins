/**
 * Read-side helpers for rebuildup.conversations (T3 / #88).
 *
 * The normalized event log (`events/<key>.jsonl`) is append-only for
 * file-backed providers and atomically rewritten for opencode, so a
 * byte-offset cursor stays valid across index updates: appends only
 * extend the file, and a rewrite that shrinks it is detected by the
 * offset-beyond-size check (never silently re-read as if nothing
 * changed).
 *
 * `readEventPage` streams newline-terminated lines from `offset`,
 * applies an optional match predicate, and stops after `limit`
 * matching events or EOF. The opaque multi-session cursor is a
 * base64url JSON map of `{session_key: byte_offset}` for files not
 * yet fully consumed; consumers treat it as opaque and hand it back
 * verbatim.
 */

import { open, stat } from "node:fs/promises";
import { eventsFilePath } from "./state";

export const READ_CHUNK_BYTES = 256 * 1024;

/** One matched event plus the payload fields that matched (search). */
export interface EventMatch {
  event: Record<string, unknown>;
  /** Names of the searchable fields that contained the query. */
  fields: string[];
}

export type EventMatcher = (event: Record<string, unknown>) => string[] | null;

/** Match every event; used by `history`. */
export const matchAll: EventMatcher = () => ["event"];

export interface EventPage {
  matches: EventMatch[];
  /** Byte offset of the first unprocessed byte; pass back as cursor. */
  next_offset: number;
  has_more: boolean;
  malformed_lines: number;
  duplicates_skipped: number;
  present: boolean;
  size: number;
}

/**
 * Read up to `limit` matching events starting at byte `offset`.
 * Only newline-terminated lines are consumed; a partial tail is left
 * for the next page. Malformed lines are skipped and counted; repeated
 * event_ids inside one page are dropped and counted — the index is
 * append-only, so a duplicate means a rewrite raced the read.
 */
export async function readEventPage(
  key: string,
  offset: number,
  limit: number,
  match: EventMatcher = matchAll,
): Promise<EventPage | { error: string }> {
  const file = eventsFilePath(key);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "r");
  } catch {
    return {
      matches: [],
      next_offset: offset,
      has_more: false,
      malformed_lines: 0,
      duplicates_skipped: 0,
      present: false,
      size: 0,
    };
  }
  try {
    const { size } = await handle.stat();
    if (offset > size) {
      await handle.close();
      return {
        error: `cursor ${offset} beyond events file size ${size} (rewritten? restart without --cursor)`,
      };
    }
    const matches: EventMatch[] = [];
    const seen = new Set<string>();
    let malformed = 0;
    let duplicates = 0;
    let pending = Buffer.alloc(0);
    let pendingStart = offset;
    let position = offset;
    let eof = offset >= size;
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    for (;;) {
      if (matches.length >= limit) break;
      let newline = pending.indexOf(0x0a);
      while (newline === -1 && !eof) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) {
          eof = true;
        } else {
          position += bytesRead;
          pending =
            pending.length === 0
              ? Buffer.from(chunk.subarray(0, bytesRead))
              : Buffer.concat([pending, Buffer.from(chunk.subarray(0, bytesRead))]);
        }
        newline = pending.indexOf(0x0a);
      }
      if (newline === -1) break;
      let lineBuf = pending.subarray(0, newline);
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
        lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
      }
      pendingStart += newline + 1;
      pending = pending.subarray(newline + 1);
      const line = lineBuf.toString("utf8");
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      const event = parsed as Record<string, unknown>;
      const eventId = event.event_id;
      if (typeof eventId === "string") {
        if (seen.has(eventId)) {
          duplicates += 1;
          continue;
        }
        seen.add(eventId);
      }
      const fields = match(event);
      if (fields === null) continue;
      matches.push({ event, fields });
    }
    await handle.close();
    return {
      matches,
      next_offset: pendingStart,
      has_more: pendingStart < size,
      malformed_lines: malformed,
      duplicates_skipped: duplicates,
      present: true,
      size,
    };
  } catch (err) {
    await handle.close().catch(() => undefined);
    return { error: err instanceof Error ? err.message : "read_failed" };
  }
}

// --- Opaque multi-session cursor -------------------------------------------

/**
 * Encode per-session byte offsets into an opaque cursor token.
 * Only sessions not yet fully consumed need entries; finished
 * sessions are omitted so the token stays small.
 */
export function encodeOffsetCursor(offsets: Record<string, number>): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offsets }), "utf8").toString("base64url");
}

/** Decode an opaque cursor; null when malformed (caller → cursor_invalid). */
export function decodeOffsetCursor(cursor: string): Record<string, number> | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      o?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.o !== "object" || parsed.o === null) return null;
    const offsets: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed.o as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
      offsets[key] = value;
    }
    return offsets;
  } catch {
    return null;
  }
}

export interface ScanTarget {
  key: string;
  /** Byte offset to resume from; 0 for a fresh scan. */
  offset: number;
}

export interface PagedScanResult {
  matches: { key: string; event: Record<string, unknown>; fields: string[] }[];
  /** Offsets for sessions not fully consumed — encode as next cursor. */
  offsets: Record<string, number>;
  has_more: boolean;
  malformed_lines: number;
  duplicates_skipped: number;
  /** Sessions whose stored offset was beyond the file size (rewritten). */
  restarted: string[];
  /** Per-session file presence/size observed during this page. */
  sessions: Record<string, { present: boolean; size: number }>;
}

/**
 * Page matches across several session event logs in the given order.
 * Consumes up to `limit` matches total; each file resumes at its
 * stored offset so index appends between pages surface exactly once.
 * A stored offset beyond the current file size means the log was
 * rewritten (opencode rescan): the file restarts at 0 and is reported
 * in `restarted` — duplicates are possible and flagged, never hidden.
 */
export async function scanPagedSessions(
  targets: ScanTarget[],
  limit: number,
  match: EventMatcher,
): Promise<PagedScanResult | { error: string }> {
  const matches: PagedScanResult["matches"] = [];
  const offsets: Record<string, number> = {};
  const restarted: string[] = [];
  const sessions: PagedScanResult["sessions"] = {};
  let malformed = 0;
  let duplicates = 0;
  let hasMore = false;

  for (let i = 0; i < targets.length; i += 1) {
    if (matches.length >= limit) {
      // Untouched targets stay unfinished at their stored offset.
      for (const rest of targets.slice(i)) {
        offsets[rest.key] = rest.offset;
        hasMore = true;
      }
      break;
    }
    let target = targets[i] as ScanTarget;
    // A stored offset beyond the current file size means the log was
    // rewritten (e.g. opencode rescan): restart at 0 and flag it —
    // duplicates are possible and surfaced, never hidden.
    const info = await stat(eventsFilePath(target.key)).catch(() => null);
    if (info !== null && target.offset > info.size) {
      restarted.push(target.key);
      target = { key: target.key, offset: 0 };
    }
    const page = await readEventPage(target.key, target.offset, limit - matches.length, match);
    if ("error" in page) return { error: page.error };
    sessions[target.key] = { present: page.present, size: page.size };
    malformed += page.malformed_lines;
    duplicates += page.duplicates_skipped;
    for (const m of page.matches) {
      matches.push({ key: target.key, event: m.event, fields: m.fields });
    }
    if (page.has_more) {
      offsets[target.key] = page.next_offset;
      hasMore = true;
    }
    // page.has_more === false → file fully consumed; no offset entry.
  }

  return {
    matches,
    offsets,
    has_more: hasMore,
    malformed_lines: malformed,
    duplicates_skipped: duplicates,
    restarted,
    sessions,
  };
}
