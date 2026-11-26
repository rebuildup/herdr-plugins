/**
 * Pure logic for `inbox watch-pr` (Issue #178): turn `git pr view` /
 * `git pr comments` / `git pr checks` payloads into a normalized PR
 * observation, diff consecutive observations into attention-return
 * triggers, and manage watch-target selection and baseline pruning.
 *
 * Everything here is I/O-free so the state machine is unit-testable.
 * Only *observed* forge data drives triggers — never PTY text, never
 * guessed statuses (inbox invariant).
 */

import type { AgentInfo, PaneInfo } from "../../../packages/herdr-client/src/snapshot";
import { resolveEntry } from "./model";
import type {
  InboxEntry,
  InboxState,
  LinkWatch,
  LinkWatchObservation,
  PaneLink,
  WatchTerminal,
} from "./state";
import { sessionWatch } from "./state";

// ---------------------------------------------------------------------------
// Observation building
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function loginOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  return asString(asRecord(value).login);
}

/** gh `pr checks` buckets that mean "this check is not passing". */
const FAILING_CHECK_BUCKETS = new Set(["fail", "cancel"]);

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameLogin(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Build a normalized observation from the three git-plugin CLI payloads.
 * `viewDoc` is the `pr view` stdout document (`{…, pr: {…}}`), `commentsDoc`
 * the `pr comments` document (`{…, issue_comments, line_comments}`), and
 * `checksDoc` the `pr checks` document (`{…, checks}`). Returns an error
 * string when a payload is missing its expected shape — callers treat
 * that as a failed poll, never as data.
 */
export function buildObservation(
  viewDoc: Record<string, unknown>,
  commentsDoc: Record<string, unknown>,
  checksDoc: Record<string, unknown>,
): LinkWatchObservation | { error: string } {
  const pr = asRecord(viewDoc.pr);
  if (Object.keys(pr).length === 0) {
    return { error: "git pr view payload missing `pr` object" };
  }

  const author = loginOf(pr.author);

  // Reviews: `pr view` carries the newest ≤10 reviews as
  // {author, state, submittedAt}. Self-authored reviews (PR author as the
  // self proxy — the agent that opened the PR) never wake the pane.
  const reviewKeys: string[] = [];
  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  for (const entry of reviews) {
    const r = asRecord(entry);
    const reviewer = loginOf(r.author);
    if (sameLogin(reviewer, author)) continue;
    reviewKeys.push(
      `${reviewer ?? "?"}|${asString(r.state) ?? "?"}|${asString(r.submittedAt) ?? "?"}`,
    );
  }

  // Comments: issue (conversation) + line-level review comments. The PR
  // author's own comments are excluded for the same self-proxy reason.
  const commentKeys: string[] = [];
  for (const listName of ["issue_comments", "line_comments"] as const) {
    const list = Array.isArray(commentsDoc[listName]) ? commentsDoc[listName] : [];
    for (const entry of list as unknown[]) {
      const c = asRecord(entry);
      if (sameLogin(loginOf(c.author), author)) continue;
      const id = c.id;
      if (typeof id === "number" || typeof id === "string") {
        commentKeys.push(String(id));
      }
    }
  }

  // Checks: `gh pr checks --json` buckets — fail/cancel count as failing.
  const failingChecks: string[] = [];
  const checks = Array.isArray(checksDoc.checks) ? checksDoc.checks : [];
  for (const entry of checks as unknown[]) {
    const c = asRecord(entry);
    const bucket = asString(c.bucket)?.toLowerCase() ?? null;
    if (bucket !== null && FAILING_CHECK_BUCKETS.has(bucket)) {
      failingChecks.push(asString(c.name) ?? asString(c.state) ?? "?");
    }
  }

  const mergeable = pr.mergeable;
  return {
    state: (asString(pr.state) ?? "UNKNOWN").toUpperCase(),
    isDraft: pr.isDraft === true,
    mergeStateStatus: asString(pr.mergeStateStatus),
    mergeable: typeof mergeable === "string" ? mergeable : null,
    updatedAt: asString(pr.updatedAt),
    author,
    failingChecks: sortedUnique(failingChecks),
    reviewKeys: sortedUnique(reviewKeys),
    commentKeys: sortedUnique(commentKeys),
  };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export type WatchTrigger =
  | "merged"
  | "closed"
  | "check_failed"
  | "merge_conflict"
  | "review"
  | "comment";

export interface WatchDiff {
  triggers: WatchTrigger[];
  terminal?: WatchTerminal | undefined;
  /** New failing check names (for the event payload). */
  newFailingChecks: string[];
  newReviewCount: number;
  newCommentCount: number;
}

const TERMINAL_STATES: Record<string, WatchTerminal> = {
  MERGED: "merged",
  CLOSED: "closed",
};

/**
 * Diff a fresh observation against the stored baseline. The first
 * observation (no baseline) never triggers — it only establishes the
 * baseline, and an already-terminal PR is recorded terminal silently so
 * linking a merged/closed PR cannot fabricate attention.
 */
export function diffObservation(
  prev: LinkWatchObservation | undefined,
  next: LinkWatchObservation,
): WatchDiff {
  const empty: WatchDiff = {
    triggers: [],
    newFailingChecks: [],
    newReviewCount: 0,
    newCommentCount: 0,
  };
  if (!prev) {
    const terminal = TERMINAL_STATES[next.state];
    return terminal ? { ...empty, terminal } : empty;
  }

  const triggers: WatchTrigger[] = [];
  const diff: WatchDiff = {
    triggers,
    newFailingChecks: [],
    newReviewCount: 0,
    newCommentCount: 0,
  };

  // Lifecycle: only a transition *into* MERGED/CLOSED qualifies.
  const terminal = TERMINAL_STATES[next.state];
  if (terminal !== undefined && prev.state !== next.state) {
    triggers.push(terminal === "merged" ? "merged" : "closed");
    diff.terminal = terminal;
  }

  const prevFailing = new Set(prev.failingChecks);
  diff.newFailingChecks = next.failingChecks.filter((name) => !prevFailing.has(name));
  if (diff.newFailingChecks.length > 0) triggers.push("check_failed");

  // Merge conflict: transition INTO DIRTY (mergeable=false/conflict).
  // Other mergeStateStatus churn (BLOCKED↔UNSTABLE↔BEHIND↔CLEAN) is
  // observed in the poll payload but deliberately does not wake — it is
  // volatile and would flap (see docs/specs/inbox.md).
  if (next.mergeStateStatus === "DIRTY" && prev.mergeStateStatus !== "DIRTY") {
    triggers.push("merge_conflict");
  }

  const prevReviews = new Set(prev.reviewKeys);
  diff.newReviewCount = next.reviewKeys.filter((key) => !prevReviews.has(key)).length;
  if (diff.newReviewCount > 0) triggers.push("review");

  const prevComments = new Set(prev.commentKeys);
  diff.newCommentCount = next.commentKeys.filter((key) => !prevComments.has(key)).length;
  if (diff.newCommentCount > 0) triggers.push("comment");

  return diff;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/** Exponential failure backoff, capped at 30 minutes. */
export function pollBackoffMs(intervalMs: number, consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures, 1), 5);
  return Math.min(intervalMs * 2 ** exponent, 30 * 60_000);
}

// ---------------------------------------------------------------------------
// Target selection & baseline pruning
// ---------------------------------------------------------------------------

export interface WatchTarget {
  paneId: string;
  link: PaneLink;
  /** Ref key used in the watch map (`<repo>#<number>`). */
  ref: string;
  baseline: LinkWatch | undefined;
}

export interface WatchTargetScan {
  /** Live-pane, still-linked PR targets (terminal/deferred flagged on baseline). */
  targets: WatchTarget[];
  /** Pane ids carrying links but absent from the snapshot. */
  absentPaneIds: string[];
  /** Total declared `pr` links seen (any pane state). */
  totalPrLinks: number;
  /** Links whose baseline is already terminal. */
  terminalCount: number;
}

/**
 * Collect watch targets from resolved session entries. `entries` must
 * already have gone through `resolveState`/`resolveEntry` so stale links
 * are filtered. Only `kind === "pr"` links are watched — issue links have
 * no git-plugin public read surface (see docs/specs/inbox.md).
 */
export function collectWatchTargets(
  entries: Record<string, InboxEntry>,
  watchSession: Record<string, Record<string, LinkWatch>> | undefined,
  livePaneIds: ReadonlySet<string>,
  paneFilter: string | undefined,
): WatchTargetScan {
  const targets: WatchTarget[] = [];
  const absentPaneIds: string[] = [];
  let totalPrLinks = 0;
  let terminalCount = 0;

  for (const [paneId, entry] of Object.entries(entries)) {
    if (paneFilter !== undefined && paneId !== paneFilter) continue;
    const prLinks = (entry.links ?? []).filter((link) => link.kind === "pr");
    totalPrLinks += prLinks.length;
    if (prLinks.length === 0) continue;
    if (!livePaneIds.has(paneId)) {
      absentPaneIds.push(paneId);
      continue;
    }
    const paneWatch = watchSession?.[paneId] ?? {};
    for (const link of prLinks) {
      const baseline = paneWatch[link.ref];
      if (baseline?.terminal !== undefined) terminalCount += 1;
      targets.push({ paneId, link, ref: link.ref, baseline });
    }
  }
  return { targets, absentPaneIds, totalPrLinks, terminalCount };
}

/**
 * Drop watch baselines that no longer correspond to a live declared PR
 * link (unlinked refs, closed panes, stale links). Called inside the
 * state commit so baselines cannot leak or resurrect for recycled
 * identities. Returns the number of removed baselines.
 */
export function pruneWatchSession(
  state: InboxState,
  sessionKey: string,
  entries: Record<string, InboxEntry>,
  agents: Record<string, AgentInfo>,
  panes: PaneInfo[],
  now: Date,
): number {
  const watch = state.watch?.[sessionKey];
  if (!watch) return 0;
  const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
  let removed = 0;

  for (const [paneId, paneWatch] of Object.entries(watch)) {
    const entry = entries[paneId];
    const pane = panes.find((p) => p.pane_id === paneId);
    const agent = agents[paneId];
    // Re-resolve the entry so staleness is judged against live data.
    let liveLinks: PaneLink[] = [];
    if (entry && pane && livePaneIds.has(paneId)) {
      resolveEntry(entry, agent, now);
      liveLinks = (entry.links ?? []).filter((link) => link.kind === "pr");
    }
    const liveRefs = new Set(liveLinks.map((link) => link.ref));
    for (const ref of Object.keys(paneWatch)) {
      if (!liveRefs.has(ref)) {
        delete paneWatch[ref];
        removed += 1;
      }
    }
    if (Object.keys(paneWatch).length === 0) {
      delete watch[paneId];
      removed += 1;
    }
  }
  if (Object.keys(watch).length === 0 && state.watch) {
    delete state.watch[sessionKey];
  }
  return removed;
}

/** Ensure the watch map exists for a session (write path). */
export function ensureSessionWatch(
  state: InboxState,
  sessionKey: string,
): Record<string, Record<string, LinkWatch>> {
  return sessionWatch(state, sessionKey);
}
