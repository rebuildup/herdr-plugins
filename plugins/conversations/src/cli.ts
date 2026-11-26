/**
 * rebuildup.conversations CLI — provider transcript index contract
 * (`herdr-plugins.conversations/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * `index`/`refresh` resolves each pane agent's transcript via
 * `agent_session.value` (a session id, never assumed a path) + pane
 * cwd + provider-known directories, then incrementally normalizes new
 * bytes into `events/<key>.jsonl`. `sessions` lists indexed
 * transcripts with their last herdr identity binding and a staleness
 * verdict against a live snapshot. No PTY text is ever read.
 */

import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CallOptions,
  paneAgentEntries,
  pluginDirs,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import { claudeLineParser, resolveClaudeTranscript } from "./claude";
import { codexLineParser, resolveCodexTranscript } from "./codex";
import { scanTranscript } from "./indexer";
import {
  agentSessionValue,
  bindingIsStale,
  CONTRACT,
  type ConversationEvent,
  type ConversationIdentity,
  type IndexCandidate,
  type LiveBinding,
  providerIdOf,
  type SessionRecord,
} from "./model";
import { resolveOpenCodeTranscript, scanOpenCodeSession } from "./opencode";
import { isSupported, PROVIDERS, providerDescriptor } from "./providers";
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  matchAll,
  type PagedScanResult,
  readEventPage,
  type ScanTarget,
  scanPagedSessions,
} from "./read";
import {
  appendEvents,
  eventsFilePath,
  loadState,
  newSessionRecord,
  PLUGIN_ID,
  updateState,
  writeEventsFile,
} from "./state";

const PLUGIN_VERSION = "0.6.0";
const DEFAULT_TIMEOUT_MS = 10_000;

interface CliOptions extends CallOptions {
  command: string;
  args: string[];
  session: string | undefined;
  /** `history --pane` selector. */
  pane: string | undefined;
  /** `history --session-id` selector (provider:id or bare id). */
  sessionId: string | undefined;
  /** `history --limit`. */
  limit: number | undefined;
  /** `history --cursor` (opaque byte offset). */
  cursor: string | undefined;
  /** `search`/`show`/`usage --provider` filter. */
  provider: string | undefined;
  /** `search --type` event-type filter. */
  type: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = {
    command,
    args,
    session: undefined,
    pane: undefined,
    sessionId: undefined,
    limit: undefined,
    cursor: undefined,
    provider: undefined,
    type: undefined,
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--session") {
      options.session = args[++i];
    } else if (arg === "--session-id") {
      options.sessionId = args[++i];
    } else if (arg === "--pane") {
      options.pane = args[++i];
    } else if (arg === "--limit") {
      const value = Number(args[++i]);
      if (Number.isFinite(value) && value > 0) options.limit = value;
    } else if (arg === "--cursor") {
      options.cursor = args[++i];
    } else if (arg === "--provider") {
      options.provider = args[++i];
    } else if (arg === "--type") {
      options.type = args[++i];
    } else if (arg === "--socket") {
      options.socketPath = args[++i];
    } else if (arg === "--timeout") {
      const value = Number(args[++i]);
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else if (arg === "--offline") {
      // marker flag consumed by `sessions`; keep it in args
      rest.push(arg);
    } else {
      rest.push(arg);
    }
  }
  options.args = rest;
  return options;
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message: string, code = 1, kind?: string, extra?: Record<string, unknown>): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind) error.kind = kind;
  if (extra) Object.assign(error, extra);
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function now(): string {
  return new Date().toISOString();
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function cmdCapability(): Promise<void> {
  emit({
    contract: CONTRACT,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    read_only: false,
    mutation_commands: ["index", "refresh"],
    commands: ["capability", "index", "refresh", "sessions", "history", "search", "show", "usage"],
    providers: PROVIDERS,
    event_types: [
      "turn",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "system",
    ],
    notes: [
      "Transcript resolution uses agent_session.value (session id) + pane cwd + provider-known directories; agent_session_path is not exposed by herdr AgentInfo (upstream gap, ADR-0012).",
      "PTY text is never read; unsupported providers and missing transcripts are reported explicitly.",
      "Normalized events are appended to <stateDir>/events/<provider>:<session>.jsonl; `history`/`search`/`usage` page them with opaque cursors, `show` resolves stable event/tool/turn references (T3 #88).",
      "opencode sessions are fully rescanned and their event log rewritten on each index (SQLite rows are mutable); file-backed providers scan incrementally.",
    ],
    generated_at: now(),
  });
}

interface PluginConfig {
  timeoutMs?: number | undefined;
}

async function loadConfig(): Promise<PluginConfig> {
  const file = `${pluginDirs(PLUGIN_ID).configDir}/config.json`;
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(file, "utf8")) as PluginConfig;
    return {
      timeoutMs:
        typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0 ? parsed.timeoutMs : undefined,
    };
  } catch {
    return {};
  }
}

function effectiveTimeoutMs(options: CliOptions, config: PluginConfig): number {
  return options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

async function snapshotOrFail(options: CallOptions): Promise<SessionSnapshot> {
  try {
    return await sessionSnapshot(options);
  } catch (err) {
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
}

function agentSessionRef(agent: {
  agent_session?: unknown;
}): ConversationIdentity["agent_session"] {
  const session = agent.agent_session;
  if (typeof session !== "object" || session === null) return null;
  const s = session as Record<string, unknown>;
  const ref: NonNullable<ConversationIdentity["agent_session"]> = {};
  if (typeof s.agent === "string") ref.agent = s.agent;
  if (typeof s.kind === "string") ref.kind = s.kind;
  if (typeof s.value === "string") ref.value = s.value;
  return Object.keys(ref).length > 0 ? ref : null;
}

function paneCwd(
  pane: { cwd?: string },
  agent: { cwd?: string; foreground_cwd?: string },
): string | null {
  const cwd = pane.cwd ?? agent.cwd ?? agent.foreground_cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : null;
}

function herdrSessionName(snapshot: SessionSnapshot, options: CliOptions): string {
  const name = snapshot.session?.name;
  if (typeof name === "string" && name !== "") return name;
  return options.session ?? process.env.HERDR_SESSION ?? "default";
}

function identityFor(
  snapshot: SessionSnapshot,
  options: CliOptions,
  pane: { pane_id: string; workspace_id?: string; tab_id?: string; cwd?: string },
  agent: {
    agent?: string;
    agent_session?: unknown;
    state_change_seq?: number;
    cwd?: string;
    foreground_cwd?: string;
  },
): ConversationIdentity {
  const agentName =
    typeof agent.agent === "string" && agent.agent !== ""
      ? agent.agent
      : (agentSessionRef(agent)?.agent ?? null);
  return {
    host: os.hostname(),
    herdr_session: herdrSessionName(snapshot, options),
    workspace_id: pane.workspace_id ?? null,
    tab_id: pane.tab_id ?? null,
    pane_id: pane.pane_id,
    agent: agentName,
    agent_session: agentSessionRef(agent),
    state_change_seq: typeof agent.state_change_seq === "number" ? agent.state_change_seq : null,
  };
}

/** Collect index candidates from the snapshot; unsupported/malformed agents are skipped with reasons. */
function collectCandidates(snapshot: SessionSnapshot): {
  candidates: IndexCandidate[];
  skipped: Record<string, unknown>[];
} {
  const candidates: IndexCandidate[] = [];
  const skipped: Record<string, unknown>[] = [];
  for (const { pane, agent } of paneAgentEntries(snapshot)) {
    const base = { pane_id: pane.pane_id, workspace_id: pane.workspace_id ?? null };
    const provider = providerIdOf(agent);
    if (provider === null) {
      skipped.push({ ...base, reason: "unknown_provider" });
      continue;
    }
    const descriptor = providerDescriptor(provider);
    if (!descriptor || descriptor.status !== "supported" || !isSupported(provider)) {
      skipped.push({ ...base, provider, reason: "unsupported_provider" });
      continue;
    }
    const sessionId = agentSessionValue(agent);
    if (sessionId === null) {
      skipped.push({ ...base, provider, reason: "no_agent_session" });
      continue;
    }
    candidates.push({ pane, agent, provider, sessionId });
  }
  return { candidates, skipped };
}

interface IndexOutcome {
  key: string;
  provider: string;
  session_id: string;
  transcript_path: string;
  events_appended: number;
  total_events: number;
  reindexed: boolean;
  malformed_lines: number;
}

/** A candidate that could not be indexed, with an explicit reason. */
interface SkipOutcome {
  reason: string;
  [key: string]: unknown;
}

async function applyScanResult(
  state: { sessions: Record<string, SessionRecord> },
  record: SessionRecord,
  key: string,
  identity: ConversationIdentity,
  scan: {
    events: ConversationEvent[];
    cursor: SessionRecord["cursor"];
    guard_hash: number | null;
    turn_index: number;
    reindexed: boolean;
    malformed_lines: number;
    error: string | null;
  },
  transcriptPath: string,
  base: Record<string, unknown>,
): Promise<IndexOutcome | SkipOutcome> {
  if (scan.error !== null) {
    record.status = scan.error === "transcript_missing" ? "missing" : "error";
    record.error = scan.error;
    state.sessions[key] = record;
    return { ...base, reason: scan.error, transcript_path: transcriptPath };
  }

  if (scan.reindexed) {
    await writeEventsFile(key, scan.events);
    record.event_count = scan.events.length;
    const stamps = scan.events.map((e) => e.timestamp).filter((t): t is string => t !== null);
    record.first_event_at = stamps.length ? stamps.reduce((a, b) => (a < b ? a : b)) : null;
    record.last_event_at = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
  } else {
    await appendEvents(key, scan.events);
    record.event_count += scan.events.length;
    for (const e of scan.events) {
      if (e.timestamp === null) continue;
      if (record.first_event_at === null || e.timestamp < record.first_event_at) {
        record.first_event_at = e.timestamp;
      }
      if (record.last_event_at === null || e.timestamp > record.last_event_at) {
        record.last_event_at = e.timestamp;
      }
    }
  }

  record.status = "ok";
  record.error = null;
  record.identity = identity;
  if (scan.cursor) record.cursor = scan.cursor;
  record.guard_hash = scan.guard_hash;
  record.turn_count = scan.turn_index;
  record.last_indexed_at = now();
  state.sessions[key] = record;

  return {
    key,
    provider: record.provider,
    session_id: record.session_id,
    transcript_path: transcriptPath,
    events_appended: scan.events.length,
    total_events: record.event_count,
    reindexed: scan.reindexed,
    malformed_lines: scan.malformed_lines,
  } satisfies IndexOutcome;
}

async function indexFileCandidate(
  state: { sessions: Record<string, SessionRecord> },
  candidate: IndexCandidate,
  identity: ConversationIdentity,
): Promise<IndexOutcome | SkipOutcome> {
  const { pane, provider, sessionId } = candidate;
  const cwd = paneCwd(pane, candidate.agent);
  const base = { pane_id: pane.pane_id, provider, session_id: sessionId };

  const transcriptPath =
    provider === "codex"
      ? await resolveCodexTranscript(sessionId, cwd)
      : await resolveClaudeTranscript(sessionId, cwd);
  if (transcriptPath === null) {
    return { ...base, reason: "transcript_missing", cwd };
  }

  const key = `${provider}:${sessionId}`;
  const existing = state.sessions[key];
  const record = existing ?? newSessionRecord(provider, sessionId, transcriptPath, cwd);
  record.transcript_path = transcriptPath;
  if (cwd !== null) record.cwd = cwd;

  // Missing-event detection: the transcript cursor says everything is
  // consumed, but the event log is gone (deleted state, restored
  // backup). Reset to a from-0 scan so the log is rebuilt instead of
  // silently staying empty forever.
  if (record.event_count > 0 && record.cursor !== null) {
    const eventsFile = eventsFilePath(key);
    const present = await stat(eventsFile)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!present) {
      record.cursor = null;
      record.guard_hash = null;
      record.turn_count = 0;
      record.event_count = 0;
      record.first_event_at = null;
      record.last_event_at = null;
    }
  }

  const fileName = path.basename(transcriptPath);
  const parseFactory = (_ctx: unknown, startTurn: number) =>
    provider === "codex"
      ? codexLineParser(fileName, identity, startTurn)
      : claudeLineParser(fileName, identity, startTurn);

  const scan = await scanTranscript(
    transcriptPath,
    record.cursor,
    record.guard_hash,
    identity,
    parseFactory,
    { startTurn: record.turn_count },
  );

  return applyScanResult(state, record, key, identity, scan, transcriptPath, base);
}

async function indexOpenCodeCandidate(
  state: { sessions: Record<string, SessionRecord> },
  candidate: IndexCandidate,
  identity: ConversationIdentity,
): Promise<IndexOutcome | SkipOutcome> {
  const { pane, sessionId } = candidate;
  const cwd = paneCwd(pane, candidate.agent);
  const base = { pane_id: pane.pane_id, provider: "opencode", session_id: sessionId };

  const resolution = await resolveOpenCodeTranscript(sessionId, cwd);
  if (resolution.status === "missing") {
    return { ...base, reason: "transcript_missing", cwd };
  }
  if (resolution.status === "unsupported_layout") {
    return { ...base, reason: "unsupported_layout", cwd, data_dir: resolution.dataDir };
  }
  if (resolution.status === "session_not_found") {
    return {
      ...base,
      reason: "session_not_found",
      cwd,
      transcript_path: resolution.dbPath,
    };
  }

  const key = `opencode:${sessionId}`;
  const record =
    state.sessions[key] ??
    newSessionRecord("opencode", sessionId, resolution.dbPath, cwd ?? resolution.directory);
  record.transcript_path = resolution.dbPath;
  if (cwd !== null) record.cwd = cwd;
  else if (resolution.directory !== null) record.cwd = resolution.directory;

  // SQLite rows are mutable: every index run is a full rescan and the
  // event log is rewritten, so duplicates/missing rows cannot persist.
  const scan = scanOpenCodeSession(resolution, identity);
  if (scan.error !== null) {
    record.status = "error";
    record.error = scan.error;
    state.sessions[key] = record;
    return { ...base, reason: scan.error, transcript_path: resolution.dbPath };
  }

  await writeEventsFile(key, scan.events);
  record.event_count = scan.events.length;
  const stamps = scan.events.map((e) => e.timestamp).filter((t): t is string => t !== null);
  record.first_event_at = stamps.length ? stamps.reduce((a, b) => (a < b ? a : b)) : null;
  record.last_event_at = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
  record.status = "ok";
  record.error = null;
  record.identity = identity;
  record.cursor = null;
  record.guard_hash = null;
  record.turn_count = scan.turn_count;
  record.last_indexed_at = now();
  state.sessions[key] = record;

  return {
    key,
    provider: "opencode",
    session_id: sessionId,
    transcript_path: resolution.dbPath,
    events_appended: scan.events.length,
    total_events: record.event_count,
    reindexed: true,
    malformed_lines: scan.malformed_lines,
  } satisfies IndexOutcome;
}

async function indexCandidate(
  state: { sessions: Record<string, SessionRecord> },
  candidate: IndexCandidate,
  identity: ConversationIdentity,
): Promise<IndexOutcome | SkipOutcome> {
  if (candidate.provider === "opencode") {
    return indexOpenCodeCandidate(state, candidate, identity);
  }
  return indexFileCandidate(state, candidate, identity);
}

async function cmdIndex(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const callOptions: CallOptions = {
    session: options.session,
    socketPath: options.socketPath,
  };
  if (options.timeoutMs !== undefined || config.timeoutMs !== undefined) {
    callOptions.timeoutMs = effectiveTimeoutMs(options, config);
  }
  const snapshot = await snapshotOrFail(callOptions);
  const { candidates, skipped } = collectCandidates(snapshot);

  const indexed: IndexOutcome[] = [];
  const misses: Record<string, unknown>[] = [...skipped];

  await updateState(async (state) => {
    for (const candidate of candidates) {
      const identity = identityFor(snapshot, options, candidate.pane, candidate.agent);
      const outcome = await indexCandidate(state, candidate, identity);
      if ("reason" in outcome) {
        misses.push(outcome);
      } else {
        indexed.push(outcome);
      }
    }
  });

  emit({
    contract: CONTRACT,
    command: options.command,
    indexed,
    skipped: misses,
    sessions_indexed: indexed.length,
    events_appended: indexed.reduce((n, o) => n + o.events_appended, 0),
    generated_at: now(),
  });
}

interface LiveContext {
  liveByPane: Map<string, LiveBinding>;
  liveSession: string | null;
}

/**
 * Best-effort live snapshot for staleness checks; unreachable socket
 * or `--offline` degrades to null — never a fabricated verdict.
 */
async function liveContext(options: CliOptions): Promise<LiveContext | null> {
  if (hasFlag(options.args, "--offline")) return null;
  try {
    const config = await loadConfig();
    const callOptions: CallOptions = {
      session: options.session,
      socketPath: options.socketPath,
    };
    if (options.timeoutMs !== undefined || config.timeoutMs !== undefined) {
      callOptions.timeoutMs = effectiveTimeoutMs(options, config);
    }
    const snapshot = await sessionSnapshot(callOptions);
    const liveByPane = new Map<string, LiveBinding>();
    for (const { pane, agent } of paneAgentEntries(snapshot)) {
      liveByPane.set(pane.pane_id, {
        pane_id: pane.pane_id,
        agent_session_value: agentSessionValue(agent),
        state_change_seq:
          typeof agent.state_change_seq === "number" ? agent.state_change_seq : null,
      });
    }
    return { liveByPane, liveSession: herdrSessionName(snapshot, options) };
  } catch {
    return null;
  }
}

async function cmdSessions(options: CliOptions): Promise<void> {
  const state = await loadState();
  const live = await liveContext(options);
  const liveByPane = live?.liveByPane ?? new Map<string, LiveBinding>();
  const liveSession = live?.liveSession ?? null;

  const records = Object.values(state.sessions).sort((a, b) =>
    (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""),
  );
  const sessions = await Promise.all(
    records.map(async (record) => {
      const paneId = record.identity?.pane_id ?? null;
      const live = paneId !== null ? (liveByPane.get(paneId) ?? null) : null;
      const { stale, reason } = bindingIsStale(record, live ?? undefined);
      const entry: Record<string, unknown> = {
        key: record.key,
        provider: record.provider,
        provider_status: providerDescriptor(record.provider)?.status ?? "unknown",
        session_id: record.session_id,
        cwd: record.cwd,
        transcript_path: record.transcript_path,
        status: record.status,
        error: record.error,
        identity: record.identity,
        live,
        live_session: liveSession,
        stale,
        stale_reason: reason,
        event_count: record.event_count,
        turn_count: record.turn_count,
        first_event_at: record.first_event_at,
        last_event_at: record.last_event_at,
        last_indexed_at: record.last_indexed_at,
        transcript_present: await pathExists(record.transcript_path),
      };
      return entry;
    }),
  );

  emit({
    contract: CONTRACT,
    command: "sessions",
    sessions,
    count: sessions.length,
    generated_at: now(),
  });
}

// --- read APIs: history / search / show / usage (T3 #88) --------------------

const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 1_000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;
const MAX_SHOW_RESULTS = 200;

const EVENT_TYPES = [
  "turn",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "system",
] as const;

/** Fields `search` matches against (lowercased substring, see spec). */
const SEARCHABLE_FIELDS = ["text", "tool_name", "subtype", "model"] as const;

async function pathExists(p: string): Promise<boolean> {
  return stat(p)
    .then(() => true)
    .catch(() => false);
}

/** Pick the session record a `history` invocation refers to. */
function resolveHistoryRecord(
  state: { sessions: Record<string, SessionRecord> },
  options: CliOptions,
): { record: SessionRecord; note: string | null } | { error: string } {
  const records = Object.values(state.sessions);
  if (options.pane !== undefined) {
    const matches = records
      .filter((r) => r.identity?.pane_id === options.pane)
      .sort((a, b) => (b.last_indexed_at ?? "").localeCompare(a.last_indexed_at ?? ""));
    const record = matches[0];
    if (!record) return { error: `no indexed session for pane ${options.pane}` };
    return { record, note: matches.length > 1 ? "multiple_sessions_for_pane" : null };
  }
  if (options.sessionId !== undefined) {
    const ref = options.sessionId;
    const exact = state.sessions[ref];
    if (exact) return { record: exact, note: null };
    const matches = records
      .filter((r) => r.session_id === ref)
      .sort((a, b) => (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""));
    const record = matches[0];
    if (!record) return { error: `no indexed session for ${ref}` };
    return {
      record,
      note: matches.length > 1 ? "ambiguous_session_id" : null,
    };
  }
  return { error: "history requires --pane PANE or --session-id PROVIDER:ID" };
}

/** Session block shared by history/search/show/usage responses. */
async function sessionReadEntry(
  record: SessionRecord,
  live: LiveBinding | null,
  liveSession: string | null,
): Promise<Record<string, unknown>> {
  const { stale, reason } = bindingIsStale(record, live ?? undefined);
  return {
    key: record.key,
    provider: record.provider,
    provider_status: providerDescriptor(record.provider)?.status ?? "unknown",
    session_id: record.session_id,
    cwd: record.cwd,
    transcript_path: record.transcript_path,
    status: record.status,
    error: record.error,
    identity: record.identity,
    live,
    live_session: liveSession,
    stale,
    stale_reason: reason,
    event_count: record.event_count,
    turn_count: record.turn_count,
    first_event_at: record.first_event_at,
    last_event_at: record.last_event_at,
    last_indexed_at: record.last_indexed_at,
    transcript_present: await pathExists(record.transcript_path),
    events_present: await pathExists(eventsFilePath(record.key)),
  };
}

async function cmdHistory(options: CliOptions): Promise<void> {
  const state = await loadState();
  const resolved = resolveHistoryRecord(state, options);
  if ("error" in resolved) {
    fail(
      resolved.error,
      resolved.error.startsWith("history requires") ? 2 : 1,
      "session_not_found",
      { hint: "run `index` to build the transcript index, or check the selector" },
    );
  }
  const { record, note } = resolved;

  const limit = Math.min(Math.floor(options.limit ?? DEFAULT_HISTORY_LIMIT), MAX_HISTORY_LIMIT);
  let offset = 0;
  if (options.cursor !== undefined) {
    const parsed = Number(options.cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
      fail(`invalid --cursor: ${options.cursor}`, 2);
    }
    offset = parsed;
  }

  const liveCtx = await liveContext(options);
  const paneId = record.identity?.pane_id ?? null;
  const live = paneId !== null ? (liveCtx?.liveByPane.get(paneId) ?? null) : null;

  const page = await readEventPage(record.key, offset, limit, matchAll);
  if ("error" in page) {
    fail(page.error, 1, "cursor_invalid");
  }

  emit({
    contract: CONTRACT,
    command: "history",
    session: await sessionReadEntry(record, live, liveCtx?.liveSession ?? null),
    selector_note: note,
    events: page.matches.map((m) => m.event),
    page: {
      limit,
      offset,
      returned: page.matches.length,
      next_cursor: String(page.next_offset),
      has_more: page.has_more,
      malformed_lines: page.malformed_lines,
      duplicates_skipped: page.duplicates_skipped,
      events_present: page.present,
      events_size: page.size,
    },
    generated_at: now(),
  });
}

// --- search / usage / show ---------------------------------------------------

/**
 * Select the session records a read command covers. `--pane`,
 * `--session-id`, and `--provider` combine as AND filters; with none
 * given every indexed session is covered. Order is by record key so
 * cursor paging is deterministic across invocations.
 */
function selectRecords(
  state: { sessions: Record<string, SessionRecord> },
  options: CliOptions,
): { records: SessionRecord[]; note: string | null } | { error: string } {
  let records = Object.values(state.sessions);
  let note: string | null = null;
  if (options.pane !== undefined) {
    const before = records.length;
    records = records.filter((r) => r.identity?.pane_id === options.pane);
    if (records.length === 0) {
      return { error: `no indexed session for pane ${options.pane}` };
    }
    if (before > records.length) note = "filtered_by_pane";
  }
  if (options.sessionId !== undefined) {
    const ref = options.sessionId;
    const exact = state.sessions[ref];
    if (exact) {
      records = records.filter((r) => r.key === exact.key);
    } else {
      records = records.filter((r) => r.session_id === ref);
    }
    if (records.length === 0) {
      return { error: `no indexed session for ${ref}` };
    }
    if (records.length > 1) note = "ambiguous_session_id";
  }
  if (options.provider !== undefined) {
    records = records.filter((r) => r.provider === options.provider);
    if (records.length === 0) {
      return { error: `no indexed session for provider ${options.provider}` };
    }
  }
  records.sort((a, b) => a.key.localeCompare(b.key));
  return { records, note };
}

function positionalArgs(options: CliOptions): string[] {
  return options.args.filter((a) => a !== "--offline");
}

function readLimit(options: CliOptions, fallback: number, max: number): number {
  return Math.min(Math.floor(options.limit ?? fallback), max);
}

/**
 * Shared paging driver for `search`/`usage`: resolves records, decodes
 * the opaque per-session offset cursor, scans, and emits the common
 * envelope. `matcher` returns the matched field names or null.
 */
async function runPagedRead(
  options: CliOptions,
  command: string,
  extra: Record<string, unknown>,
  matcher: Parameters<typeof scanPagedSessions>[2],
  limit: number,
): Promise<void> {
  const state = await loadState();
  const selected = selectRecords(state, options);
  if ("error" in selected) {
    fail(selected.error, 1, "session_not_found", {
      hint: "run `index` to build the transcript index, or check the selector",
    });
  }
  const { records, note } = selected;

  let decoded: Record<string, number> = {};
  if (options.cursor !== undefined) {
    const parsed = decodeOffsetCursor(options.cursor);
    if (parsed === null) {
      fail(`invalid --cursor: ${options.cursor}`, 2);
    }
    decoded = parsed;
  }

  const liveCtx = await liveContext(options);
  const targets: ScanTarget[] = records.map((r) => ({
    key: r.key,
    offset: decoded[r.key] ?? 0,
  }));
  const scan = await scanPagedSessions(targets, limit, matcher);
  if ("error" in scan) {
    fail(scan.error, 1, "read_failed");
  }
  const page: PagedScanResult = scan;

  const sessions = await Promise.all(
    records.map(async (record) => {
      const paneId = record.identity?.pane_id ?? null;
      const live = paneId !== null ? (liveCtx?.liveByPane.get(paneId) ?? null) : null;
      return sessionReadEntry(record, live, liveCtx?.liveSession ?? null);
    }),
  );

  emit({
    contract: CONTRACT,
    command,
    ...extra,
    selector_note: note,
    results: page.matches.map((m) => ({
      session_key: m.key,
      event_id: m.event.event_id ?? null,
      type: m.event.type ?? null,
      timestamp: m.event.timestamp ?? null,
      turn_index: m.event.turn_index ?? null,
      matched_fields: m.fields,
      event: m.event,
    })),
    page: {
      limit,
      returned: page.matches.length,
      next_cursor: page.has_more ? encodeOffsetCursor(page.offsets) : null,
      has_more: page.has_more,
      malformed_lines: page.malformed_lines,
      duplicates_skipped: page.duplicates_skipped,
      restarted_sessions: page.restarted,
    },
    sessions,
    ...(state.sessions && Object.keys(state.sessions).length === 0
      ? { hint: "no indexed sessions; run `index` to build the transcript index" }
      : {}),
    generated_at: now(),
  });
}

async function cmdSearch(options: CliOptions): Promise<void> {
  const query = positionalArgs(options).join(" ").trim();
  if (query === "") {
    fail("search requires a query", 2);
  }
  if (options.type !== undefined && !(EVENT_TYPES as readonly string[]).includes(options.type)) {
    fail(`invalid --type: ${options.type} (expected one of ${EVENT_TYPES.join(", ")})`, 2);
  }
  const needle = query.toLowerCase();
  const typeFilter = options.type;
  // Case-insensitive substring match over the searchable payload
  // fields; no tokenization in v1 (see docs/specs/conversations.md).
  const matcher = (event: Record<string, unknown>): string[] | null => {
    if (typeFilter !== undefined && event.type !== typeFilter) return null;
    const fields: string[] = [];
    for (const field of SEARCHABLE_FIELDS) {
      const value = event[field];
      if (typeof value === "string" && value.toLowerCase().includes(needle)) {
        fields.push(field);
      }
    }
    return fields.length > 0 ? fields : null;
  };
  await runPagedRead(
    options,
    "search",
    {
      query,
      filters: {
        pane_id: options.pane ?? null,
        session_id: options.sessionId ?? null,
        provider: options.provider ?? null,
        type: typeFilter ?? null,
      },
    },
    matcher,
    readLimit(options, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
  );
}

async function cmdUsage(options: CliOptions): Promise<void> {
  // Read surface for #28: pages only events carrying provider-reported
  // usage; aggregation stays consumer-side.
  const matcher = (event: Record<string, unknown>): string[] | null =>
    typeof event.usage === "object" && event.usage !== null ? ["usage"] : null;
  await runPagedRead(
    options,
    "usage",
    {
      filters: {
        pane_id: options.pane ?? null,
        session_id: options.sessionId ?? null,
        provider: options.provider ?? null,
      },
    },
    matcher,
    readLimit(options, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
  );
}

async function cmdShow(options: CliOptions): Promise<void> {
  const ref = positionalArgs(options).join(" ").trim();
  if (ref === "") {
    fail("show requires a reference (event id, tool:<id>, or turn:<n>)", 2);
  }

  const turnMatch = /^turn:(\d+)$/.exec(ref);
  const toolMatch = /^tool:(.+)$/.exec(ref);
  let matcher: Parameters<typeof scanPagedSessions>[2];
  let resolvedKind: string;
  if (turnMatch) {
    const turnIndex = Number(turnMatch[1]);
    resolvedKind = "turn_index";
    matcher = (event) => (event.turn_index === turnIndex ? ["turn_index"] : null);
  } else if (toolMatch) {
    const toolId = toolMatch[1] as string;
    resolvedKind = "tool_use_id";
    matcher = (event) => (event.tool_use_id === toolId ? ["tool_use_id"] : null);
  } else {
    resolvedKind = "event_id";
    matcher = (event) => {
      if (event.event_id === ref) return ["event_id"];
      if (event.tool_use_id === ref) return ["tool_use_id"];
      return null;
    };
  }

  const state = await loadState();
  const selected = selectRecords(state, options);
  if ("error" in selected) {
    fail(selected.error, 1, "session_not_found", {
      hint: "run `index` to build the transcript index, or check the selector",
    });
  }
  const { records, note } = selected;

  const liveCtx = await liveContext(options);
  const targets: ScanTarget[] = records.map((r) => ({ key: r.key, offset: 0 }));
  const scan = await scanPagedSessions(targets, MAX_SHOW_RESULTS, matcher);
  if ("error" in scan) {
    fail(scan.error, 1, "read_failed");
  }

  // A bare ref may match tool_use_id when no event_id matched; report
  // the kind actually observed rather than the assumed one.
  const observed = new Set(scan.matches.flatMap((m) => m.fields));
  const kind =
    resolvedKind === "event_id" && !observed.has("event_id") && observed.has("tool_use_id")
      ? "tool_use_id"
      : resolvedKind;

  const sessions = await Promise.all(
    records.map(async (record) => {
      const paneId = record.identity?.pane_id ?? null;
      const live = paneId !== null ? (liveCtx?.liveByPane.get(paneId) ?? null) : null;
      return sessionReadEntry(record, live, liveCtx?.liveSession ?? null);
    }),
  );

  emit({
    contract: CONTRACT,
    command: "show",
    ref,
    resolved: { kind },
    selector_note: note,
    results: scan.matches.map((m) => ({
      session_key: m.key,
      matched_fields: m.fields,
      event: m.event,
    })),
    matched: scan.matches.length,
    truncated: scan.has_more,
    sessions,
    ...(Object.keys(state.sessions).length === 0
      ? { hint: "no indexed sessions; run `index` to build the transcript index" }
      : {}),
    generated_at: now(),
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "capability":
      return cmdCapability();
    case "index":
    case "refresh":
      return cmdIndex(options);
    case "sessions":
      return cmdSessions(options);
    case "history":
      return cmdHistory(options);
    case "search":
      return cmdSearch(options);
    case "show":
      return cmdShow(options);
    case "usage":
      return cmdUsage(options);
    case "help":
    case "--help":
    case "-h":
      emit({
        contract: CONTRACT,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        usage:
          "bun run src/cli.ts <capability|index|refresh|sessions|history|search|show|usage> [--session NAME] [--session-id ID] [--pane PANE] [--provider ID] [--type TYPE] [--limit N] [--cursor CUR] [--socket PATH] [--timeout MS] [--offline]",
      });
      return;
    default:
      fail(`unknown command: ${options.command}`, 2);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
