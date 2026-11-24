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
import type { AgentSessionRef, InboxEntry, InboxState, SettledMark, SnoozedMark } from "./state";

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

export interface ResolveResult {
  state: InboxState;
  /** Marks that were cleared during resolution (for metadata projection). */
  cleared: boolean;
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
  // Only compare when the mark recorded a fingerprint; marks recorded without
  // one (older herdr, non-agent panes) fall back to seq comparison only.
  if (!recorded) return true;
  const a = recorded.agent ?? null;
  const b = current?.agent ?? null;
  const av = recorded.value ?? null;
  const bv = current?.value ?? null;
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
  if (seq >= 0 && mark.seq >= 0 && seq > mark.seq) return true;
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
  state: InboxState,
  agents: Record<string, AgentInfo>,
  now: Date,
): { state: InboxState; clearedPaneIds: string[] } {
  const clearedPaneIds: string[] = [];
  for (const [paneId, entry] of Object.entries(state.entries)) {
    const result = resolveEntry(entry, agents[paneId], now);
    if (result.cleared) clearedPaneIds.push(paneId);
    if (!entry.settled && !entry.snoozed) {
      delete state.entries[paneId];
    }
  }
  return { state, clearedPaneIds };
}

function upsertEntry(state: InboxState, pane: PaneInfo, nowIso: string): InboxEntry {
  const existing = state.entries[pane.pane_id];
  const entry: InboxEntry = existing ?? {
    pane_id: pane.pane_id,
    updated_at: nowIso,
  };
  entry.workspace_id = pane.workspace_id ?? entry.workspace_id;
  entry.updated_at = nowIso;
  state.entries[pane.pane_id] = entry;
  return entry;
}

function seqMark(agent: AgentInfo | undefined) {
  return {
    seq: currentSeq(agent),
    agent_session: agentSessionRef(agent),
  };
}

export function settlePane(
  state: InboxState,
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  now: Date,
): InboxEntry {
  const entry = upsertEntry(state, pane, now.toISOString());
  const mark: SettledMark = { at: now.toISOString(), ...seqMark(agent) };
  entry.settled = mark;
  delete entry.snoozed;
  return entry;
}

export function snoozePane(
  state: InboxState,
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  until: Date,
  now: Date,
): InboxEntry {
  const entry = upsertEntry(state, pane, now.toISOString());
  const mark: SnoozedMark = {
    at: now.toISOString(),
    until: until.toISOString(),
    ...seqMark(agent),
  };
  entry.snoozed = mark;
  delete entry.settled;
  return entry;
}

export function restorePane(state: InboxState, paneId: string): boolean {
  const existed = paneId in state.entries;
  delete state.entries[paneId];
  return existed;
}

/**
 * Build the inbox view: every live pane with agent activity plus any pane
 * carrying organize state, resolved against current agent info. Items carry
 * `in_inbox`/`attention` flags; callers decide how to present hidden items.
 */
export function buildInbox(
  panes: PaneInfo[],
  agents: Record<string, AgentInfo>,
  state: InboxState,
  now: Date,
): InboxItem[] {
  const items: InboxItem[] = [];

  const seen = new Set<string>();
  for (const pane of panes) {
    seen.add(pane.pane_id);
    const agent = agents[pane.pane_id];
    const entry = state.entries[pane.pane_id];
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
  for (const [paneId, entry] of Object.entries(state.entries)) {
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
