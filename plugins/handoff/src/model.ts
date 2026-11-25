/**
 * Handoff record model — contract `herdr-plugins.handoff/v1` (issue #103,
 * parent #6 T1). Pure types + validation + identity/staleness logic; no
 * I/O. Persistence lives in state.ts, ref resolution in refs.ts.
 *
 * A handoff record binds a *source* (transfer) identity — Host / herdr
 * session / Workspace / Pane plus `agent_session` and `state_change_seq`
 * generation — to a *payload* of references (never a full transcript
 * copy) and a target hint. The record is "a note plus an execution
 * instruction": it never mutates the source agent's lifecycle and never
 * fabricates execution state.
 */

import { randomBytes } from "node:crypto";
import type {
  AgentInfo,
  PaneInfo,
  SessionSnapshot,
} from "../../../packages/herdr-client/src/snapshot";

export const CONTRACT = "herdr-plugins.handoff/v1";
export const PLUGIN_ID = "rebuildup.handoff";
export const STATE_SCHEMA_VERSION = 1;

/** Bounded excerpt cap (UTF-16 code units); contract-documented budget. */
export const MAX_EXCERPT_CHARS = 8192;
export const MAX_PAYLOAD_REFS = 32;
export const MAX_REQUIREMENTS = 32;
export const MAX_REQUIREMENT_CHARS = 500;
export const MAX_EXTERNAL_VALUE_CHARS = 2048;

export const HANDOFF_STATUSES = [
  "pending",
  "ready",
  "delivered",
  "done",
  "failed",
  "superseded",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/**
 * Ported from T3 Code's ContextHandoff strategy set, simplified for herdr:
 * - `native_resume`: target provider can resume the source agent session.
 * - `portable_context`: fresh target session + bounded payload injected.
 * - `checkpoint_ref`: payload is (or centers on) a checkpoints ref/diff.
 * - `manual`: user-driven transfer; plugin only records the intent.
 */
export const HANDOFF_STRATEGIES = [
  "native_resume",
  "portable_context",
  "checkpoint_ref",
  "manual",
] as const;
export type HandoffStrategy = (typeof HANDOFF_STRATEGIES)[number];

/**
 * Lineage relationship kinds — the T3 Code thread-relationship set
 * (`fork` / `provider_handoff` / `merge_back` / `subagent_spawn` /
 * `subagent_result`, thread-lineage-and-context-transfer.md @ 9cc4018c)
 * mapped onto handoff records. The record itself is the lineage node;
 * `parent_id` links it to the record it derives from or reports to:
 *
 * - `fork` — a new line of work branched from `parent_id`'s context.
 * - `provider_handoff` — same work continuing under a different provider.
 * - `merge_back` — child/fork results folded back into the parent line.
 * - `subagent_spawn` — `parent_id` delegated a bounded task; this record
 *   is the child's execution.
 * - `subagent_result` — this record reports the child's outcome back to
 *   the delegating agent (delivered via `agent.prompt` to the parent's
 *   existing pane, never a second `agent.start`).
 */
export const LINEAGE_KINDS = [
  "fork",
  "provider_handoff",
  "merge_back",
  "subagent_spawn",
  "subagent_result",
] as const;
export type LineageKind = (typeof LINEAGE_KINDS)[number];

/**
 * Parent/child lineage link (#106). `parent_id` is the id of the record
 * this one is linked to — for `subagent_spawn` the delegator's record,
 * for `subagent_result` the spawned child's record, for `fork`/
 * `provider_handoff`/`merge_back` the source-side record. Children are
 * never stored on the parent; they are derived by scanning records for
 * `relationship.parent_id === <id>`.
 */
export interface HandoffRelationship {
  kind: LineageKind;
  parent_id: string;
  /** Optional bounded free-text note about the link. */
  note?: string;
}

/**
 * Allowed status transitions (#104). `pending → ready` happens when the
 * payload is built and the execution plan validated; `ready → delivered`
 * when `agent.start` + the first prompt are accepted by herdr;
 * `delivered → done` on observed target-agent completion, `→ failed` on
 * delivery/observation failure. `superseded` marks a live record
 * replaced by a newer execution for the same source identity.
 */
const TRANSITIONS: Record<HandoffStatus, readonly HandoffStatus[]> = {
  pending: ["ready", "failed", "superseded"],
  ready: ["delivered", "failed", "superseded"],
  delivered: ["done", "failed", "superseded"],
  done: [],
  failed: [],
  superseded: [],
};

export function canTransitionStatus(from: HandoffStatus, to: HandoffStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: HandoffStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** agent_session fingerprint — same convention as rebuildup.inbox/checkpoints. */
export interface AgentSessionRef {
  agent?: string;
  kind?: string;
  value?: string;
}

/**
 * Source identity. `session_key` is the internal namespace discriminator
 * (`hostname + canonical socket path`, same convention as inbox state) —
 * pane ids repeat across sessions, so staleness checks must only compare
 * records against the snapshot of the session they were created in.
 */
export interface TransferIdentity {
  /** `os.hostname()` at create time. */
  host: string;
  /** herdr session name when resolvable; null for the default/implicit socket. */
  herdr_session: string | null;
  /** `hostname + canonical socket path` — internal namespacing only. */
  session_key: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string;
  cwd: string | null;
  /**
   * Opaque provider/harness kind hint (e.g. "claude", "codex") derived
   * from agent reporting. Advisory only — see ADR-0017: routing is the
   * Agent Router's job, never reimplemented here.
   */
  provider_kind: string | null;
  agent_session: AgentSessionRef | null;
  /** `state_change_seq` at create time; null when the agent reports none. */
  state_change_seq: number | null;
}

/** Desired destination. Recorded intent only; T2 (#104) executes it. */
export interface TargetSpec {
  pane_id?: string;
  workspace_id?: string;
  /**
   * Opaque provider/route hint (may be an Agent Router route id like
   * `claude.openrouter`). Never resolved, validated, or launched by this
   * plugin — it is a label for the executor/human to honor.
   */
  provider_hint?: string;
  note?: string;
}

/**
 * Payload references. References, not copies: each entry names an object
 * owned by another plugin's public contract. Resolution is read-side and
 * reported per ref (`resolved` / `missing_ref` / `error` / `external`).
 */
export type PayloadRef =
  | {
      kind: "conversation_session";
      plugin: "rebuildup.conversations";
      /** Session record key `<provider>:<session-id>` from the index. */
      session_key: string;
      /** Optional event-level selectors resolved via `conversations show`. */
      event_refs?: string[];
    }
  | {
      kind: "checkpoint";
      plugin: "rebuildup.checkpoints";
      /** Checkpoint entry id from `checkpoints list`. */
      id: string;
    }
  | {
      /**
       * Another handoff record in this plugin's own state (#106). Used by
       * lineage payloads (e.g. a `subagent_result` referencing the child
       * record it reports on). Resolved against `state.json`, never via
       * an external CLI.
       */
      kind: "handoff_record";
      plugin: "rebuildup.handoff";
      id: string;
    }
  | {
      kind: "external";
      /** What the value points at; never fetched or verified by the plugin. */
      target: "uri" | "path" | "issue";
      value: string;
      label?: string;
    };

export interface PayloadExcerpt {
  text: string;
  /** True when `text` was truncated to MAX_EXCERPT_CHARS. */
  truncated: boolean;
  /** Where the excerpt came from; v1 supports `note` (--note). */
  source: "note";
}

export interface HandoffPayload {
  refs: PayloadRef[];
  excerpt?: PayloadExcerpt;
  /** Explicit requirements/spec pointers (free text, bounded). */
  requirements?: string[];
}

/**
 * Execution record written by `execute` (#104). Absent on T1-era records;
 * `status`/`list` treat a missing `execution` as "never executed".
 *
 * Everything here is *observed* state reported by herdr — the plugin
 * never fabricates agent status. `observed.agent_status` is the raw
 * `agent_status` last seen on the target pane; the record `status`
 * (`done`) is a lifecycle verdict derived from it (see execute.ts).
 */
export interface ExecutionTarget {
  pane_id: string;
  workspace_id: string | null;
  tab_id: string | null;
  /** True when the plugin created the surface; false for `--target-pane` reuse. */
  created: boolean;
}

export interface ExecutionAgent {
  /** Name passed to `agent.start`. */
  name: string;
  /** herdr agent kind the provider hint resolved to (e.g. "claude"). */
  kind: string;
  pane_id: string;
  /** Generation signals captured right after `agent.start` (pre-prompt). */
  agent_session: AgentSessionRef | null;
  state_change_seq: number | null;
  agent_status: string | null;
}

export interface ExecutionError {
  /** Pipeline step that failed: surface|agent_start|prompt|wait. */
  step: string;
  message: string;
  at: string;
}

export interface ExecutionObservation {
  /** Raw herdr `agent_status` on the target pane at `checked_at`. */
  agent_status: string | null;
  pane_present: boolean | null;
  checked_at: string;
}

/**
 * Remote machine the execution targeted (#105). Recorded from the
 * saved-machine profile + probe — the plugin never guesses reachability.
 * `session` is the remote herdr session bound to the machine profile;
 * target pane/workspace ids live in THAT session, not the local one.
 */
export interface RemoteExecutionInfo {
  /** Saved-machine profile id (`herdr machine list --json` `id`). */
  machine_id: string;
  label: string;
  /** SSH target from the profile (host alias / user@host). */
  target: string;
  /** Remote herdr session name bound to the profile. */
  session: string;
  enabled: boolean;
  probed_at: string;
  /** Remote herdr server version reported by `session.snapshot`. */
  server_version: string | null;
  /** Remote API protocol reported by `session.snapshot`. */
  protocol: number | null;
}

/** Portable bundle written for cross-machine execution (#105). */
export interface ExecutionBundle {
  /** `herdr-plugins.handoff/bundle/v1`. */
  contract: string;
  /** Absolute path under the plugin state dir (`bundles/<id>.json`). */
  path: string;
  refs: number;
  plugin_state_refs: number;
  external_refs: number;
}

/** Worktree-backed target created via herdr `worktree.create` (#106). */
export interface ExecutionWorktree {
  /** Checkout path reported by herdr (`WorktreeInfo.path`). */
  path: string;
  branch: string | null;
  is_linked_worktree: boolean;
  /** Workspace herdr opened/created for the worktree. */
  workspace_id: string | null;
}

export interface HandoffExecution {
  /** When the strategy decision + payload build completed (`ready`). */
  decided_at: string;
  /**
   * Strategy actually used. May differ from `record.strategy`:
   * `native_resume` falls back to `portable_context` when the provider
   * cannot resume or no session id is known — `decision` records why.
   */
  strategy_used: "native_resume" | "portable_context";
  /** Provider kind resolved for `agent.start` (opaque hint → kind). */
  provider_kind: string | null;
  /** Human/machine-readable reason for `strategy_used`. */
  decision: string;
  /** Resume argv actually passed to `agent.start` (native_resume only). */
  resume_args: string[] | null;
  target: ExecutionTarget | null;
  agent: ExecutionAgent | null;
  prompt: {
    delivered_at: string;
    /** UTF-16 length of the injected prompt text. */
    chars: number;
    /** Whether a post-delivery `agent.wait` observation was requested. */
    waited: boolean;
  } | null;
  error: ExecutionError | null;
  /** Whether `--cleanup-on-failure` closed a plugin-created pane. */
  cleaned_up: boolean;
  observed: ExecutionObservation | null;
  /** Present for cross-machine execution (`execute --remote`). */
  remote?: RemoteExecutionInfo;
  /** Portable bundle written for cross-machine execution. */
  bundle?: ExecutionBundle;
  /** Present when the target surface is a herdr-managed git worktree. */
  worktree?: ExecutionWorktree;
}

export interface HandoffRecord {
  contract: typeof CONTRACT;
  /** `ho-<base36-ms>-<8hex>` — unique per record. */
  id: string;
  created_at: string;
  updated_at: string;
  status: HandoffStatus;
  strategy: HandoffStrategy;
  transfer: TransferIdentity;
  target: TargetSpec | null;
  payload: HandoffPayload;
  /** Present once `execute` has run (ready or later). */
  execution?: HandoffExecution;
  /**
   * Lineage link (#106): this record's place in a parent/child chain.
   * Absent for root records. Children are derived, never stored.
   */
  relationship?: HandoffRelationship;
}

// --- construction -----------------------------------------------------------

export function newHandoffId(): string {
  return `ho-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Same fingerprint convention as rebuildup.inbox `agentSessionRef`. */
export function agentSessionRef(agent: AgentInfo | undefined | null): AgentSessionRef | null {
  const session = agent?.agent_session;
  if (!session || typeof session !== "object") return null;
  const ref: AgentSessionRef = {};
  if (typeof session.agent === "string") ref.agent = session.agent;
  if (typeof session.kind === "string") ref.kind = session.kind;
  if (typeof session.value === "string") ref.value = session.value;
  return Object.keys(ref).length > 0 ? ref : null;
}

export function buildTransferIdentity(input: {
  host: string;
  herdrSession: string | null;
  sessionKey: string;
  pane: PaneInfo;
  agent: AgentInfo | undefined;
}): TransferIdentity {
  const { pane, agent } = input;
  return {
    host: input.host,
    herdr_session: input.herdrSession,
    session_key: input.sessionKey,
    workspace_id: pane.workspace_id ?? null,
    tab_id: pane.tab_id ?? null,
    pane_id: pane.pane_id,
    cwd: pane.cwd ?? agent?.cwd ?? agent?.foreground_cwd ?? null,
    provider_kind:
      (typeof agent?.agent === "string" && agent.agent !== "" ? agent.agent : null) ??
      (typeof agent?.agent_session?.agent === "string" ? agent.agent_session.agent : null),
    agent_session: agentSessionRef(agent),
    state_change_seq: typeof agent?.state_change_seq === "number" ? agent.state_change_seq : null,
  };
}

export function boundedExcerpt(text: string, source: PayloadExcerpt["source"]): PayloadExcerpt {
  const truncated = text.length > MAX_EXCERPT_CHARS;
  return {
    text: truncated ? text.slice(0, MAX_EXCERPT_CHARS) : text,
    truncated,
    source,
  };
}

/** `http(s)://…` or any `scheme://` → uri; `#123`-style → issue; else path. */
export function guessExternalTarget(value: string): "uri" | "path" | "issue" {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return "uri";
  if (/^(issues?|gh|#)\//i.test(value) || /^#\d+$/.test(value)) return "issue";
  return "path";
}

export function createRecord(input: {
  transfer: TransferIdentity;
  strategy: HandoffStrategy;
  target?: TargetSpec | undefined;
  payload: HandoffPayload;
  relationship?: HandoffRelationship | undefined;
  now?: Date;
}): HandoffRecord {
  const now = (input.now ?? new Date()).toISOString();
  const record: HandoffRecord = {
    contract: CONTRACT,
    id: newHandoffId(),
    created_at: now,
    updated_at: now,
    status: "pending",
    strategy: input.strategy,
    transfer: input.transfer,
    target: input.target ?? null,
    payload: input.payload,
    ...(input.relationship !== undefined ? { relationship: input.relationship } : {}),
  };
  return record;
}

// --- staleness / applicability ----------------------------------------------

export type StaleReason = "pane_missing" | "agent_session_changed" | "generation_regressed";

export type TransferCheck =
  | { state: "ok" }
  | { state: "stale"; reason: StaleReason }
  | { state: "unchecked"; reason: "snapshot_unavailable" | "other_session" };

/**
 * Decide whether a record's source identity still matches a live snapshot.
 *
 * Invariant (AGENTS §4): stale organize/handoff state must never be applied
 * to a different agent generation or a reused pane id. Rules, in order:
 *
 * 1. No snapshot → `unchecked` (never guessed).
 * 2. `session_key` mismatch → `unchecked/other_session`: pane ids are only
 *    unique within one session, so a foreign snapshot proves nothing.
 * 3. Pane absent → `stale/pane_missing`.
 * 4. Recorded `agent_session.value` present and the live value differs
 *    (including live `null`) → `stale/agent_session_changed`.
 * 5. Live `state_change_seq` below the recorded seq → `stale/
 *    generation_regressed` (impossible rewind = wrong generation).
 *
 * A live seq *ahead* of the recorded one is NOT stale: the handoff covers
 * the recorded point in time; later source work is simply uncovered
 * (T3 `coveredRunOrdinals` semantics).
 */
export function checkTransfer(
  record: HandoffRecord,
  snapshot: SessionSnapshot | null,
  currentSessionKey?: string,
): TransferCheck {
  if (snapshot === null) return { state: "unchecked", reason: "snapshot_unavailable" };
  if (currentSessionKey !== undefined && record.transfer.session_key !== currentSessionKey) {
    return { state: "unchecked", reason: "other_session" };
  }
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === record.transfer.pane_id);
  if (!pane) return { state: "stale", reason: "pane_missing" };
  const agent = snapshot.agents?.[record.transfer.pane_id];

  const recorded = record.transfer.agent_session?.value;
  if (recorded !== undefined && recorded !== null && recorded !== "") {
    const live = agent?.agent_session?.value;
    if (live !== recorded) return { state: "stale", reason: "agent_session_changed" };
  }

  const recordedSeq = record.transfer.state_change_seq;
  const liveSeq = agent?.state_change_seq;
  if (typeof recordedSeq === "number" && typeof liveSeq === "number" && liveSeq < recordedSeq) {
    return { state: "stale", reason: "generation_regressed" };
  }
  return { state: "ok" };
}

// --- validation (read-side; writers construct via createRecord) -------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(v: unknown, where: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`invalid ${where}`);
  return v;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optNullableString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseAgentSessionRef(v: unknown): AgentSessionRef | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) throw new Error("invalid agent_session");
  const ref: AgentSessionRef = {};
  const agent = optString(v.agent);
  const kind = optString(v.kind);
  const value = optString(v.value);
  if (agent !== undefined) ref.agent = agent;
  if (kind !== undefined) ref.kind = kind;
  if (value !== undefined) ref.value = value;
  return ref;
}

function parsePayloadRef(v: unknown): PayloadRef {
  if (!isObj(v)) throw new Error("invalid payload ref");
  switch (v.kind) {
    case "conversation_session": {
      if (v.plugin !== "rebuildup.conversations") throw new Error("invalid ref plugin");
      const ref: PayloadRef = {
        kind: "conversation_session",
        plugin: "rebuildup.conversations",
        session_key: reqString(v.session_key, "session_key"),
      };
      if (Array.isArray(v.event_refs)) {
        ref.event_refs = v.event_refs.map((e) => reqString(e, "event_ref"));
      }
      return ref;
    }
    case "checkpoint": {
      if (v.plugin !== "rebuildup.checkpoints") throw new Error("invalid ref plugin");
      return { kind: "checkpoint", plugin: "rebuildup.checkpoints", id: reqString(v.id, "id") };
    }
    case "handoff_record": {
      if (v.plugin !== "rebuildup.handoff") throw new Error("invalid ref plugin");
      return { kind: "handoff_record", plugin: "rebuildup.handoff", id: reqString(v.id, "id") };
    }
    case "external": {
      const target = v.target;
      if (target !== "uri" && target !== "path" && target !== "issue") {
        throw new Error("invalid external target");
      }
      const ref: PayloadRef = {
        kind: "external",
        target,
        value: reqString(v.value, "value"),
      };
      const label = optString(v.label);
      if (label !== undefined) ref.label = label;
      return ref;
    }
    default:
      throw new Error(`unknown payload ref kind: ${String(v.kind)}`);
  }
}

function parsePayload(v: unknown): HandoffPayload {
  if (!isObj(v)) throw new Error("invalid payload");
  if (!Array.isArray(v.refs)) throw new Error("payload.refs must be an array");
  const payload: HandoffPayload = { refs: v.refs.map(parsePayloadRef) };
  if (isObj(v.excerpt)) {
    payload.excerpt = {
      text: reqString(v.excerpt.text, "excerpt.text"),
      truncated: v.excerpt.truncated === true,
      source: "note",
    };
  }
  if (Array.isArray(v.requirements)) {
    payload.requirements = v.requirements.map((r) => reqString(r, "requirement"));
  }
  return payload;
}

function parseTransfer(v: unknown): TransferIdentity {
  if (!isObj(v)) throw new Error("invalid transfer");
  const seq = v.state_change_seq;
  return {
    host: reqString(v.host, "transfer.host"),
    herdr_session: optNullableString(v.herdr_session),
    session_key: reqString(v.session_key, "transfer.session_key"),
    workspace_id: optNullableString(v.workspace_id),
    tab_id: optNullableString(v.tab_id),
    pane_id: reqString(v.pane_id, "transfer.pane_id"),
    cwd: optNullableString(v.cwd),
    provider_kind: optNullableString(v.provider_kind),
    agent_session: parseAgentSessionRef(v.agent_session),
    state_change_seq: typeof seq === "number" ? seq : null,
  };
}

function parseTarget(v: unknown): TargetSpec | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) throw new Error("invalid target");
  const target: TargetSpec = {};
  const paneId = optString(v.pane_id);
  const workspaceId = optString(v.workspace_id);
  const providerHint = optString(v.provider_hint);
  const note = optString(v.note);
  if (paneId !== undefined) target.pane_id = paneId;
  if (workspaceId !== undefined) target.workspace_id = workspaceId;
  if (providerHint !== undefined) target.provider_hint = providerHint;
  if (note !== undefined) target.note = note;
  return target;
}

function parseRelationship(v: unknown): HandoffRelationship {
  if (!isObj(v)) throw new Error("invalid relationship");
  const kind = v.kind;
  if (typeof kind !== "string" || !(LINEAGE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`invalid relationship.kind: ${String(kind)}`);
  }
  const rel: HandoffRelationship = {
    kind: kind as LineageKind,
    parent_id: reqString(v.parent_id, "relationship.parent_id"),
  };
  const note = optString(v.note);
  if (note !== undefined) rel.note = note;
  return rel;
}

function parseExecutionWorktree(v: unknown): ExecutionWorktree {
  if (!isObj(v)) throw new Error("invalid execution.worktree");
  return {
    path: reqString(v.path, "execution.worktree.path"),
    branch: optNullableString(v.branch),
    is_linked_worktree: v.is_linked_worktree === true,
    workspace_id: optNullableString(v.workspace_id),
  };
}

function parseExecution(v: unknown): HandoffExecution {
  if (!isObj(v)) throw new Error("invalid execution");
  const strategyUsed = v.strategy_used;
  if (strategyUsed !== "native_resume" && strategyUsed !== "portable_context") {
    throw new Error(`invalid execution.strategy_used: ${String(strategyUsed)}`);
  }
  const exec: HandoffExecution = {
    decided_at: reqString(v.decided_at, "execution.decided_at"),
    strategy_used: strategyUsed,
    provider_kind: optNullableString(v.provider_kind),
    decision: reqString(v.decision, "execution.decision"),
    resume_args: Array.isArray(v.resume_args)
      ? v.resume_args.map((a) => reqString(a, "resume_arg"))
      : null,
    target: null,
    agent: null,
    prompt: null,
    error: null,
    cleaned_up: v.cleaned_up === true,
    observed: null,
  };
  if (isObj(v.target)) {
    exec.target = {
      pane_id: reqString(v.target.pane_id, "execution.target.pane_id"),
      workspace_id: optNullableString(v.target.workspace_id),
      tab_id: optNullableString(v.target.tab_id),
      created: v.target.created === true,
    };
  }
  if (isObj(v.agent)) {
    exec.agent = {
      name: reqString(v.agent.name, "execution.agent.name"),
      kind: reqString(v.agent.kind, "execution.agent.kind"),
      pane_id: reqString(v.agent.pane_id, "execution.agent.pane_id"),
      agent_session: parseAgentSessionRef(v.agent.agent_session),
      state_change_seq:
        typeof v.agent.state_change_seq === "number" ? v.agent.state_change_seq : null,
      agent_status: optNullableString(v.agent.agent_status),
    };
  }
  if (isObj(v.prompt)) {
    exec.prompt = {
      delivered_at: reqString(v.prompt.delivered_at, "execution.prompt.delivered_at"),
      chars: typeof v.prompt.chars === "number" ? v.prompt.chars : 0,
      waited: v.prompt.waited === true,
    };
  }
  if (isObj(v.error)) {
    exec.error = {
      step: reqString(v.error.step, "execution.error.step"),
      message: reqString(v.error.message, "execution.error.message"),
      at: reqString(v.error.at, "execution.error.at"),
    };
  }
  if (isObj(v.observed)) {
    exec.observed = {
      agent_status: optNullableString(v.observed.agent_status),
      pane_present: typeof v.observed.pane_present === "boolean" ? v.observed.pane_present : null,
      checked_at: reqString(v.observed.checked_at, "execution.observed.checked_at"),
    };
  }
  if (isObj(v.remote)) {
    exec.remote = {
      machine_id: reqString(v.remote.machine_id, "execution.remote.machine_id"),
      label: reqString(v.remote.label, "execution.remote.label"),
      target: reqString(v.remote.target, "execution.remote.target"),
      session: reqString(v.remote.session, "execution.remote.session"),
      enabled: v.remote.enabled === true,
      probed_at: reqString(v.remote.probed_at, "execution.remote.probed_at"),
      server_version: optNullableString(v.remote.server_version),
      protocol: typeof v.remote.protocol === "number" ? v.remote.protocol : null,
    };
  }
  if (isObj(v.bundle)) {
    exec.bundle = {
      contract: reqString(v.bundle.contract, "execution.bundle.contract"),
      path: reqString(v.bundle.path, "execution.bundle.path"),
      refs: typeof v.bundle.refs === "number" ? v.bundle.refs : 0,
      plugin_state_refs:
        typeof v.bundle.plugin_state_refs === "number" ? v.bundle.plugin_state_refs : 0,
      external_refs: typeof v.bundle.external_refs === "number" ? v.bundle.external_refs : 0,
    };
  }
  if (isObj(v.worktree)) {
    exec.worktree = parseExecutionWorktree(v.worktree);
  }
  return exec;
}

/** Strict-ish parser for state.json records; throws on malformed data. */
export function parseHandoffRecord(raw: unknown): HandoffRecord {
  if (!isObj(raw)) throw new Error("handoff record must be an object");
  if (raw.contract !== CONTRACT) throw new Error(`unsupported contract: ${String(raw.contract)}`);
  if (typeof raw.id !== "string" || raw.id === "") throw new Error("invalid id");
  const status = raw.status;
  if (typeof status !== "string" || !(HANDOFF_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`invalid status: ${String(status)}`);
  }
  const strategy = raw.strategy;
  if (
    typeof strategy !== "string" ||
    !(HANDOFF_STRATEGIES as readonly string[]).includes(strategy)
  ) {
    throw new Error(`invalid strategy: ${String(strategy)}`);
  }
  return {
    contract: CONTRACT,
    id: raw.id,
    created_at: reqString(raw.created_at, "created_at"),
    updated_at: reqString(raw.updated_at, "updated_at"),
    status: status as HandoffStatus,
    strategy: strategy as HandoffStrategy,
    transfer: parseTransfer(raw.transfer),
    target: parseTarget(raw.target),
    payload: parsePayload(raw.payload),
    ...(raw.execution !== undefined && raw.execution !== null
      ? { execution: parseExecution(raw.execution) }
      : {}),
    ...(raw.relationship !== undefined && raw.relationship !== null
      ? { relationship: parseRelationship(raw.relationship) }
      : {}),
  };
}
