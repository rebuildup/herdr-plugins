/**
 * Incremental transcript scanner for rebuildup.conversations.
 *
 * Adopted from the T3 `usageTranscriptReader` mechanism at the scale
 * this plugin needs: byte-offset cursor + a small FNV-1a guard over
 * the bytes preceding the resume offset, so an in-place rewrite is
 * detected and the transcript re-indexed from 0 instead of silently
 * skipping or double counting. Only newline-terminated lines are
 * committed; an unterminated tail waits for the next scan. The cursor
 * also carries the committed line count so provider line numbers (and
 * `file:line` event-id fallbacks) stay stable across resumes.
 */

import { open, stat } from "node:fs/promises";
import type { ConversationEvent, ConversationIdentity } from "./model";

/** Bytes of pre-offset content hashed as the rewrite guard. */
export const GUARD_LENGTH = 4096;
/** Read chunk size; lines are accumulated across chunks. */
const READ_CHUNK_BYTES = 256 * 1024;

export function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i += 1) {
    hash ^= buffer[i] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Guard hash over up to GUARD_LENGTH bytes ending at `offset`. */
export async function guardHashAt(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<number> {
  const length = Math.min(GUARD_LENGTH, offset);
  if (length <= 0) return 0;
  const window = Buffer.alloc(length);
  const { bytesRead } = await handle.read(window, 0, length, offset - length);
  if (bytesRead !== length) return -1;
  return fnv1a(window);
}

export interface TranscriptCursor {
  offset: number;
  size: number;
  mtime_ms: number;
  /** Newline-terminated lines committed so far (1-based numbering base). */
  line_count: number;
}

export interface ScanResult {
  events: ConversationEvent[];
  /** New cursor to persist; null when the file could not be scanned. */
  cursor: TranscriptCursor | null;
  scanned_bytes: number;
  /** True when the guard/shrink check forced a from-0 rescan. */
  reindexed: boolean;
  /** Lines that looked like JSON but failed to parse. */
  malformed_lines: number;
  /** Guard hash at the new cursor offset; persist for the next resume. */
  guard_hash: number | null;
  /** Adapter turn counter after this scan; persist for turn_index continuity. */
  turn_index: number;
  /** Set when the transcript could not be read at all. */
  error: string | null;
}

export interface LineParserContext {
  identity: ConversationIdentity;
}

/**
 * Scan `filePath` incrementally. `cursor` is the previously persisted
 * position (null = first scan). `parseFactory` is invoked once per
 * scan and returns a stateful line parser — adapters keep cross-line
 * state (e.g. claude's turn counter) inside the closure. `startTurn`
 * seeds the adapter's turn counter so turn_index stays monotonic
 * across resumes; the factory reports the final count via
 * `turnIndex()`.
 */
export async function scanTranscript(
  filePath: string,
  cursor: TranscriptCursor | null,
  expectedGuardHash: number | null,
  identity: ConversationIdentity,
  parseFactory: (
    ctx: LineParserContext,
    startTurn: number,
    lineBase: number,
  ) => {
    parseLine: (line: string, lineNumber: number) => ConversationEvent[];
    turnIndex: () => number;
  },
  options: { startTurn?: number } = {},
): Promise<ScanResult> {
  const fail = (error: string | null): ScanResult => ({
    events: [],
    cursor: null,
    scanned_bytes: 0,
    reindexed: false,
    malformed_lines: 0,
    guard_hash: null,
    turn_index: 0,
    error,
  });

  let fileSize: number;
  let mtimeMs: number;
  try {
    const info = await stat(filePath);
    fileSize = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return fail("transcript_missing");
  }

  // Resume requires: prior cursor, file not shrunk, and the guard hash
  // over the bytes preceding the offset still matching (in-place
  // rewrite detection — same mechanism as T3's usageTranscriptReader).
  let offset = 0;
  let lineBase = 0;
  let reindexed = false;
  if (cursor && cursor.offset > 0) {
    if (fileSize < cursor.offset) {
      reindexed = true;
    } else {
      const probe = await open(filePath, "r");
      try {
        const guard = await guardHashAt(probe, cursor.offset);
        if (expectedGuardHash !== null && guard === expectedGuardHash) {
          offset = cursor.offset;
          lineBase = cursor.line_count;
        } else {
          reindexed = true;
        }
      } finally {
        await probe.close().catch(() => undefined);
      }
    }
  }

  const startTurn = reindexed ? 0 : (options.startTurn ?? 0);
  const parser = parseFactory({ identity }, startTurn, lineBase);

  const events: ConversationEvent[] = [];
  let malformed = 0;
  let committedOffset = offset;
  let committedLines = lineBase;
  let pending = Buffer.alloc(0);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (err) {
    return fail(err instanceof Error ? err.message : "open_failed");
  }

  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = offset;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      // Copy: the next read overwrites `chunk`, so pending must own
      // its bytes (subarray views would alias the reused buffer).
      pending =
        pending.length === 0
          ? Buffer.from(chunk.subarray(0, bytesRead))
          : Buffer.concat([pending, Buffer.from(chunk.subarray(0, bytesRead))]);
      let newline = pending.indexOf(0x0a);
      while (newline !== -1) {
        let lineBuf = pending.subarray(0, newline);
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
          lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
        }
        committedLines += 1;
        const line = lineBuf.toString("utf8");
        const produced = parser.parseLine(line, committedLines);
        if (produced.length === 0 && looksLikeJson(line) && !parsesAsJson(line)) {
          malformed += 1;
        }
        events.push(...produced);
        committedOffset += newline + 1;
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(0x0a);
      }
    }
  } catch (err) {
    await handle.close().catch(() => undefined);
    return fail(err instanceof Error ? err.message : "read_failed");
  }
  await handle.close().catch(() => undefined);

  let guardHash: number | null = null;
  if (committedOffset > 0) {
    const writer = await open(filePath, "r");
    try {
      guardHash = await guardHashAt(writer, committedOffset);
    } finally {
      await writer.close().catch(() => undefined);
    }
  }

  return {
    events,
    cursor: {
      offset: committedOffset,
      size: fileSize,
      mtime_ms: mtimeMs,
      line_count: committedLines,
    },
    scanned_bytes: committedOffset - offset,
    reindexed,
    malformed_lines: malformed,
    guard_hash: guardHash,
    turn_index: parser.turnIndex(),
    error: null,
  };
}

function looksLikeJson(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function parsesAsJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}
