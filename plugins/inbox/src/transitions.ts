/**
 * Organize-transition log for the inbox plugin (#182, ADR-0029).
 *
 * Every real organize mutation appends one `InboxTransition` inside the
 * same `updateState` critical section that persists the mark — the log
 * is the plugin's own publication of state it owns, never a fabricated
 * herdr event. Consumers (rebuildup.projects settle triggers) read it
 * through the public `transitions` CLI command.
 */

import type { AgentInfo, PaneInfo } from "../../../packages/herdr-client/src/snapshot";
import { agentSessionRef } from "./model";
import type { ClearedCause, InboxState, InboxTransition, TransitionKind } from "./state";

/** Per-session retention cap, matching the entry-cap discipline. */
export const MAX_TRANSITIONS_PER_SESSION = 500;

/** Snapshot-derived fields shared by every transition kind. */
export interface TransitionContext {
  pane?: PaneInfo | undefined;
  agent?: AgentInfo | undefined;
  /** Fallback workspace id (e.g. from a surviving entry) when the pane is gone. */
  workspaceId?: string | undefined;
  at: string;
}

function contextFields(
  paneId: string,
  ctx: TransitionContext,
): Pick<
  InboxTransition,
  "pane_id" | "workspace_id" | "cwd" | "agent_status" | "state_change_seq" | "agent_session"
> {
  const agent = ctx.agent;
  const fields: Pick<
    InboxTransition,
    "pane_id" | "workspace_id" | "cwd" | "agent_status" | "state_change_seq" | "agent_session"
  > = { pane_id: paneId };
  const workspaceId = ctx.pane?.workspace_id ?? ctx.workspaceId;
  if (workspaceId !== undefined) fields.workspace_id = workspaceId;
  const cwd = agent?.cwd ?? agent?.foreground_cwd ?? ctx.pane?.cwd;
  if (cwd !== undefined) fields.cwd = cwd;
  if (agent?.agent_status !== undefined) fields.agent_status = agent.agent_status;
  if (typeof agent?.state_change_seq === "number") {
    fields.state_change_seq = agent.state_change_seq;
  }
  fields.agent_session = agentSessionRef(agent);
  return fields;
}

/**
 * Append one transition to the per-session log inside `updateState`.
 * `seq` is assigned here (per-session monotonic); overflow drops the
 * oldest items and counts them in `dropped`.
 */
export function appendTransition(
  state: InboxState,
  sessionKey: string,
  input: {
    kind: TransitionKind;
    paneId: string;
    ctx: TransitionContext;
    cause?: ClearedCause | undefined;
  },
): InboxTransition {
  if (state.transitions === undefined) state.transitions = {};
  const logs = state.transitions;
  let log = logs[sessionKey];
  if (log === undefined) {
    log = { seq: 0, dropped: 0, items: [] };
    logs[sessionKey] = log;
  }
  const seq = log.seq + 1;
  log.seq = seq;
  const item: InboxTransition = {
    seq,
    at: input.ctx.at,
    kind: input.kind,
    ...contextFields(input.paneId, input.ctx),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  };
  log.items.push(item);
  const overflow = log.items.length - MAX_TRANSITIONS_PER_SESSION;
  if (overflow > 0) {
    log.items.splice(0, overflow);
    log.dropped += overflow;
  }
  return item;
}

/** User-driven organize mutation (settle/snooze/restore commands). */
export function appendOrganizeTransition(
  state: InboxState,
  sessionKey: string,
  kind: "settled" | "snoozed" | "restored",
  paneId: string,
  ctx: TransitionContext,
): InboxTransition {
  return appendTransition(state, sessionKey, { kind, paneId, ctx });
}

/**
 * Record `cleared` transitions for marks removed by expiry/generation
 * resolution. `cause` is the resolution outcome (`expired` |
 * `generation` | `session_mismatch`); `pane_closed`/`pruned` are
 * recorded by their own call sites.
 */
export function appendClearedTransitions(
  state: InboxState,
  sessionKey: string,
  paneId: string,
  marks: ReadonlyArray<{ cause: ClearedCause }>,
  ctx: TransitionContext,
): void {
  // One cleared record per removed mark would spam the log for panes
  // carrying several marks; the consumer only needs "organize state for
  // this pane was cleared". Collapse to a single record using the first
  // (primary) cause.
  const first = marks[0];
  if (!first) return;
  appendTransition(state, sessionKey, {
    kind: "cleared",
    paneId,
    ctx,
    cause: first.cause,
  });
}
