/**
 * Pure organize-state logic for the inbox plugin. No I/O here so the state
 * machine is unit-testable without a live herdr session.
 *
 * Semantics inherited from T3 Code settle/snooze (see docs/specs/inbox.md):
 * - settle/snooze are user-side organize state keyed by pane identity
 *   (pane_id + agent_session fingerprint + state_change_seq generation).
 * - Any advance of state_change_seq, an agent-session mismatch, or snooze
 *   expiry restores the pane to the inbox deterministically at read time.
 * - Attention signals are never hidden: a pane whose agent reports a status
 *   that requires user attention stays in the inbox regardless of marks.
 */

import type { AgentInfo, PaneInfo } from "../../../packages/herdr-client/src/snapshot";
import type { AgentSessionRef, InboxEntry, SettledMark, SnoozedMark } from "./state";

export type OrganizeKind = "settled" | "snoozed";

export interface OrganizeView {
  kind: OrganizeKind;
  /** ISO timestamp the organize state was applied. */
  since: string;
  /** Snooze deadline (snoozed only). */
  until?: string;
}

export interface InboxItem {
  pane_id: string;
  workspace_id?: string | undefined;
  tab_id?: string | undefined;
  title?: string | undefined;
  cwd?: string | undefined;
  agent_status?: string | undefined;
  state_change_seq?: number | undefined;
  agent_session?: AgentSessionRef | null | undefined;
  organize?: OrganizeView | undefined;
  /** True when the pane currently requires user attention. */
  attention: boolean;
  /** False when organize state hides the pane from the default inbox view. */
  in_inbox: boolean;
}

/** Statuses that must never be hidden by organize state. */
export const ATTENTION_STATUSES = new Set(["blocked"]);

export function agentSessionRef(agent: AgentInfo | undefined): AgentSessionRef | null {
  const session = agent?.agent_session;
  if (!session) return null;
  const ref: AgentSessionRef = {};
  if (typeof session.agent === "string") ref.agent = session.agent;
  if (typeof session.kind === "string") ref.kind = session.kind;
  if (typeof session.value === "string") ref.value = session.value;
  return Object.keys(ref).length > 0 ? ref : null;
}

function sameAgentSession(
  recorded: AgentSessionRef | null | undefined,
  current: AgentSessionRef | null,
): boolean {
  // A mark recorded without a fingerprint (non-agent pane, or agent without
  // session reporting) matches only while the pane still has none — an
  // agent session appearing later is a generation change.
  if (!recorded) return current === null;
  // A recorded fingerprint that temporarily disappears is not treated as a
  // mismatch; state_change_seq still guards real generation advances.
  if (!current) return true;
  const a = recorded.agent ?? null;
  const b = current.agent ?? null;
  const av = recorded.value ?? null;
  const bv = current.value ?? null;
  return a === b && av === bv;
}

function currentSeq(agent: AgentInfo | undefined): number {
  return typeof agent?.state_change_seq === "number" ? agent.state_change_seq : -1;
}

interface MarkLike {
  at: string;
  seq: number;
  agent_session?: AgentSessionRef | null;
  until?: string;
}

function markExpiredOrAdvanced(mark: MarkLike, agent: AgentInfo | undefined, now: Date): boolean {
  if (mark.until && Date.parse(mark.until) <= now.getTime()) return true;
  if (!sameAgentSession(mark.agent_session, agentSessionRef(agent))) return true;
  const seq = currentSeq(agent);
  // seq -1 means "no agent generation observed". A mark recorded at -1 is
  // advanced by any later real seq (e.g. an agent appearing on a pane that
  // was organized while still a plain shell).
  if (seq >= 0 && (mark.seq < 0 || seq > mark.seq)) return true;
  return false;
}

/**
 * Resolve one entry against the live agent snapshot. Returns the surviving
 * organize view (snooze takes display precedence) and whether any mark was
 * cleared. Mutates `entry` in place.
 */
export function resolveEntry(
  entry: InboxEntry,
  agent: AgentInfo | undefined,
  now: Date,
): { organize?: OrganizeView; cleared: boolean } {
  let cleared = false;

  if (entry.snoozed && markExpiredOrAdvanced(entry.snoozed, agent, now)) {
    delete entry.snoozed;
    cleared = true;
  }
  if (entry.settled && markExpiredOrAdvanced(entry.settled, agent, now)) {
    delete entry.settled;
    cleared = true;
  }

  if (entry.snoozed) {
    const view: OrganizeView = {
      kind: "snoozed",
      since: entry.snoozed.at,
      until: entry.snoozed.until,
    };
    return { organize: view, cleared };
  }
  if (entry.settled) {
    return {
      organize: { kind: "settled", since: entry.settled.at },
      cleared,
    };
  }
  return { cleared };
}

/** Resolve every entry in the state document. */
export function resolveState(
  entries: Record<string, InboxEntry>,
  agents: Record<string, AgentInfo>,
  now: Date,
): { clearedPaneIds: string[] } {
  const clearedPaneIds: string[] = [];
  for (const [paneId, entry] of Object.entries(entries)) {
    const result = resolveEntry(entry, agents[paneId], now);
    if (result.cleared) clearedPaneIds.push(paneId);
    if (!entry.settled && !entry.snoozed) {
      delete entries[paneId];
    }
  }
  return { clearedPaneIds };
}

function upsertEntry(
  entries: Record<string, InboxEntry>,
  pane: PaneInfo,
  nowIso: string,
): InboxEntry {
  const existing = entries[pane.pane_id];
  const entry: InboxEntry = existing ?? {
    pane_id: pane.pane_id,
    updated_at: nowIso,
  };
  entry.workspace_id = pane.workspace_id ?? entry.workspace_id;
  entry.updated_at = nowIso;
  entries[pane.pane_id] = entry;
  return entry;
}

function seqMark(agent: AgentInfo | undefined) {
  return {
    seq: currentSeq(agent),
    agent_session: agentSessionRef(agent),
  };
}

export function settlePane(
  entries: Record<string, InboxEntry>,
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  now: Date,
): InboxEntry {
  const entry = upsertEntry(entries, pane, now.toISOString());
  const mark: SettledMark = { at: now.toISOString(), ...seqMark(agent) };
  entry.settled = mark;
  delete entry.snoozed;
  return entry;
}

export function snoozePane(
  entries: Record<string, InboxEntry>,
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  until: Date,
  now: Date,
): InboxEntry {
  const entry = upsertEntry(entries, pane, now.toISOString());
  const mark: SnoozedMark = {
    at: now.toISOString(),
    until: until.toISOString(),
    ...seqMark(agent),
  };
  entry.snoozed = mark;
  delete entry.settled;
  return entry;
}

export function restorePane(entries: Record<string, InboxEntry>, paneId: string): boolean {
  const existed = paneId in entries;
  delete entries[paneId];
  return existed;
}

export interface PruneOptions {
  /** Entries for panes absent from the snapshot are dropped after this age. Default 24h. */
  absentRetentionMs?: number;
  /** Hard cap on stored entries; oldest `updated_at` are dropped first. Default 500. */
  maxEntries?: number;
}

/**
 * Bound state growth: drop organize entries whose pane has been absent from
 * the session snapshot longer than the retention window, then enforce a hard
 * entry cap by evicting the oldest `updated_at` entries. Entries for live
 * panes are never pruned here (marks expire via resolveEntry instead).
 */
export function pruneState(
  entries: Record<string, InboxEntry>,
  livePaneIds: ReadonlySet<string>,
  now: Date,
  options: PruneOptions = {},
): string[] {
  const retentionMs = options.absentRetentionMs ?? 86_400_000;
  const maxEntries = options.maxEntries ?? 500;
  const removed: string[] = [];

  for (const [paneId, entry] of Object.entries(entries)) {
    if (livePaneIds.has(paneId)) continue;
    const age = now.getTime() - Date.parse(entry.updated_at);
    if (Number.isFinite(age) && age > retentionMs) {
      delete entries[paneId];
      removed.push(paneId);
    }
  }

  const remaining = Object.keys(entries);
  if (remaining.length > maxEntries) {
    const sorted = remaining
      .map((paneId) => ({ paneId, at: entries[paneId]?.updated_at ?? "" }))
      .sort((a, b) => a.at.localeCompare(b.at));
    for (const { paneId } of sorted.slice(0, remaining.length - maxEntries)) {
      delete entries[paneId];
      removed.push(paneId);
    }
  }
  return removed;
}

/**
 * Build the inbox view: every live pane with agent activity plus any pane
 * carrying organize state, resolved against current agent info. Items carry
 * `in_inbox`/`attention` flags; callers decide how to present hidden items.
 */
export function buildInbox(
  panes: PaneInfo[],
  agents: Record<string, AgentInfo>,
  entries: Record<string, InboxEntry>,
  now: Date,
): InboxItem[] {
  const items: InboxItem[] = [];

  const seen = new Set<string>();
  for (const pane of panes) {
    seen.add(pane.pane_id);
    const agent = agents[pane.pane_id];
    const entry = entries[pane.pane_id];
    const resolved = entry
      ? resolveEntry(entry, agent, now)
      : { organize: undefined, cleared: false };
    const organize = resolved.organize;

    const status = agent?.agent_status;
    const attention = status !== undefined && ATTENTION_STATUSES.has(status);
    const hidden = organize !== undefined && !attention;

    items.push({
      pane_id: pane.pane_id,
      workspace_id: pane.workspace_id ?? entry?.workspace_id,
      tab_id: pane.tab_id,
      title: agent?.terminal_title_stripped ?? pane.title,
      cwd: agent?.cwd ?? agent?.foreground_cwd ?? pane.cwd,
      agent_status: status,
      state_change_seq: agent?.state_change_seq,
      agent_session: agentSessionRef(agent),
      organize,
      attention,
      in_inbox: !hidden,
    });
  }

  // Organize entries for panes missing from the snapshot (closed panes) are
  // retained in state but reported as absent rather than fabricated.
  for (const [paneId, entry] of Object.entries(entries)) {
    if (seen.has(paneId)) continue;
    const resolved = resolveEntry(entry, undefined, now);
    if (resolved.organize) {
      items.push({
        pane_id: paneId,
        workspace_id: entry.workspace_id,
        organize: resolved.organize,
        attention: false,
        in_inbox: false,
      });
    }
  }

  items.sort((a, b) => {
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    return a.pane_id.localeCompare(b.pane_id);
  });
  return items;
}
