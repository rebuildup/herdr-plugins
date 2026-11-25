/**
 * Delegation lineage for `rebuildup.handoff` (#106, parent #6 T4).
 *
 * T3 Code models thread relationships (`fork` / `provider_handoff` /
 * `merge_back` / `subagent_spawn` / `subagent_result`) over persistent
 * threads. herdr has no equivalent durable thread object, so the handoff
 * record itself is the lineage node and `record.relationship` carries
 * the link (see model.ts `LINEAGE_KINDS`).
 *
 * Two operations live here:
 *
 * - `delegate` (subagent_spawn): create a CHILD handoff record whose
 *   transfer identity is the delegating agent's pane, then run the
 *   normal `execute` pipeline — the child is a NEW agent started via
 *   `agent.start` in a fresh surface (optionally a herdr worktree).
 * - `merge-back` (subagent_result / merge_back): create a RESULT record
 *   reporting the child's outcome back. Delivery is `agent.prompt` to
 *   the parent agent's EXISTING pane — never a second `agent.start`:
 *   the delegating agent is already running and herdr owns its PTY.
 *
 * Same invariants as execute.ts: live snapshot mandatory, stale source
 * refused before mutation, failures persist `failed` honestly, the
 * plugin never judges the source/child lifecycle.
 */

import type { PaneInfo, SessionSnapshot } from "../../../packages/herdr-client/src/index";
import {
  type ExecuteFlags,
  type ExecuteResult,
  executeHandoff,
  HandoffExecError,
  type HandoffTransport,
  isDoneObservation,
} from "./execute";
import {
  agentSessionRef,
  buildTransferIdentity,
  canTransitionStatus,
  createRecord,
  type ExecutionAgent,
  type ExecutionError,
  type ExecutionObservation,
  type ExecutionTarget,
  type HandoffExecution,
  type HandoffPayload,
  type HandoffRecord,
  type HandoffRelationship,
  type HandoffStrategy,
  MAX_PAYLOAD_REFS,
  type PayloadRef,
} from "./model";
import { loadState, updateState } from "./state";

// --- Shared helpers ------------------------------------------------------------

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function findPane(snapshot: SessionSnapshot, paneId: string): PaneInfo | undefined {
  return (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
}

/**
 * The pane that "owns" a record's agent context: the executed target
 * when present, else the recorded source pane. Used to find the
 * delegating/reporting agent for lineage operations.
 */
export function agentPaneIdOf(record: HandoffRecord): string {
  return record.execution?.target?.pane_id ?? record.transfer.pane_id;
}

/**
 * Result kind for a merge-back: a `fork` child reports via `merge_back`;
 * a `subagent_spawn` child (or any other linked child) via
 * `subagent_result`. Unlinked records have no parent to report to.
 */
export function resultKindFor(child: HandoffRecord): "merge_back" | "subagent_result" {
  return child.relationship?.kind === "fork" ? "merge_back" : "subagent_result";
}

function requireRecord(
  state: { handoffs: Record<string, HandoffRecord> },
  id: string,
): HandoffRecord {
  const record = state.handoffs[id];
  if (record === undefined) {
    throw new HandoffExecError(`handoff not found: ${id}`, "handoff_not_found");
  }
  return record;
}

// --- delegate (subagent_spawn) ----------------------------------------------------

export interface DelegateInput {
  /** Parent/delegator record id. */
  parentId: string;
  payload: HandoffPayload;
  strategy?: HandoffStrategy | undefined;
  /** Free-text note stored on the relationship link. */
  relationshipNote?: string | undefined;
  /** When false, only the child record is created (no execution). */
  execute?: boolean | undefined;
  /** Preview only: build the record, persist and execute nothing. */
  dryRun?: boolean | undefined;
  /** Flags forwarded to `executeHandoff` when `execute` is not false. */
  executeFlags?: ExecuteFlags | undefined;
}

export interface DelegateDeps {
  transport: HandoffTransport;
  sessionKey?: string | undefined;
  now?: (() => Date) | undefined;
}

export interface DelegateResult {
  record: HandoffRecord;
  parent: HandoffRecord;
  /** Present when execution ran. */
  execution?: ExecuteResult;
  dry_run?: boolean;
}

/**
 * Create + optionally execute a `subagent_spawn` child record.
 *
 * The child's transfer identity is the DELEGATING agent's pane (the
 * parent record's executed target, falling back to its source pane) —
 * resolved live from the snapshot, never from stale ids. Delegation is
 * same-session only in v1: the parent record must belong to the
 * caller's session namespace and must not be a remote execution.
 */
export async function delegateHandoff(
  input: DelegateInput,
  deps: DelegateDeps,
): Promise<DelegateResult> {
  const state = await loadState();
  const parent = requireRecord(state, input.parentId);
  if (parent.execution?.remote !== undefined) {
    throw new HandoffExecError(
      `handoff ${input.parentId} is a remote execution; cross-session delegation is not supported in v1`,
      "unsupported_lineage",
      { parent_id: input.parentId },
    );
  }
  if (deps.sessionKey !== undefined && parent.transfer.session_key !== deps.sessionKey) {
    throw new HandoffExecError(
      `handoff ${input.parentId} belongs to a different herdr session; delegation is same-session only in v1`,
      "other_session",
      { parent_id: input.parentId },
    );
  }

  let snapshot: SessionSnapshot;
  try {
    snapshot = await deps.transport.snapshot();
  } catch (err) {
    throw new HandoffExecError(
      `herdr session unreachable: ${errorMessage(err)}`,
      "session_unreachable",
    );
  }

  const delegatorPaneId = agentPaneIdOf(parent);
  const pane = findPane(snapshot, delegatorPaneId);
  if (pane === undefined) {
    throw new HandoffExecError(
      `delegating pane ${delegatorPaneId} (handoff ${input.parentId}) not found in session snapshot`,
      "delegator_missing",
      { pane_id: delegatorPaneId, parent_id: input.parentId },
    );
  }
  const agent = snapshot.agents?.[delegatorPaneId];

  const relationship: HandoffRelationship = {
    kind: "subagent_spawn",
    parent_id: parent.id,
    ...(input.relationshipNote !== undefined ? { note: input.relationshipNote } : {}),
  };
  const record = createRecord({
    transfer: buildTransferIdentity({
      host: parent.transfer.host,
      herdrSession: parent.transfer.herdr_session,
      sessionKey: deps.sessionKey ?? parent.transfer.session_key,
      pane,
      agent,
    }),
    strategy: input.strategy ?? "portable_context",
    payload: input.payload,
    relationship,
  });

  if (input.dryRun === true) {
    return { record, parent, dry_run: true };
  }

  await updateState((s) => {
    // Re-check inside the lock: the parent must still exist.
    requireRecord(s, input.parentId);
    s.handoffs[record.id] = record;
  });

  if (input.execute === false) {
    return { record, parent };
  }
  const execution = await executeHandoff(record.id, input.executeFlags ?? {}, {
    transport: deps.transport,
    sessionKey: deps.sessionKey,
  });
  const fresh = (await loadState()).handoffs[record.id] as HandoffRecord;
  return { record: fresh, parent, execution };
}

// --- merge-back (subagent_result / merge_back) ------------------------------------

export interface MergeBackInput {
  /** Child record id whose outcome is reported back. */
  childId: string;
  payload: HandoffPayload;
  relationshipNote?: string | undefined;
  waitMs?: number | undefined;
  /** When false, only the result record is created (no delivery). */
  execute?: boolean | undefined;
  /** Preview only: build the record + prompt, persist and deliver nothing. */
  dryRun?: boolean | undefined;
}

export interface MergeBackDeps {
  transport: HandoffTransport;
  sessionKey?: string | undefined;
  now?: (() => Date) | undefined;
}

export interface MergeBackResult {
  record: HandoffRecord;
  child: HandoffRecord;
  parent: HandoffRecord;
  outcome: "delivered" | "done" | "dry_run" | "failed" | "recorded";
  prompt_text?: string;
  error?: ExecutionError;
}

/**
 * Build the first-prompt text for a result delivery. References stay
 * references; the receiving (parent) agent resolves them on demand.
 */
export function buildResultPrompt(
  record: HandoffRecord,
  child: HandoffRecord,
  parent: HandoffRecord,
): string {
  const lines: string[] = [
    `[herdr handoff ${record.id}]`,
    `Subagent result for handoff ${child.id} (relationship: ${record.relationship?.kind ?? "result"}).`,
    `The delegated work executed on pane=${child.execution?.target?.pane_id ?? child.transfer.pane_id}` +
      ` workspace=${child.execution?.target?.workspace_id ?? child.transfer.workspace_id ?? "?"}` +
      ` cwd=${child.transfer.cwd ?? "?"}; its outcome is reported below.`,
    `Parent context: handoff ${parent.id} on pane=${agentPaneIdOf(parent)}.`,
    "",
    "References (resolve via the owning plugin's public CLI for full detail):",
  ];
  if (record.payload.refs.length === 0) {
    lines.push("- (none)");
  } else {
    for (const ref of record.payload.refs) lines.push(describeResultRef(ref));
  }
  if (record.payload.requirements && record.payload.requirements.length > 0) {
    lines.push("", "Requirements:");
    for (const req of record.payload.requirements) lines.push(`- ${req}`);
  }
  if (record.payload.excerpt) {
    lines.push(
      "",
      `Result excerpt (source: ${record.payload.excerpt.source}${record.payload.excerpt.truncated ? ", truncated" : ""}):`,
      record.payload.excerpt.text,
    );
  }
  lines.push(
    "",
    "This is a result report, not a new task assignment. Judge the child's outcome from the references above; do not assume success — the child record's status is the observed verdict.",
  );
  return `${lines.join("\n")}\n`;
}

function describeResultRef(ref: PayloadRef): string {
  switch (ref.kind) {
    case "conversation_session": {
      const events = ref.event_refs?.length ? ` (events: ${ref.event_refs.join(", ")})` : "";
      return `- conversation_session ${ref.plugin}: ${ref.session_key}${events}`;
    }
    case "checkpoint":
      return `- checkpoint ${ref.plugin}: ${ref.id}`;
    case "handoff_record":
      return `- handoff_record ${ref.plugin}: ${ref.id}`;
    case "external": {
      const label = ref.label !== undefined ? ` (${ref.label})` : "";
      return `- external ${ref.target}: ${ref.value}${label}`;
    }
  }
}

/**
 * Create + deliver a result record back to the delegating agent.
 *
 * The result record's `relationship.parent_id` is the CHILD record it
 * reports on; the delivery target is resolved through the child's own
 * `relationship.parent_id` (the delegator). Delivery is `agent.prompt`
 * to the parent agent's existing pane — `agent.start` is never called
 * on a pane that already runs an agent.
 */
export async function mergeBackHandoff(
  input: MergeBackInput,
  deps: MergeBackDeps,
): Promise<MergeBackResult> {
  const now = deps.now ?? (() => new Date());

  const state = await loadState();
  const child = requireRecord(state, input.childId);
  if (child.execution?.remote !== undefined) {
    throw new HandoffExecError(
      `handoff ${input.childId} is a remote execution; merge-back is same-session only in v1`,
      "unsupported_lineage",
      { child_id: input.childId },
    );
  }
  const grandparentId = child.relationship?.parent_id;
  if (grandparentId === undefined) {
    throw new HandoffExecError(
      `handoff ${input.childId} has no lineage parent; nothing to report back to`,
      "no_parent",
      { child_id: input.childId },
    );
  }
  const parent = requireRecord(state, grandparentId);
  if (parent.execution?.remote !== undefined) {
    throw new HandoffExecError(
      `parent handoff ${grandparentId} is a remote execution; merge-back is same-session only in v1`,
      "unsupported_lineage",
      { parent_id: grandparentId },
    );
  }
  if (deps.sessionKey !== undefined && child.transfer.session_key !== deps.sessionKey) {
    throw new HandoffExecError(
      `handoff ${input.childId} belongs to a different herdr session; merge-back is same-session only in v1`,
      "other_session",
      { child_id: input.childId },
    );
  }
  const childPaneId = child.execution?.target?.pane_id ?? child.transfer.pane_id;
  if (child.execution?.target == null) {
    throw new HandoffExecError(
      `handoff ${input.childId} was never executed; there is no child agent outcome to report`,
      "child_not_executed",
      { child_id: input.childId },
    );
  }
  const parentPaneId = agentPaneIdOf(parent);

  let snapshot: SessionSnapshot;
  try {
    snapshot = await deps.transport.snapshot();
  } catch (err) {
    throw new HandoffExecError(
      `herdr session unreachable: ${errorMessage(err)}`,
      "session_unreachable",
    );
  }

  // The reporting side (child pane) must still exist — its identity is
  // the result record's transfer. A gone child pane is reported, not
  // fabricated: the record can still be created but delivery of the
  // *report* only needs the parent pane.
  const childPane = findPane(snapshot, childPaneId);
  const parentPane = findPane(snapshot, parentPaneId);
  if (parentPane === undefined) {
    throw new HandoffExecError(
      `parent agent pane ${parentPaneId} (handoff ${grandparentId}) not found in session snapshot`,
      "parent_missing",
      { pane_id: parentPaneId, parent_id: grandparentId },
    );
  }
  const parentAgent = snapshot.agents?.[parentPaneId];
  const parentBusy =
    typeof parentAgent?.agent === "string" && parentAgent.agent !== "" ? parentAgent.agent : null;
  if (parentBusy === null) {
    throw new HandoffExecError(
      `parent pane ${parentPaneId} runs no agent; a result report needs a live delegating agent (use execute for a fresh target)`,
      "parent_agent_missing",
      { pane_id: parentPaneId, parent_id: grandparentId },
    );
  }

  // Payload: the child record ref is always included (bounded), then
  // caller-supplied refs. Cap is enforced, never silently exceeded.
  const refs: PayloadRef[] = [
    { kind: "handoff_record", plugin: "rebuildup.handoff", id: child.id },
  ];
  for (const ref of input.payload.refs) {
    if (refs.length >= MAX_PAYLOAD_REFS) break;
    refs.push(ref);
  }
  const payload: HandoffPayload = { ...input.payload, refs };

  const kind = resultKindFor(child);
  const relationship: HandoffRelationship = {
    kind,
    parent_id: child.id,
    ...(input.relationshipNote !== undefined ? { note: input.relationshipNote } : {}),
  };

  // Transfer identity: prefer the live child pane; fall back to the
  // recorded child transfer when the pane is gone (reported honestly via
  // transfer_check on later reads).
  const transferSource =
    childPane !== undefined
      ? {
          pane: childPane,
          agent: snapshot.agents?.[childPaneId],
          host: child.transfer.host,
          herdrSession: child.transfer.herdr_session,
          sessionKey: deps.sessionKey ?? child.transfer.session_key,
        }
      : null;
  const record = createRecord({
    transfer: transferSource
      ? buildTransferIdentity({
          host: transferSource.host,
          herdrSession: transferSource.herdrSession,
          sessionKey: transferSource.sessionKey,
          pane: transferSource.pane,
          agent: transferSource.agent,
        })
      : child.transfer,
    strategy: "portable_context",
    payload,
    relationship,
  });

  const promptText = buildResultPrompt(record, child, parent);

  if (input.dryRun === true) {
    return { record, child, parent, outcome: "dry_run", prompt_text: promptText };
  }

  if (input.execute === false) {
    await updateState((s) => {
      requireRecord(s, input.childId);
      requireRecord(s, grandparentId);
      s.handoffs[record.id] = record;
    });
    return { record, child, parent, outcome: "recorded", prompt_text: promptText };
  }

  // --- deliver: agent.prompt to the parent's EXISTING agent pane ------------
  const execution: HandoffExecution = {
    decided_at: nowIso(now),
    strategy_used: "portable_context",
    provider_kind: parentAgent?.agent ?? parent.transfer.provider_kind,
    decision:
      kind === "merge_back"
        ? `merge_back: result of fork ${child.id} prompted back to parent agent pane ${parentPaneId} (no agent.start — parent agent already running)`
        : `subagent_result: outcome of delegated handoff ${child.id} prompted back to parent agent pane ${parentPaneId} (no agent.start — parent agent already running)`,
    resume_args: null,
    target: {
      pane_id: parentPaneId,
      workspace_id: parentPane.workspace_id ?? null,
      tab_id: parentPane.tab_id ?? null,
      created: false,
    } satisfies ExecutionTarget,
    agent: null,
    prompt: null,
    error: null,
    cleaned_up: false,
    observed: null,
  };

  const fail = async (step: string, err: unknown): Promise<MergeBackResult> => {
    const execError: ExecutionError = { step, message: errorMessage(err), at: nowIso(now) };
    await updateState((s) => {
      const r = s.handoffs[record.id];
      if (r === undefined) return;
      if (r.execution) r.execution.error = execError;
      if (r.status === "pending" || r.status === "ready") r.status = "failed";
      r.updated_at = nowIso(now);
    });
    const fresh = (await loadState()).handoffs[record.id] as HandoffRecord;
    return { record: fresh, child, parent, outcome: "failed", error: execError };
  };

  // ready → capture parent agent baseline → prompt → delivered.
  await updateState((s) => {
    requireRecord(s, input.childId);
    requireRecord(s, grandparentId);
    const r = createRecordRef(s, record);
    r.status = "ready";
    r.execution = execution;
    r.updated_at = nowIso(now);
  });

  let agentInfo: ExecutionAgent;
  try {
    const agent = await deps.transport.agentGet(parentPaneId);
    agentInfo = {
      name: typeof agent.agent === "string" && agent.agent !== "" ? agent.agent : "parent agent",
      kind: parent.transfer.provider_kind ?? parentAgent?.agent ?? "unknown",
      pane_id: parentPaneId,
      agent_session: agentSessionRefOf(agent),
      state_change_seq: typeof agent.state_change_seq === "number" ? agent.state_change_seq : null,
      agent_status: typeof agent.agent_status === "string" ? agent.agent_status : null,
    };
  } catch (err) {
    return await fail("prompt", err);
  }
  execution.agent = agentInfo;

  try {
    await deps.transport.agentPrompt(parentPaneId, promptText);
  } catch (err) {
    return await fail("prompt", err);
  }
  execution.prompt = {
    delivered_at: nowIso(now),
    chars: promptText.length,
    waited: input.waitMs !== undefined,
  };

  await updateState((s) => {
    const r = s.handoffs[record.id];
    if (r === undefined) return;
    if (canTransitionStatus(r.status, "delivered")) r.status = "delivered";
    if (r.execution) {
      r.execution.agent = agentInfo;
      r.execution.prompt = execution.prompt;
      r.execution.error = null;
    }
    r.updated_at = nowIso(now);
  });

  // Optional bounded observation → done verdict (same rule as execute).
  if (input.waitMs !== undefined) {
    try {
      await deps.transport.agentWait(
        parentPaneId,
        { until: ["idle", "done", "blocked"], timeoutMs: input.waitMs },
        input.waitMs + 30_000,
      );
    } catch {
      // wait timeout → stays delivered; lazy status reconcile continues.
    }
    const current = (await loadState()).handoffs[record.id];
    if (current?.status === "delivered") {
      let obs: ExecutionObservation;
      try {
        const agent = await deps.transport.agentGet(parentPaneId);
        obs = {
          agent_status: typeof agent.agent_status === "string" ? agent.agent_status : null,
          pane_present: true,
          checked_at: nowIso(now),
        };
        const liveSeq = typeof agent.state_change_seq === "number" ? agent.state_change_seq : null;
        await updateState((s) => {
          const r = s.handoffs[record.id];
          if (r?.execution) r.execution.observed = obs;
          if (
            r &&
            r.status === "delivered" &&
            isDoneObservation(obs.agent_status, liveSeq, agentInfo.state_change_seq)
          ) {
            r.status = "done";
          }
          if (r) r.updated_at = nowIso(now);
        });
      } catch {
        obs = { agent_status: null, pane_present: null, checked_at: nowIso(now) };
        await updateState((s) => {
          const r = s.handoffs[record.id];
          if (r?.execution) r.execution.observed = obs;
          if (r) r.updated_at = nowIso(now);
        });
      }
    }
  }

  const finalRecord = (await loadState()).handoffs[record.id] as HandoffRecord;
  const outcome =
    finalRecord.status === "done"
      ? "done"
      : finalRecord.status === "delivered"
        ? "delivered"
        : finalRecord.status === "failed"
          ? "failed"
          : "recorded";
  return { record: finalRecord, child, parent, outcome };
}

function agentSessionRefOf(agent: {
  agent_session?: { agent?: string; kind?: string; value?: string } | null;
}): ExecutionAgent["agent_session"] {
  return agentSessionRef(agent as Parameters<typeof agentSessionRef>[0]);
}

function createRecordRef(
  s: { handoffs: Record<string, HandoffRecord> },
  record: HandoffRecord,
): HandoffRecord {
  // The record was built but not yet persisted in the ready write for
  // the execute path; insert it now if absent.
  const existing = s.handoffs[record.id];
  if (existing !== undefined) return existing;
  s.handoffs[record.id] = record;
  return record;
}
