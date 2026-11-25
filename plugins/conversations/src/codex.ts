/**
 * Codex rollout transcript adapter (provider id `codex`).
 *
 * Transcript location (verified against codex CLI 0.169.x):
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl
 *   (default home: ~/.codex). `archived_sessions/` holds `.jsonl.zst`
 *   compressed rollouts — not readable by the line scanner, so they
 *   resolve as missing rather than being decompressed silently.
 *
 * Resolution order for a candidate (sessionId, cwd):
 *   1. sessionId that is itself an existing readable file (defensive).
 *   2. Recursive walk of `<home>/sessions` and `<home>/archived_sessions`
 *      (depth-bounded) for a `.jsonl` file whose name carries the
 *      session id. cwd is not part of codex's layout, so it is accepted
 *      for signature symmetry but unused.
 *
 * Line format: one JSON object per line
 * `{timestamp, ordinal, type, payload}`. Normalized:
 *   event_msg / item_completed UserMessage|AgentMessage
 *                                    → turn + user_message | assistant_message
 *   event_msg / user_message|agent_message (legacy payloads)
 *                                    → same, for older rollouts
 *   response_item function_call|custom_tool_call (+ *_output)
 *                                    → tool_call | tool_result
 *   event_msg / token_count, token_usage_record
 *                                    → usage attached to the turn's
 *                                      last assistant_message
 * Everything else (session_meta, turn_context bookkeeping, reasoning
 * items, response_item messages — the provider's own instruction
 * echoes, world_state, …) is skipped, never fabricated into events.
 *
 * `response_item` `message` records are deliberately NOT normalized:
 * they duplicate the event_msg item stream and include developer /
 * instruction content (AGENTS.md, skills) that is not conversation.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationEvent, ConversationIdentity, UsageFields } from "./model";

/** Bound stored text/payload so the index stays navigational, not archival. */
export const CODEX_MAX_TEXT_CHARS = 16_384;
export const CODEX_MAX_INPUT_CHARS = 8_192;

/** sessions/YYYY/MM/DD/file.jsonl is depth 4; allow slack for variants. */
const MAX_WALK_DEPTH = 6;
const MAX_WALK_DIRS = 20_000;

export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function findSessionFile(
  root: string,
  sessionId: string,
  depth: number,
  budget: { dirs: number },
): Promise<string | null> {
  if (depth > MAX_WALK_DEPTH || budget.dirs <= 0) return null;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  // Files first: rollout files live at the leaves, dirs at the top.
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jsonl")) continue;
    if (entry.name.includes(sessionId)) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    budget.dirs -= 1;
    const found = await findSessionFile(path.join(root, entry.name), sessionId, depth + 1, budget);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Resolve the rollout file for a codex session id. Returns null when
 * nothing matches — callers must report `missing`, never guess.
 */
export async function resolveCodexTranscript(
  sessionId: string,
  _cwd: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  // Defensive: a value that is already a readable file path.
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    if (await fileExists(sessionId)) return sessionId;
  }
  const home = codexHomeDir(env);
  const budget = { dirs: MAX_WALK_DIRS };
  for (const sub of ["sessions", "archived_sessions"]) {
    const found = await findSessionFile(path.join(home, sub), sessionId, 0, budget);
    if (found !== null) return found;
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

/** Codex token usage → contract UsageFields (input includes cached). */
function usageFrom(raw: unknown): UsageFields | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cached_input_tokens);
  const cacheWrite = tokenCount(usage.cache_write_input_tokens);
  const reasoning = tokenCount(usage.reasoning_output_tokens);
  if (input + output + cacheRead + cacheWrite + reasoning === 0) return null;
  const result: UsageFields = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
  if (reasoning > 0) result.thinking_tokens = reasoning;
  return result;
}

/** Join `[{type:"text",text}]`-style content blocks into bounded text. */
function contentText(
  content: unknown,
  max = CODEX_MAX_TEXT_CHARS,
): { text: string; truncated: boolean } {
  if (typeof content === "string") return bounded(content, max);
  const blocks = Array.isArray(content) ? content : [];
  const parts: string[] = [];
  let truncated = false;
  for (const block of blocks) {
    const b = asRecord(block);
    if (!b) continue;
    const type = b.type;
    if (
      (type === "text" || type === "Text" || type === "input_text" || type === "output_text") &&
      typeof b.text === "string"
    ) {
      const part = bounded(b.text, max);
      parts.push(part.text);
      truncated = truncated || part.truncated;
    }
  }
  const cap = bounded(parts.join("\n"), max);
  return { text: cap.text, truncated: truncated || cap.truncated };
}

/** tool_input payload: JSON string arguments or object input. */
function toolInputFrom(raw: unknown): { input: unknown; truncated: boolean } {
  let json: string;
  if (typeof raw === "string") {
    json = raw;
  } else {
    json = JSON.stringify(raw ?? null);
  }
  const cap = bounded(json, CODEX_MAX_INPUT_CHARS);
  try {
    return { input: JSON.parse(cap.text), truncated: cap.truncated };
  } catch {
    return { input: cap.text, truncated: cap.truncated };
  }
}

/** tool_result text: string output or [{type,text}] content array. */
function toolOutputText(output: unknown): { text: string; truncated: boolean } {
  return contentText(output, CODEX_MAX_TEXT_CHARS);
}

interface ParseContext {
  identity: ConversationIdentity;
  fileName: string;
  turnIndex: number;
  seenTurn: boolean;
  /** Model carried from the latest turn_context record. */
  model: string | null;
  /** Last assistant_message event object, for usage attachment. */
  lastAssistant: ConversationEvent | null;
  /** Request-ledger mode: token_usage_record seen → token_count is stale context. */
  usageLedgerActive: boolean;
}

function currentTurn(ctx: ParseContext): number | null {
  return ctx.seenTurn ? ctx.turnIndex : null;
}

/**
 * Stateful codex line parser for `scanTranscript`. `startTurn` seeds
 * the turn counter on resume so turn_index stays monotonic; line
 * numbers arrive 1-based and absolute (cursor.line_count carried).
 */
export function codexLineParser(
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
    model: null,
    lastAssistant: null,
    usageLedgerActive: false,
  };
  return {
    parseLine: (line, lineNumber) => parseCodexLine(line, lineNumber, ctx),
    turnIndex: () => ctx.turnIndex,
  };
}

function baseEvent(
  record: Record<string, unknown>,
  type: ConversationEvent["type"],
  ctx: ParseContext,
  turnIndex: number | null,
  eventId: string,
): ConversationEvent {
  return {
    event_id: eventId,
    type,
    timestamp: isoTimestamp(record.timestamp),
    identity: ctx.identity,
    turn_index: turnIndex,
  };
}

function parseCodexLine(line: string, lineNumber: number, ctx: ParseContext): ConversationEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  if (!record) return [];
  const payload = asRecord(record.payload);
  if (!payload) return [];

  const fallbackId = `${ctx.fileName}:${lineNumber}`;
  const payloadId = typeof payload.id === "string" && payload.id !== "" ? payload.id : null;

  switch (record.type) {
    case "event_msg":
      return parseEventMsg(record, payload, ctx, fallbackId, payloadId);
    case "response_item":
      return parseResponseItem(record, payload, ctx, fallbackId, payloadId);
    case "turn_context":
      ctx.usageLedgerActive = false;
      if (typeof payload.model === "string" && payload.model !== "") ctx.model = payload.model;
      return [];
    case "token_usage_record": {
      const usage = usageFrom(payload.usage);
      if (usage) attachUsage(ctx, usage);
      ctx.usageLedgerActive = true;
      return [];
    }
    default:
      // session_meta, world_state, ghost_snapshot, …: bookkeeping.
      return [];
  }
}

/** Attach per-request usage to the current turn's last assistant message. */
function attachUsage(ctx: ParseContext, usage: UsageFields): void {
  const last = ctx.lastAssistant;
  if (!last || last.turn_index !== currentTurn(ctx)) return;
  last.usage = usage;
}

function parseEventMsg(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  ctx: ParseContext,
  fallbackId: string,
  payloadId: string | null,
): ConversationEvent[] {
  const kind = payload.type;

  // Legacy payloads (pre item_completed rollouts).
  if (kind === "user_message") {
    return userTurnEvents(record, payload.message, ctx, payloadId ?? fallbackId);
  }
  if (kind === "agent_message") {
    return [assistantEvent(record, payload.message, ctx, payloadId ?? fallbackId)];
  }

  if (kind === "item_completed") {
    const item = asRecord(payload.item);
    if (!item) return [];
    const itemId =
      typeof item.id === "string" && item.id !== "" ? item.id : (payloadId ?? fallbackId);
    if (item.type === "UserMessage") {
      return userTurnEvents(record, item.content, ctx, itemId);
    }
    if (item.type === "AgentMessage") {
      return [assistantEvent(record, item.content, ctx, itemId)];
    }
    // Reasoning / ImageView / CommandExecution / … item kinds are
    // either provider internals or already covered by response_item
    // tool events — skipped, not fabricated.
    return [];
  }

  if (kind === "token_count") {
    // Context snapshots are cumulative/stale once the request ledger
    // is active; otherwise last_token_usage is the most recent request.
    if (ctx.usageLedgerActive) return [];
    const info = asRecord(payload.info);
    const usage = usageFrom(info?.last_token_usage);
    if (usage) attachUsage(ctx, usage);
    return [];
  }

  // task_started / task_complete / agent_reasoning / … : lifecycle or
  // provider-internal bookkeeping — no conversation event.
  return [];
}

function userTurnEvents(
  record: Record<string, unknown>,
  content: unknown,
  ctx: ParseContext,
  baseId: string,
): ConversationEvent[] {
  ctx.turnIndex += 1;
  ctx.seenTurn = true;
  const turn = baseEvent(record, "turn", ctx, ctx.turnIndex, `${baseId}:turn`);
  const message = baseEvent(record, "user_message", ctx, ctx.turnIndex, baseId);
  const text = contentText(content);
  message.text = text.text;
  if (text.truncated) message.text_truncated = true;
  return [turn, message];
}

function assistantEvent(
  record: Record<string, unknown>,
  content: unknown,
  ctx: ParseContext,
  eventId: string,
): ConversationEvent {
  const event = baseEvent(record, "assistant_message", ctx, currentTurn(ctx), eventId);
  const text = contentText(content);
  if (text.text) {
    event.text = text.text;
    if (text.truncated) event.text_truncated = true;
  }
  if (ctx.model) event.model = ctx.model;
  ctx.lastAssistant = event;
  return event;
}

const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
]);

function parseResponseItem(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  ctx: ParseContext,
  fallbackId: string,
  payloadId: string | null,
): ConversationEvent[] {
  const kind = typeof payload.type === "string" ? payload.type : "";

  if (TOOL_CALL_TYPES.has(kind) || kind.endsWith("_tool_call")) {
    const event = baseEvent(record, "tool_call", ctx, currentTurn(ctx), payloadId ?? fallbackId);
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    if (callId) event.tool_use_id = callId;
    else if (payloadId) event.tool_use_id = payloadId;
    if (typeof payload.name === "string") event.tool_name = payload.name;
    const { input, truncated } = toolInputFrom(payload.arguments ?? payload.input);
    event.tool_input = input;
    if (truncated) event.input_truncated = true;
    return [event];
  }

  if (
    TOOL_OUTPUT_TYPES.has(kind) ||
    kind.endsWith("_tool_call_output") ||
    kind === "function_call_output"
  ) {
    const event = baseEvent(record, "tool_result", ctx, currentTurn(ctx), payloadId ?? fallbackId);
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    if (callId) event.tool_use_id = callId;
    else if (payloadId) event.tool_use_id = payloadId;
    const text = toolOutputText(payload.output);
    event.text = text.text;
    if (text.truncated) event.text_truncated = true;
    return [event];
  }

  // message / reasoning / additional_tools / … : the message stream is
  // covered by event_msg item_completed (response_item messages
  // duplicate it and carry instruction noise); reasoning is provider
  // internal — both skipped.
  return [];
}
