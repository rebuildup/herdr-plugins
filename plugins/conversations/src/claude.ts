/**
 * Claude Code transcript adapter (provider id `claude`).
 *
 * Transcript location (verified against claude 2.1.x):
 *   $CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl
 *   (default config dir: ~/.claude). The directory name is the cwd with
 *   every non [A-Za-z0-9] byte replaced by `-`; the file name is the
 *   session UUID — which is exactly what herdr reports as
 *   `agent_session.value` (a session id, NOT a path; see ADR-0012 for
 *   the `agent_session_path` upstream gap).
 *
 * Resolution order for a candidate (sessionId, cwd):
 *   1. sessionId that is itself an existing readable file (defensive;
 *      some integrations may report a path).
 *   2. `<projects>/<encode(cwd)>/<sessionId>.jsonl`.
 *   3. `<sessionId>.jsonl` in ANY immediate subdirectory of
 *      `<projects>` — covers cwd-encoding drift and worktree moves;
 *      the recorded `transcript_path` is the actual hit.
 *
 * Line format: one JSON object per line. Types we normalize:
 *   user (string or block content)     → turn + user_message | tool_result
 *   assistant (message.content blocks) → assistant_message (+usage) | tool_call
 *   system                             → system (subtype carried)
 * Everything else (attachments, file-history, api-request blobs,
 * queue-operations, cost-state, …) is provider bookkeeping, not
 * conversation — skipped, never fabricated into events.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationEvent, ConversationIdentity, UsageFields } from "./model";

/** Bound stored text/payload so the index stays navigational, not archival. */
export const MAX_TEXT_CHARS = 16_384;
export const MAX_INPUT_CHARS = 8_192;

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const home = configured || path.join(os.homedir(), ".claude");
  return path.join(home, "projects");
}

/** Claude's cwd→directory encoding: non [A-Za-z0-9] → `-`. */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the transcript file for a claude session id. Returns null
 * when nothing matches — callers must report `missing`, never guess.
 */
export async function resolveClaudeTranscript(
  sessionId: string,
  cwd: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  // Defensive: a value that is already a readable file path.
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    if (await fileExists(sessionId)) return sessionId;
  }
  const projectsDir = claudeProjectsDir(env);
  const fileName = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = path.join(projectsDir, encodeClaudeCwd(cwd), fileName);
    if (await fileExists(direct)) return direct;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, fileName);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

// --- Normalization ----------------------------------------------------------

function bounded(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isoTimestamp(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function baseEvent(
  record: Record<string, unknown>,
  type: ConversationEvent["type"],
  identity: ConversationIdentity,
  turnIndex: number | null,
  eventId: string,
): ConversationEvent {
  const event: ConversationEvent = {
    event_id: eventId,
    type,
    timestamp: isoTimestamp(record.timestamp),
    identity,
    turn_index: turnIndex,
  };
  if (record.isSidechain === true) event.sidechain = true;
  return event;
}

function usageFrom(raw: unknown): UsageFields | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheCreate = tokenCount(usage.cache_creation_input_tokens);
  if (input + output + cacheRead + cacheCreate === 0) return null;
  const result: UsageFields = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
  const details = asRecord(usage.output_tokens_details);
  const thinking = tokenCount(details?.thinking_tokens);
  if (thinking > 0) result.thinking_tokens = thinking;
  return result;
}

function contentText(content: unknown): { text: string; truncated: boolean } {
  if (typeof content === "string") return bounded(content, MAX_TEXT_CHARS);
  const blocks = Array.isArray(content) ? content : [];
  const parts: string[] = [];
  let truncated = false;
  for (const block of blocks) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") {
      const part = bounded(b.text, MAX_TEXT_CHARS);
      parts.push(part.text);
      truncated = truncated || part.truncated;
    }
  }
  const joined = parts.join("\n");
  const cap = bounded(joined, MAX_TEXT_CHARS);
  return { text: cap.text, truncated: truncated || cap.truncated };
}

interface ParseContext {
  identity: ConversationIdentity;
  fileName: string;
  /** Mutable turn counter threaded through the file in line order. */
  turnIndex: number;
  /** Events before the first user prompt get turn_index null. */
  seenTurn: boolean;
}

function currentTurn(ctx: ParseContext): number | null {
  return ctx.seenTurn ? ctx.turnIndex : null;
}

/**
 * Stateful claude line parser for `scanTranscript`. `startTurn` seeds
 * the turn counter on resume so turn_index stays monotonic; line
 * numbers arrive 1-based and absolute (cursor.line_count carried).
 */
export function claudeLineParser(
  fileName: string,
  identity: ConversationIdentity,
  startTurn: number,
): {
  parseLine: (line: string, lineNumber: number) => ConversationEvent[];
  turnIndex: () => number;
} {
  const ctx: ParseContext = {
    identity,
    fileName,
    turnIndex: startTurn,
    seenTurn: startTurn > 0,
  };
  return {
    parseLine: (line, lineNumber) => parseClaudeLine(line, lineNumber, ctx),
    turnIndex: () => ctx.turnIndex,
  };
}

/**
 * Parse ONE claude transcript line into zero or more normalized
 * events. Returns [] for bookkeeping types and malformed JSON — a bad
 * line never fails the scan and never fabricates an event.
 */
function parseClaudeLine(line: string, lineNumber: number, ctx: ParseContext): ConversationEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  if (!record) return [];
  const eventIdFor = (rec: Record<string, unknown>, suffix = ""): string => {
    const base =
      typeof rec.uuid === "string" && rec.uuid !== "" ? rec.uuid : `${ctx.fileName}:${lineNumber}`;
    return suffix ? `${base}${suffix}` : base;
  };
  const type = record.type;
  if (type === "user") return parseUserLine(record, ctx, eventIdFor);
  if (type === "assistant") return parseAssistantLine(record, ctx, eventIdFor);
  if (type === "system") {
    const event = baseEvent(record, "system", ctx.identity, currentTurn(ctx), eventIdFor(record));
    if (typeof record.subtype === "string") event.subtype = record.subtype;
    return [event];
  }
  return [];
}

function parseUserLine(
  record: Record<string, unknown>,
  ctx: ParseContext,
  eventIdFor: (rec: Record<string, unknown>, suffix?: string) => string,
): ConversationEvent[] {
  const message = asRecord(record.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const hasToolResult = blocks.some((b) => asRecord(b)?.type === "tool_result");

  if (hasToolResult) {
    // A user line carrying tool_result blocks is tool output, not a
    // user prompt — emit tool_result events only, no turn boundary.
    const events: ConversationEvent[] = [];
    let resultIndex = 0;
    for (const block of blocks) {
      const b = asRecord(block);
      if (!b || b.type !== "tool_result") continue;
      resultIndex += 1;
      const suffix =
        typeof b.tool_use_id === "string" ? `:result:${b.tool_use_id}` : `:result:${resultIndex}`;
      const event = baseEvent(
        record,
        "tool_result",
        ctx.identity,
        currentTurn(ctx),
        eventIdFor(record, suffix),
      );
      if (typeof b.tool_use_id === "string") event.tool_use_id = b.tool_use_id;
      if (b.is_error === true) event.is_error = true;
      const text = contentText(b.content);
      event.text = text.text;
      if (text.truncated) event.text_truncated = true;
      events.push(event);
    }
    return events;
  }

  // Genuine user prompt: turn boundary, then the message itself.
  // Meta lines (isMeta, tool-use-only echoes, queue-injected content
  // without a real prompt) still count as turns only when they carry
  // user-visible text or arrive as plain string content.
  ctx.turnIndex += 1;
  ctx.seenTurn = true;
  const events: ConversationEvent[] = [];
  const turn = baseEvent(record, "turn", ctx.identity, ctx.turnIndex, eventIdFor(record));
  events.push(turn);

  const messageEvent = baseEvent(
    record,
    "user_message",
    ctx.identity,
    ctx.turnIndex,
    eventIdFor(record, ":message"),
  );
  const text = contentText(content);
  messageEvent.text = text.text;
  if (text.truncated) messageEvent.text_truncated = true;
  events.push(messageEvent);
  return events;
}

function parseAssistantLine(
  record: Record<string, unknown>,
  ctx: ParseContext,
  eventIdFor: (rec: Record<string, unknown>, suffix?: string) => string,
): ConversationEvent[] {
  const message = asRecord(record.message);
  if (!message) return [];
  const content = Array.isArray(message.content) ? message.content : [];

  const events: ConversationEvent[] = [];
  const textParts: string[] = [];
  let textTruncated = false;
  let hasContent = false;

  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") {
      hasContent = true;
      const part = bounded(b.text, MAX_TEXT_CHARS);
      textParts.push(part.text);
      textTruncated = textTruncated || part.truncated;
      continue;
    }
    if (b.type === "tool_use") {
      hasContent = true;
      const event = baseEvent(
        record,
        "tool_call",
        ctx.identity,
        currentTurn(ctx),
        eventIdFor(record, `:tool:${typeof b.id === "string" ? b.id : events.length}`),
      );
      if (typeof b.id === "string") event.tool_use_id = b.id;
      if (typeof b.name === "string") event.tool_name = b.name;
      const inputJson = JSON.stringify(b.input ?? null);
      const input = bounded(inputJson, MAX_INPUT_CHARS);
      try {
        event.tool_input = JSON.parse(input.text);
      } catch {
        event.tool_input = input.text;
      }
      if (input.truncated) event.input_truncated = true;
      events.push(event);
    }
    // thinking/redacted_thinking blocks: provider internals, not
    // conversation content — skipped, not fabricated as text.
  }

  // Assistant usage rides on the message-level event (v1 schema:
  // `usage` field consumed later by #28). An assistant line with only
  // tool_use blocks still emits an assistant_message when it carries
  // usage or text, so token accounting is never dropped.
  const usage = usageFrom(message.usage);
  const cost = record.costUSD;
  if (!hasContent && !usage && typeof cost !== "number") return events;

  const joined = bounded(textParts.join("\n"), MAX_TEXT_CHARS);
  const messageEvent = baseEvent(
    record,
    "assistant_message",
    ctx.identity,
    currentTurn(ctx),
    eventIdFor(record),
  );
  if (joined.text) {
    messageEvent.text = joined.text;
    if (joined.truncated || textTruncated) messageEvent.text_truncated = true;
  }
  if (typeof message.model === "string" && message.model !== "") {
    messageEvent.model = message.model;
  }
  if (usage) messageEvent.usage = usage;
  if (typeof cost === "number" && Number.isFinite(cost)) messageEvent.cost_usd = cost;
  // Emit the message event before its tool_call children? No — keep
  // file order semantics: message first, then tool calls.
  events.unshift(messageEvent);
  return events;
}
