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
import { scanTranscript } from "./indexer";
import {
  agentSessionValue,
  bindingIsStale,
  CONTRACT,
  type ConversationIdentity,
  type IndexCandidate,
  type LiveBinding,
  providerIdOf,
  type SessionRecord,
} from "./model";
import { isSupported, PROVIDERS, providerDescriptor } from "./providers";
import {
  appendEvents,
  loadState,
  newSessionRecord,
  PLUGIN_ID,
  updateState,
  writeEventsFile,
} from "./state";

const PLUGIN_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 10_000;

interface CliOptions extends CallOptions {
  command: string;
  args: string[];
  session: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = { command, args, session: undefined };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--session") {
      options.session = args[++i];
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
    commands: ["capability", "index", "refresh", "sessions"],
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
      "Normalized events are appended to <stateDir>/events/<provider>:<session>.jsonl; reads arrive with the T2/T3 tickets.",
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

async function indexCandidate(
  state: { sessions: Record<string, SessionRecord> },
  candidate: IndexCandidate,
  identity: ConversationIdentity,
): Promise<IndexOutcome | SkipOutcome> {
  const { pane, agent, provider, sessionId } = candidate;
  const cwd = paneCwd(pane, agent);
  const base = { pane_id: pane.pane_id, provider, session_id: sessionId };

  // v1: only the claude adapter exists; the registry gates the rest.
  const transcriptPath = await resolveClaudeTranscript(sessionId, cwd);
  if (transcriptPath === null) {
    return { ...base, reason: "transcript_missing", cwd };
  }

  const key = `${provider}:${sessionId}`;
  const existing = state.sessions[key];
  const record = existing ?? newSessionRecord(provider, sessionId, transcriptPath, cwd);
  record.transcript_path = transcriptPath;
  if (cwd !== null) record.cwd = cwd;

  const fileName = path.basename(transcriptPath);
  const parseFactory = (_ctx: unknown, startTurn: number) =>
    claudeLineParser(fileName, identity, startTurn);

  const scan = await scanTranscript(
    transcriptPath,
    record.cursor,
    record.guard_hash,
    identity,
    parseFactory,
    { startTurn: record.turn_count },
  );

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
    provider,
    session_id: sessionId,
    transcript_path: transcriptPath,
    events_appended: scan.events.length,
    total_events: record.event_count,
    reindexed: scan.reindexed,
    malformed_lines: scan.malformed_lines,
  } satisfies IndexOutcome;
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

async function cmdSessions(options: CliOptions): Promise<void> {
  const state = await loadState();
  const offline = hasFlag(options.args, "--offline");

  // Live bindings for staleness checks; unreachable socket degrades to
  // `live: null` + no stale verdict — never a fabricated one.
  let liveByPane = new Map<string, LiveBinding>();
  let liveSession: string | null = null;
  if (!offline) {
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
      liveSession = herdrSessionName(snapshot, options);
      for (const { pane, agent } of paneAgentEntries(snapshot)) {
        liveByPane.set(pane.pane_id, {
          pane_id: pane.pane_id,
          agent_session_value: agentSessionValue(agent),
          state_change_seq:
            typeof agent.state_change_seq === "number" ? agent.state_change_seq : null,
        });
      }
    } catch {
      liveByPane = new Map();
    }
  }

  const sessions = Object.values(state.sessions)
    .sort((a, b) => (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""))
    .map((record) => {
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
      };
      return entry;
    });

  emit({
    contract: CONTRACT,
    command: "sessions",
    sessions,
    count: sessions.length,
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
    case "help":
    case "--help":
    case "-h":
      emit({
        contract: CONTRACT,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        usage:
          "bun run src/cli.ts <capability|index|refresh|sessions> [--session NAME] [--socket PATH] [--timeout MS] [--offline]",
      });
      return;
    default:
      fail(`unknown command: ${options.command}`, 2);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
