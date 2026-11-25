/**
 * OpenCode transcript adapter (provider id `opencode`).
 *
 * Storage (verified against opencode 2.x `opencode.db`, schema mirrored
 * from T3 `provider-opencode` usage reader + a live 2.x database):
 *
 *   Data root: $OPENCODE_DATA_DIR (comma-separated) else
 *   $XDG_DATA_HOME/opencode or ~/.local/share/opencode.
 *   Database:  <root>/opencode.db (preferred) or opencode-<name>.db —
 *   SQLite, WAL mode. Read-only access; the plugin never writes it.
 *
 *   v2 schema: `session_v2` (id, directory, time_created) +
 *   `session_message` (id, session_id, type, seq, time_created,
 *   time_updated, data). `data` is a JSON document; assistant rows
 *   embed their parts in `content[]` (text / reasoning / tool).
 *   v1 schema (same file, older sessions): `session` + `message`
 *   (data JSON with `role`) + `part` (per-part `data` JSON).
 *   Pre-SQLite file storage (`<root>/storage/**.json`) is NOT
 *   supported — reported as `unsupported_layout`, never guessed.
 *
 * Because SQLite rows are mutable (time_updated) and ordered by `seq`
 * rather than append-only bytes, this adapter does a FULL rescan of
 * the session on every index run and the caller rewrites the session's
 * event log. Dedup is structural: event ids derive from provider row
 * ids, and a rewrite replaces the whole file atomically.
 */

import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationEvent, ConversationIdentity, UsageFields } from "./model";

/** Bound stored text/payload so the index stays navigational, not archival. */
export const OPENCODE_MAX_TEXT_CHARS = 16_384;
export const OPENCODE_MAX_INPUT_CHARS = 8_192;

export type OpenCodeResolution =
  | { status: "missing" }
  | { status: "unsupported_layout"; dataDir: string }
  | { status: "session_not_found"; dbPath: string }
  | {
      status: "ok";
      dbPath: string;
      sessionId: string;
      schema: "v2" | "v1";
      directory: string | null;
    };

function isAbsolute(p: string): boolean {
  return path.isAbsolute(p);
}

/** Candidate opencode data roots, env-driven (never ambient HOME guesses beyond default). */
export function opencodeDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.OPENCODE_DATA_DIR?.split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  if (configured && configured.length > 0) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim();
  const base =
    dataHome !== undefined && dataHome !== "" && isAbsolute(dataHome)
      ? dataHome
      : path.join(os.homedir(), ".local", "share");
  return [path.join(base, "opencode")];
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

const DB_NAME = /^opencode(?:-[A-Za-z0-9_-]+)?\.db$/;

/** All opencode databases under a data root, opencode.db first. */
async function findDatabases(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await (await import("node:fs/promises")).readdir(root);
  } catch {
    return [];
  }
  const candidates = names
    .filter((n) => DB_NAME.test(n))
    .sort((a, b) => (a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b)));
  const found: string[] = [];
  for (const name of candidates) {
    const file = path.join(root, name);
    if (await fileExists(file)) found.push(file);
  }
  return found;
}

interface SessionRow {
  id: string;
  directory: string | null;
}

function openDb(dbPath: string): Database | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    db.query("PRAGMA busy_timeout = 250").all();
    return db;
  } catch {
    return null;
  }
}

function tableNames(db: Database): Set<string> {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: unknown;
  }[];
  return new Set(rows.map((r) => String(r.name)));
}

function findSession(db: Database, tables: Set<string>, sessionId: string): SessionRow | null {
  for (const table of ["session_v2", "session"] as const) {
    if (!tables.has(table)) continue;
    const row = db
      .query(`SELECT id, directory FROM ${table} WHERE id = ? LIMIT 1`)
      .get(sessionId) as { id?: unknown; directory?: unknown } | null;
    if (row && typeof row.id === "string") {
      return {
        id: row.id,
        directory: typeof row.directory === "string" ? row.directory : null,
      };
    }
  }
  return null;
}

/**
 * Resolve the opencode transcript for a session id. `cwd` is accepted
 * for signature symmetry; opencode sessions are found by id in the
 * database, and `directory` is reported for consumers.
 */
export async function resolveOpenCodeTranscript(
  sessionId: string,
  _cwd: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenCodeResolution> {
  // Defensive: a value that is already a readable SQLite file.
  if ((sessionId.endsWith(".db") || sessionId.includes("/")) && (await fileExists(sessionId))) {
    const db = openDb(sessionId);
    if (db === null) return { status: "missing" };
    try {
      const tables = tableNames(db);
      const session = findSession(db, tables, sessionId);
      if (!session) return { status: "session_not_found", dbPath: sessionId };
      return {
        status: "ok",
        dbPath: sessionId,
        sessionId: session.id,
        schema: tables.has("session_v2") && tables.has("session_message") ? "v2" : "v1",
        directory: session.directory,
      };
    } finally {
      db.close();
    }
  }

  let firstDbPath: string | null = null;
  let legacyDir: string | null = null;
  for (const root of opencodeDataDirs(env)) {
    for (const dbPath of await findDatabases(root)) {
      firstDbPath ??= dbPath;
      const db = openDb(dbPath);
      if (db === null) continue;
      try {
        const tables = tableNames(db);
        const session = findSession(db, tables, sessionId);
        if (!session) continue;
        return {
          status: "ok",
          dbPath,
          sessionId: session.id,
          schema: tables.has("session_v2") && tables.has("session_message") ? "v2" : "v1",
          directory: session.directory,
        };
      } finally {
        db.close();
      }
    }
    // No usable database in this root: legacy file storage gets an
    // explicit layout verdict instead of a silent miss (checked only
    // after every root's databases came up empty for the session).
    if (legacyDir === null && (await dirExists(path.join(root, "storage")))) {
      legacyDir = root;
    }
  }
  if (firstDbPath !== null) return { status: "session_not_found", dbPath: firstDbPath };
  if (legacyDir !== null) return { status: "unsupported_layout", dataDir: legacyDir };
  return { status: "missing" };
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

function epochIso(ms: unknown, fallback: unknown): string | null {
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString();
  }
  const dataTime = asRecord(asRecord(fallback)?.time);
  const created = dataTime?.created;
  if (typeof created === "number" && Number.isFinite(created) && created > 0) {
    // opencode `time.created` is epoch milliseconds.
    return new Date(created).toISOString();
  }
  return null;
}

/** opencode tokens {input,output,reasoning,cache:{read,write}} → UsageFields. */
function usageFromTokens(raw: unknown): UsageFields | null {
  const tokens = asRecord(raw);
  if (!tokens) return null;
  const cache = asRecord(tokens.cache);
  const input = tokenCount(tokens.input);
  const output = tokenCount(tokens.output);
  const reasoning = tokenCount(tokens.reasoning);
  const cacheRead = tokenCount(cache?.read);
  const cacheWrite = tokenCount(cache?.write);
  if (input + output + reasoning + cacheRead + cacheWrite === 0) return null;
  const result: UsageFields = {
    // output excludes reasoning in opencode; surface it inside output
    // (consistent with claude/codex where reasoning rides output) and
    // separately as thinking_tokens.
    input_tokens: input,
    output_tokens: output + reasoning,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
  if (reasoning > 0) result.thinking_tokens = reasoning;
  return result;
}

function modelFrom(raw: unknown): string | null {
  const model = asRecord(raw);
  if (!model) return null;
  const id = typeof model.id === "string" ? model.id : null;
  if (id === null || id === "") return null;
  const provider = typeof model.providerID === "string" ? model.providerID : null;
  if (provider && !id.includes("/")) return `${provider}/${id}`;
  return id;
}

function costFrom(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function contentText(
  content: unknown,
  max = OPENCODE_MAX_TEXT_CHARS,
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

function toolInputFrom(raw: unknown): { input: unknown; truncated: boolean } {
  const json = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  const cap = bounded(json, OPENCODE_MAX_INPUT_CHARS);
  try {
    return { input: JSON.parse(cap.text), truncated: cap.truncated };
  } catch {
    return { input: cap.text, truncated: cap.truncated };
  }
}

/** opencode tool state → result text + error flag. */
function toolResultFrom(state: Record<string, unknown> | null): {
  text: string;
  truncated: boolean;
  isError: boolean;
  hasResult: boolean;
} {
  if (!state) return { text: "", truncated: false, isError: false, hasResult: false };
  const status = typeof state.status === "string" ? state.status : "";
  const isError = status === "error" || (state.error !== undefined && state.error !== null);
  if (status !== "completed" && status !== "error") {
    return { text: "", truncated: false, isError, hasResult: false };
  }
  const output = state.output ?? state.content;
  const text = contentText(output);
  return { text: text.text, truncated: text.truncated, isError, hasResult: true };
}

export interface OpenCodeScanResult {
  events: ConversationEvent[];
  malformed_lines: number;
  error: string | null;
  turn_count: number;
}

interface RowCursor {
  identity: ConversationIdentity;
  turnIndex: number;
  seenTurn: boolean;
}

function baseEvent(
  type: ConversationEvent["type"],
  ctx: RowCursor,
  timestamp: string | null,
  eventId: string,
): ConversationEvent {
  return {
    event_id: eventId,
    type,
    timestamp,
    identity: ctx.identity,
    turn_index: ctx.seenTurn ? ctx.turnIndex : null,
  };
}

/**
 * Full rescan of one opencode session → normalized events. Returns
 * `error` set when the database cannot be read; per-row JSON failures
 * increment `malformed_lines` and are skipped, never fatal.
 */
export function scanOpenCodeSession(
  resolution: Extract<OpenCodeResolution, { status: "ok" }>,
  identity: ConversationIdentity,
): OpenCodeScanResult {
  const empty = (error: string): OpenCodeScanResult => ({
    events: [],
    malformed_lines: 0,
    error,
    turn_count: 0,
  });

  const db = openDb(resolution.dbPath);
  if (db === null) return empty("sqlite_open_failed");

  const events: ConversationEvent[] = [];
  let malformed = 0;
  const ctx: RowCursor = { identity, turnIndex: 0, seenTurn: false };

  try {
    const tables = tableNames(db);
    if (resolution.schema === "v2" && tables.has("session_message")) {
      scanV2(db, resolution.sessionId, ctx, events, () => {
        malformed += 1;
      });
    } else if (tables.has("message")) {
      scanV1(db, resolution.sessionId, ctx, events, () => {
        malformed += 1;
      });
    } else {
      db.close();
      return empty("sqlite_schema_unsupported");
    }
  } catch (err) {
    db.close();
    return empty(err instanceof Error ? err.message : "sqlite_query_failed");
  }
  db.close();
  return {
    events,
    malformed_lines: malformed,
    error: null,
    turn_count: ctx.turnIndex,
  };
}

type Malformed = () => void;

interface MessageRow {
  rowid: number;
  id: string | null;
  type: string | null;
  seq: number | null;
  time_created: number | null;
  data: string;
}

function rowId(row: { id: string | null; rowid: number }, prefix: string): string {
  return row.id !== null && row.id !== "" ? row.id : `${prefix}-row-${row.rowid}`;
}

function parseData(raw: string, onMalformed: Malformed): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    onMalformed();
    return null;
  }
}

function userEvents(
  row: MessageRow,
  data: Record<string, unknown>,
  ctx: RowCursor,
  timestamp: string | null,
  events: ConversationEvent[],
): void {
  const id = rowId(row, "msg");
  ctx.turnIndex += 1;
  ctx.seenTurn = true;
  events.push(baseEvent("turn", ctx, timestamp, `${id}:turn`));
  const message = baseEvent("user_message", ctx, timestamp, id);
  // v2 user rows carry `text`; v1 rows carry text `part`s handled by
  // the caller — here `content`/`text` fields are the fallback.
  const text = contentText(data.text ?? data.content);
  message.text = text.text;
  if (text.truncated) message.text_truncated = true;
  events.push(message);
}

function assistantEvents(
  row: MessageRow,
  data: Record<string, unknown>,
  ctx: RowCursor,
  timestamp: string | null,
  events: ConversationEvent[],
  partTexts?: { text: string; truncated: boolean } | null,
): void {
  const id = rowId(row, "msg");
  const event = baseEvent("assistant_message", ctx, timestamp, id);
  const content = Array.isArray(data.content) ? data.content : [];
  const textParts: string[] = [];
  let textTruncated = false;
  let hasText = false;

  const emitTool = (tool: Record<string, unknown>, index: number) => {
    const callId =
      (typeof tool.callID === "string" && tool.callID) ||
      (typeof tool.callId === "string" && tool.callId) ||
      (typeof tool.id === "string" && tool.id) ||
      `${id}:tool:${index}`;
    const state = asRecord(tool.state);
    const call = baseEvent("tool_call", ctx, timestamp, `${callId}:call`);
    call.tool_use_id = callId;
    const name =
      typeof tool.name === "string" ? tool.name : typeof tool.tool === "string" ? tool.tool : null;
    if (name) call.tool_name = name;
    const { input, truncated } = toolInputFrom(state?.input ?? tool.input);
    call.tool_input = input;
    if (truncated) call.input_truncated = true;
    events.push(call);

    const result = toolResultFrom(state);
    if (result.hasResult) {
      const res = baseEvent("tool_result", ctx, timestamp, `${callId}:result`);
      res.tool_use_id = callId;
      res.text = result.text;
      if (result.truncated) res.text_truncated = true;
      if (result.isError) res.is_error = true;
      events.push(res);
    }
  };

  const toolBlocks: { tool: Record<string, unknown>; index: number }[] = [];
  for (const [index, block] of content.entries()) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") {
      hasText = true;
      const part = bounded(b.text, OPENCODE_MAX_TEXT_CHARS);
      textParts.push(part.text);
      textTruncated = textTruncated || part.truncated;
    } else if (b.type === "tool") {
      toolBlocks.push({ tool: b, index });
    }
    // reasoning / step-* / file / snapshot / patch parts: provider
    // internals or bookkeeping — skipped, never surfaced as text.
  }

  // v1 path: text arrives via `part` rows, not embedded content.
  if (partTexts && (partTexts.text || partTexts.truncated)) {
    hasText = true;
    textParts.push(partTexts.text);
    textTruncated = textTruncated || partTexts.truncated;
  }

  const model = modelFrom(data.model);
  const fallbackModel =
    model === null && typeof data.modelID === "string"
      ? (() => {
          const provider = typeof data.providerID === "string" ? data.providerID : null;
          return provider && !data.modelID.includes("/")
            ? `${provider}/${data.modelID}`
            : data.modelID;
        })()
      : null;
  const usage = usageFromTokens(data.tokens);
  const cost = costFrom(data.cost);

  if (!hasText && !usage && cost === null && content.length === 0) return;

  const joined = bounded(textParts.join("\n"), OPENCODE_MAX_TEXT_CHARS);
  if (joined.text) {
    event.text = joined.text;
    if (joined.truncated || textTruncated) event.text_truncated = true;
  }
  const finalModel = model ?? fallbackModel;
  if (finalModel) event.model = finalModel;
  if (usage) event.usage = usage;
  if (cost !== null) event.cost_usd = cost;
  events.push(event);
  // Message first, then its tool children — same order as claude.
  for (const { tool, index } of toolBlocks) emitTool(tool, index);
}

function scanV2(
  db: Database,
  sessionId: string,
  ctx: RowCursor,
  events: ConversationEvent[],
  onMalformed: Malformed,
): void {
  const rows = db
    .query(
      `SELECT rowid AS rowid, id, type, seq, time_created, data
       FROM session_message WHERE session_id = ? ORDER BY seq ASC, rowid ASC`,
    )
    .all(sessionId) as unknown as MessageRow[];

  for (const row of rows) {
    const data = parseData(row.data, onMalformed);
    if (data === null) continue;
    const timestamp = epochIso(row.time_created, data);
    switch (row.type) {
      case "user":
        userEvents(row, data, ctx, timestamp, events);
        break;
      case "assistant":
        assistantEvents(row, data, ctx, timestamp, events);
        break;
      case "compaction": {
        const id = rowId(row, "msg");
        const event = baseEvent("system", ctx, timestamp, id);
        event.subtype = "compaction";
        const summary = typeof data.summary === "string" ? data.summary : null;
        if (summary) {
          const text = bounded(summary, OPENCODE_MAX_TEXT_CHARS);
          event.text = text.text;
          if (text.truncated) event.text_truncated = true;
        }
        events.push(event);
        break;
      }
      case "system": {
        const id = rowId(row, "msg");
        const event = baseEvent("system", ctx, timestamp, id);
        event.subtype = typeof data.subtype === "string" ? data.subtype : "system";
        events.push(event);
        break;
      }
      default:
        // idle / location-switched / model-switched / synthetic / …:
        // lifecycle bookkeeping, not conversation — skipped.
        break;
    }
  }
}

function scanV1(
  db: Database,
  sessionId: string,
  ctx: RowCursor,
  events: ConversationEvent[],
  onMalformed: Malformed,
): void {
  const rows = db
    .query(
      `SELECT rowid AS rowid, id, NULL AS type, NULL AS seq, time_created, data
       FROM message WHERE session_id = ? ORDER BY time_created ASC, rowid ASC`,
    )
    .all(sessionId) as unknown as MessageRow[];

  const partStmt = db.query(
    `SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, rowid ASC`,
  );

  for (const row of rows) {
    const data = parseData(row.data, onMalformed);
    if (data === null) continue;
    const timestamp = epochIso(row.time_created, data);
    const role = typeof data.role === "string" ? data.role : null;

    // Collect this message's parts once (text + tool), in order.
    const partRows = partStmt.all(row.id ?? "") as { data: string }[];
    const texts: string[] = [];
    let textTruncated = false;
    const toolParts: Record<string, unknown>[] = [];
    for (const partRow of partRows) {
      const part = parseData(partRow.data, onMalformed);
      if (part === null) continue;
      if (part.type === "text" && typeof part.text === "string") {
        const t = bounded(part.text, OPENCODE_MAX_TEXT_CHARS);
        texts.push(t.text);
        textTruncated = textTruncated || t.truncated;
      } else if (part.type === "tool") {
        toolParts.push(part);
      }
      // reasoning / step-start / step-finish / patch / … skipped.
    }
    const partText = { text: texts.join("\n"), truncated: textTruncated };

    if (role === "user") {
      const id = rowId(row, "msg");
      ctx.turnIndex += 1;
      ctx.seenTurn = true;
      events.push(baseEvent("turn", ctx, timestamp, `${id}:turn`));
      const message = baseEvent("user_message", ctx, timestamp, id);
      const text = contentText(data.text ?? partText.text);
      message.text = text.text;
      if (text.truncated || partText.truncated) message.text_truncated = true;
      events.push(message);
    } else if (role === "assistant") {
      // v1 assistant rows embed no content[]; synthesize one so the
      // shared assistant path handles text + tool parts uniformly.
      const content: Record<string, unknown>[] = [];
      if (partText.text) content.push({ type: "text", text: partText.text });
      for (const tool of toolParts) content.push(tool);
      const merged = { ...data, content };
      assistantEvents(row, merged, ctx, timestamp, events);
    }
    // other roles: provider bookkeeping — skipped.
  }
}
