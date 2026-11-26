/**
 * rebuildup.conversations — shared model types for the
 * `herdr-plugins.conversations/v1` contract (Issue #86 / parent #5 T1).
 *
 * The plugin indexes provider-owned session transcripts (claude JSONL
 * first; codex/opencode adapters are declared but `unsupported` until
 * T2/#87) into normalized conversation events. It never scrapes PTY
 * text: every indexed event comes from the provider's own transcript
 * file, resolved via `agent_session` + `cwd` + provider-known
 * directories (the mechanism T3 `usageTranscriptReader` proved).
 */

import type { AgentInfo, PaneInfo } from "../../../packages/herdr-client/src/index";

export const CONTRACT = "herdr-plugins.conversations/v1";

/** Normalized event kinds emitted by provider adapters. */
export type ConversationEventType =
  | "turn"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "system";

/** Token accounting carried on events that report model usage (v1). */
export interface UsageFields {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Anthropic folds thinking into output; reported separately when present. */
  thinking_tokens?: number;
}

/**
 * Herdr-side identity captured at index time. Carried on every event so
 * consumers (#28 usage, #6 handoff, T3 search) never re-resolve panes —
 * pane ids are reused and agent generations change, so a stored
 * identity is a historical fact, not a live lookup.
 */
export interface ConversationIdentity {
  host: string;
  /** herdr session the binding was observed in (name or socket-derived). */
  herdr_session: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  /** Agent display name reported by herdr (e.g. "claude"). */
  agent: string | null;
  agent_session: {
    agent?: string;
    kind?: string;
    value?: string;
  } | null;
  /** Monotonic per-pane counter at index time; generation signal. */
  state_change_seq: number | null;
}

/**
 * One normalized conversation event. Optional payload fields appear per
 * `type`; see docs/contracts/conversations-v1.md for the per-type
 * matrix. Strings are bounded by the adapter (`text_truncated` /
 * `input_truncated` mark elision) — the index is a navigational index,
 * not a byte-exact archive.
 */
export interface ConversationEvent {
  /** Stable within a transcript: provider uuid when present, else file:line. */
  event_id: string;
  type: ConversationEventType;
  /** ISO-8601 timestamp from the transcript; null when the provider omits it. */
  timestamp: string | null;
  identity: ConversationIdentity;
  /** 1-based index of the turn (user prompt) this event belongs to; null pre-first-turn. */
  turn_index: number | null;
  /** True for provider sidechain/subagent lines kept for completeness. */
  sidechain?: boolean;
  /** user_message / assistant_message text (bounded). */
  text?: string;
  text_truncated?: boolean;
  /** assistant_message model + usage (v1 requirement, consumed by #28). */
  model?: string;
  usage?: UsageFields;
  cost_usd?: number;
  /** tool_call */
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  input_truncated?: boolean;
  /** tool_result */
  is_error?: boolean;
  /** system events */
  subtype?: string;
}

export type SessionStatus = "ok" | "missing" | "error";

/** Per-transcript index record persisted in state.json. */
export interface SessionRecord {
  /** `<provider>:<session_id>` — stable across pane rebinds. */
  key: string;
  provider: string;
  session_id: string;
  transcript_path: string;
  cwd: string | null;
  status: SessionStatus;
  error: string | null;
  /** Last herdr identity the transcript was bound to; null when unbound. */
  identity: ConversationIdentity | null;
  /** Incremental-scan cursor: byte offset + file size/mtime + line count. */
  cursor: { offset: number; size: number; mtime_ms: number; line_count: number } | null;
  /** FNV-1a guard of bytes preceding `offset`; detects in-place rewrites. */
  guard_hash: number | null;
  /** Turn counter value at the cursor; keeps turn_index monotonic on resume. */
  turn_count: number;
  event_count: number;
  first_event_at: string | null;
  last_event_at: string | null;
  last_indexed_at: string | null;
}

export interface ConversationsState {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

/** What `index`/`refresh` resolved for one pane agent. */
export interface IndexCandidate {
  pane: PaneInfo;
  agent: AgentInfo;
  provider: string;
  sessionId: string;
}

/** Live binding info `sessions` reports for staleness checks. */
export interface LiveBinding {
  pane_id: string;
  agent_session_value: string | null;
  state_change_seq: number | null;
}

/** Normalize an agent/agent_session provider hint to a provider id. */
export function providerIdOf(agent: AgentInfo | undefined): string | null {
  const hints = [
    agent?.agent_session?.agent,
    agent?.agent_session?.kind,
    agent?.agent,
    (agent?.agent_session as { provider?: unknown } | undefined)?.provider,
  ];
  for (const hint of hints) {
    if (typeof hint !== "string" || hint === "") continue;
    const lower = hint.toLowerCase();
    for (const id of ["claude", "codex", "opencode"]) {
      if (lower.includes(id)) return id;
    }
  }
  return null;
}

/** agent_session.value is a session id, never assumed to be a path. */
export function agentSessionValue(agent: AgentInfo | undefined): string | null {
  const value = agent?.agent_session?.value;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * True when the live agent on the recorded pane still belongs to the
 * recorded transcript's generation. A pane-id reuse shows up as a
 * different `agent_session.value`; a missing agent/pane means the
 * binding is simply gone (history stays valid, marked unbound).
 */
export function bindingIsStale(
  record: SessionRecord,
  live: LiveBinding | undefined,
): { stale: boolean; reason: string | null } {
  const identity = record.identity;
  if (!identity?.pane_id || !identity.agent_session?.value) {
    return { stale: false, reason: null };
  }
  if (!live) return { stale: false, reason: null };
  if (live.agent_session_value !== identity.agent_session.value) {
    return { stale: true, reason: "agent_session_changed" };
  }
  return { stale: false, reason: null };
}
