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
import type {
  AgentSessionRef,
  ArchivedMark,
  GenerationMark,
  InboxEntry,
  LinkKind,
  PaneLink,
  PinnedMark,
  SettledMark,
  SnoozedMark,
} from "./state";

export type OrganizeKind = "settled" | "snoozed" | "archived";

export interface OrganizeView {
  kind: OrganizeKind;
  /** ISO timestamp the organize state was applied. */
  since: string;
  /** Snooze deadline (snoozed only). */
  until?: string;
}

/** Public view of a stored PaneLink (fingerprint/seq internals omitted). */
export interface InboxLink {
  kind: LinkKind;
  repo: string;
  number: number;
  ref: string;
  at: string;
}

export function toPublicLink(link: PaneLink): InboxLink {
  return { kind: link.kind, repo: link.repo, number: link.number, ref: link.ref, at: link.at };
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
  /** True while the pane carries a live pinned mark. */
  pinned: boolean;
  /** Manual order rank; lower sorts first. Undefined = unordered. */
  order?: number | undefined;
  /** True when the pane currently requires user attention. */
  attention: boolean;
  /** False when organize state hides the pane from the default inbox view. */
  in_inbox: boolean;
  /** User-declared tracker links (possibly empty). */
  links: InboxLink[];
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
 * Link staleness: a declared tracker reference is dropped when the pane's
 * agent-session fingerprint no longer matches (agent generation swap) or
 * when the recorded `state_change_seq` regresses (pane/agent identity
 * recycled). `state_change_seq` advances on routine status transitions, so
 * — unlike organize marks — a forward seq advance never expires a link:
 * the association describes the work, not a transient status. Links on
 * panes absent from the snapshot are tolerated (fingerprint may be
 * temporarily unreportable) and still die with the entry on `pane.closed`
 * or retention pruning.
 */
function linkStale(link: PaneLink, agent: AgentInfo | undefined): boolean {
  if (!sameAgentSession(link.agent_session, agentSessionRef(agent))) return true;
  const seq = currentSeq(agent);
  if (seq >= 0 && link.seq >= 0 && seq < link.seq) return true;
  return false;
}

/** True while the entry carries any organize state worth retaining. */
function entryHasState(entry: InboxEntry): boolean {
  return (
    entry.settled !== undefined ||
    entry.snoozed !== undefined ||
    entry.archived !== undefined ||
    entry.pinned !== undefined ||
    entry.order !== undefined ||
    (entry.links?.length ?? 0) > 0
  );
}

/**
 * Resolve one entry against the live agent snapshot. Returns the surviving
 * organize view (snooze > settle > archive take display precedence) and
 * whether any mark was cleared. Mutates `entry` in place.
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
  if (entry.archived && markExpiredOrAdvanced(entry.archived, agent, now)) {
    delete entry.archived;
    cleared = true;
  }
  if (entry.pinned && markExpiredOrAdvanced(entry.pinned, agent, now)) {
    delete entry.pinned;
    cleared = true;
  }
  if (entry.links) {
    const kept = entry.links.filter((link) => !linkStale(link, agent));
    if (kept.length !== entry.links.length) {
      entry.links = kept.length > 0 ? kept : undefined;
      cleared = true;
    }
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
  if (entry.archived) {
    return {
      organize: { kind: "archived", since: entry.archived.at },
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
    if (!entryHasState(entry)) {
      delete entries[paneId];
    }
  }
  return { clearedPaneIds };
}

export function upsertEntry(
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

function generationMark(agent: AgentInfo | undefined, now: Date): GenerationMark {
  return { at: now.toISOString(), ...seqMark(agent) };
}

export function settlePane(
  entries: Record<string, InboxEntry>,
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  now: Date,
): InboxEntry {
  const entry = upsertEntry(entries, pane, now.toISOString());
  const mark: SettledMark = generationMark(agent, now);
  entry.settled = mark;
  delete entry.snoozed;
  delete entry.archived;
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
  delete entry.archived;
  return entry;
}

/**
 * Archive is a hide-kind like settle: it removes the pane from the default
 * inbox view but never touches herdr execution state. Attention still
 * forces the pane back into view, and the mark auto-clears on agent
 * generation advance like every other organize mark.
 */
export function archivePane(
  entries: Record<string, InboxEntry>,
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  now: Date,
): InboxEntry {
  const entry = upsertEntry(entries, pane, now.toISOString());
  const mark: ArchivedMark = generationMark(agent, now);
  entry.archived = mark;
  delete entry.settled;
  delete entry.snoozed;
  return entry;
}

/** Pin is an ordering flag, not a hide-kind: it never affects `in_inbox`. */
export function pinPane(
  entries: Record<string, InboxEntry>,
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  now: Date,
): InboxEntry {
  const entry = upsertEntry(entries, pane, now.toISOString());
  const mark: PinnedMark = generationMark(agent, now);
  entry.pinned = mark;
  return entry;
}

/** Drop the entry once no organize state remains (marks, pin, or order). */
function dropIfEmpty(entries: Record<string, InboxEntry>, paneId: string): void {
  const entry = entries[paneId];
  if (entry && !entryHasState(entry)) delete entries[paneId];
}

export function unpinPane(entries: Record<string, InboxEntry>, paneId: string, now: Date): boolean {
  const entry = entries[paneId];
  if (!entry?.pinned) return false;
  delete entry.pinned;
  entry.updated_at = now.toISOString();
  dropIfEmpty(entries, paneId);
  return true;
}

export function unarchivePane(
  entries: Record<string, InboxEntry>,
  paneId: string,
  now: Date,
): boolean {
  const entry = entries[paneId];
  if (!entry?.archived) return false;
  delete entry.archived;
  entry.updated_at = now.toISOString();
  dropIfEmpty(entries, paneId);
  return true;
}

export interface NewPaneLink {
  kind: LinkKind;
  repo: string;
  number: number;
  ref: string;
}

/**
 * Declare (or re-declare) a tracker link on a pane. Re-linking the same
 * kind+repo+number re-stamps `at` and the identity fingerprint — that is
 * the explicit re-validation path for a link whose guard went stale.
 */
export function linkPane(
  entries: Record<string, InboxEntry>,
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  link: NewPaneLink,
  now: Date,
): InboxEntry {
  const entry = upsertEntry(entries, pane, now.toISOString());
  const record: PaneLink = {
    ...link,
    at: now.toISOString(),
    seq: currentSeq(agent),
    agent_session: agentSessionRef(agent),
  };
  const links = entry.links ?? [];
  const index = links.findIndex(
    (existing) =>
      existing.kind === link.kind && existing.repo === link.repo && existing.number === link.number,
  );
  if (index >= 0) {
    links[index] = record;
  } else {
    links.push(record);
  }
  entry.links = links;
  return entry;
}

/** Remove one declared link; returns the removed record for echo. */
export function unlinkPane(
  entries: Record<string, InboxEntry>,
  paneId: string,
  kind: LinkKind,
  repo: string,
  number: number,
  now: Date,
): PaneLink | undefined {
  const entry = entries[paneId];
  const links = entry?.links;
  if (!entry || !links) return undefined;
  const index = links.findIndex(
    (link) => link.kind === kind && link.repo === repo && link.number === number,
  );
  if (index === -1) return undefined;
  const [removed] = links.splice(index, 1);
  entry.updated_at = now.toISOString();
  if (links.length === 0) delete entry.links;
  dropIfEmpty(entries, paneId);
  return removed;
}

/**
 * Restore clears organize state (marks, pin, order) but preserves declared
 * tracker links — they are work references, not organize state. `unlink`
 * and `pane.closed` are the link removal paths.
 */
export function restorePane(entries: Record<string, InboxEntry>, paneId: string): boolean {
  const entry = entries[paneId];
  if (!entry) return false;
  const links = entry.links;
  delete entries[paneId];
  if (links && links.length > 0) {
    entries[paneId] = {
      pane_id: paneId,
      workspace_id: entry.workspace_id,
      links,
      updated_at: entry.updated_at,
    };
  }
  return true;
}

export type OrderPlacement =
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "before"; paneId: string }
  | { kind: "after"; paneId: string };

/**
 * Compute dense order ranks for a manual reorder. Ordering is scoped to the
 * moved pane's display group — items sharing its `attention` and `pinned`
 * flags — because the list sort orders by those flags before `order`.
 * `siblings` must be the visible inbox items of that group in current
 * display order, including the moved pane. Returns pane_id → rank (lower
 * sorts first) for every sibling, or an error string.
 */
export function computeOrderRanks(
  siblings: InboxItem[],
  movedPaneId: string,
  placement: OrderPlacement,
): Map<string, number> | { error: string } {
  const moved = siblings.find((item) => item.pane_id === movedPaneId);
  if (!moved) return { error: `pane is not in the inbox order group: ${movedPaneId}` };
  const rest = siblings.filter((item) => item.pane_id !== movedPaneId);

  let index: number;
  if (placement.kind === "first") {
    index = 0;
  } else if (placement.kind === "last") {
    index = rest.length;
  } else {
    const refIndex = rest.findIndex((item) => item.pane_id === placement.paneId);
    if (refIndex === -1) {
      return { error: `reference pane is not in the same inbox group: ${placement.paneId}` };
    }
    index = placement.kind === "before" ? refIndex : refIndex + 1;
  }

  const sequence = [...rest.slice(0, index), moved, ...rest.slice(index)];
  const ranks = new Map<string, number>();
  for (const [i, item] of sequence.entries()) {
    ranks.set(item.pane_id, i);
  }
  return ranks;
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

/** Read-side list filters; they never mutate state. */
export interface InboxFilters {
  /** Keep only items currently requiring attention (`blocked`). */
  attention?: boolean;
  /** Keep items whose organize kind matches; "none" = no hide-kind mark. */
  organize?: OrganizeKind | "none";
  /** Case-insensitive substring over title, cwd, and pane_id. */
  search?: string;
  /** Exact workspace_id match. */
  workspace?: string;
}

export function applyInboxFilters(items: InboxItem[], filters: InboxFilters): InboxItem[] {
  const needle = filters.search?.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.attention === true && !item.attention) return false;
    if (filters.organize !== undefined) {
      const matches =
        filters.organize === "none"
          ? item.organize === undefined
          : item.organize?.kind === filters.organize;
      if (!matches) return false;
    }
    if (filters.workspace !== undefined && item.workspace_id !== filters.workspace) return false;
    if (needle) {
      const haystack = [item.title, item.cwd, item.pane_id]
        .filter((field): field is string => typeof field === "string")
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
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
      pinned: entry?.pinned !== undefined,
      order: entry?.order,
      attention,
      in_inbox: !hidden,
      links: (entry?.links ?? []).map(toPublicLink),
    });
  }

  // Organize entries for panes missing from the snapshot (closed panes) are
  // retained in state but reported as absent rather than fabricated. Entries
  // carrying only links are reported too so declared references stay visible.
  for (const [paneId, entry] of Object.entries(entries)) {
    if (seen.has(paneId)) continue;
    const resolved = resolveEntry(entry, undefined, now);
    const links = (entry.links ?? []).map(toPublicLink);
    if (resolved.organize || links.length > 0) {
      items.push({
        pane_id: paneId,
        workspace_id: entry.workspace_id,
        organize: resolved.organize,
        pinned: entry.pinned !== undefined,
        order: entry.order,
        attention: false,
        in_inbox: false,
        links,
      });
    }
  }

  // Display order: pinned first (pin is the strongest user placement
  // signal), then attention (never hidden, always surfaced), then manual
  // order rank, then pane id. Items without an order rank sort after
  // ordered ones.
  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    return a.pane_id.localeCompare(b.pane_id);
  });
  return items;
}
