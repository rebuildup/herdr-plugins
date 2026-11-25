/**
 * Same-host handoff execution for `rebuildup.handoff` (#104, parent #6 T2).
 *
 * Pipeline: validate (snapshot + staleness gate) → decide strategy →
 * build bounded prompt → mark `ready` → create/reuse target surface via
 * herdr API only → `agent.start` → `agent.prompt` injection → `delivered`
 * → optional bounded `agent.wait` observation → `done`.
 *
 * Hard rules (AGENTS §4 / ADR-0017 / contract):
 * - Panes/workspaces are created ONLY through herdr's socket API
 *   (`workspace.create` / `tab.create`); the plugin never owns a PTY.
 * - `provider_hint` stays an opaque label: its first `.`-segment is used
 *   as the herdr agent `kind` for `agent.start`, nothing more. The Agent
 *   Router launcher is never invoked.
 * - A record whose `transfer_check` is not `ok` is refused BEFORE any
 *   mutation; the record stays `pending`/`ready`.
 * - Failures after `ready` persist `status: "failed"` with a structured
 *   `execution.error{step,message}` — success is never fabricated.
 *   `--cleanup-on-failure` closes only plugin-*created* panes; a reused
 *   `--target-pane` is never closed.
 * - `done` is an observed verdict, not an assumption: the target agent's
 *   raw `agent_status` must be `done`, or `idle` with
 *   `state_change_seq` advanced past the pre-prompt baseline. Anything
 *   else stays `delivered` with `execution.observed` reporting truth.
 */

import {
  type AgentGetResult,
  type AgentPromptWaitOptions,
  type AgentStartOptions,
  type AgentStatus,
  agentGet,
  agentPrompt,
  agentStart,
  agentWait,
  type CallOptions,
  type PaneInfo,
  paneClose,
  type SessionSnapshot,
  sessionSnapshot,
  type TabCreatedResult,
  tabCreate,
  type WorkspaceCreatedResult,
  workspaceCreate,
} from "../../../packages/herdr-client/src/index";
import {
  agentSessionRef,
  canTransitionStatus,
  checkTransfer,
  type ExecutionAgent,
  type ExecutionBundle,
  type ExecutionError,
  type ExecutionObservation,
  type ExecutionTarget,
  type HandoffExecution,
  type HandoffRecord,
  type HandoffStrategy,
  type PayloadRef,
  type RemoteExecutionInfo,
} from "./model";
import type { RemoteProbe } from "./remote";
import { buildPortableBundle, bundleFilePath, remoteInfoOf, writeBundle } from "./remote";
import { buildResumeArgs, resumeInfo } from "./resume";
import { loadState, updateState } from "./state";

// --- Errors -----------------------------------------------------------------

export class HandoffExecError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// --- Transport ---------------------------------------------------------------

export interface SurfaceCreateParams {
  cwd?: string | undefined;
  label?: string | undefined;
  focus?: boolean | undefined;
}

/**
 * Injectable herdr surface. Mirrors the wrappers in
 * packages/herdr-client; tests substitute a fake. The trailing
 * `timeoutMs` on prompt/wait is the *client* request timeout (must
 * outlive any server-side wait), distinct from the server `timeout_ms`.
 */
export interface HandoffTransport {
  snapshot(): Promise<SessionSnapshot>;
  workspaceCreate(params: SurfaceCreateParams): Promise<WorkspaceCreatedResult>;
  tabCreate(
    params: SurfaceCreateParams & { workspace_id?: string | undefined },
  ): Promise<TabCreatedResult>;
  agentStart(params: AgentStartOptions): Promise<unknown>;
  agentGet(target: string): Promise<AgentGetResult>;
  agentPrompt(
    target: string,
    text: string,
    wait?: AgentPromptWaitOptions,
    timeoutMs?: number,
  ): Promise<unknown>;
  agentWait(
    target: string,
    params: { until?: AgentStatus[] | undefined; timeoutMs?: number | undefined },
    timeoutMs?: number,
  ): Promise<unknown>;
  paneClose(paneId: string): Promise<unknown>;
}

/** Server-side `agent.start` startup timeout (upstream: >3000, <=300000). */
export const AGENT_START_TIMEOUT_MS = 60_000;
/** Client ceiling added on top of any server-side wait. */
const CLIENT_MARGIN_MS = 30_000;

/** Adapt the typed herdr-client wrappers for one invocation. */
export function herdrTransport(options: CallOptions = {}): HandoffTransport {
  return {
    snapshot: () => sessionSnapshot(options),
    workspaceCreate: (params) => workspaceCreate(params, options),
    tabCreate: (params) => tabCreate(params, options),
    agentStart: (params) =>
      agentStart(params, {
        ...options,
        timeoutMs: Math.max(
          options.timeoutMs ?? 0,
          (params.timeoutMs ?? AGENT_START_TIMEOUT_MS) + CLIENT_MARGIN_MS,
        ),
      }),
    agentGet: (target) => agentGet(target, options),
    agentPrompt: (target, text, wait, timeoutMs) =>
      agentPrompt(target, text, wait, {
        ...options,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    agentWait: (target, params, timeoutMs) =>
      agentWait(target, params, {
        ...options,
        timeoutMs:
          timeoutMs ?? Math.max(options.timeoutMs ?? 0, (params.timeoutMs ?? 0) + CLIENT_MARGIN_MS),
      }),
    paneClose: (paneId) => paneClose(paneId, options),
  };
}

// --- Provider / strategy decision --------------------------------------------

/**
 * Resolve the agent `kind` for `agent.start`. `provider_hint` /
 * `--provider` use the `harness.provider` route-id convention: the
 * first `.`-segment is the harness kind (e.g. `claude.openrouter` →
 * `claude`). Anything else is used verbatim. This is the ONLY thing the
 * plugin derives from the hint — route resolution stays with the Agent
 * Router boundary (ADR-0017).
 */
export function resolveProviderKind(
  record: HandoffRecord,
  providerOverride?: string | undefined,
): string | null {
  const hint = providerOverride ?? record.target?.provider_hint ?? null;
  if (hint !== null && hint !== "") {
    const dot = hint.indexOf(".");
    const stem = dot === -1 ? hint : hint.slice(0, dot);
    return stem !== "" ? stem : null;
  }
  return record.transfer.provider_kind;
}

export interface StrategyDecision {
  requested: HandoffStrategy;
  used: "native_resume" | "portable_context";
  provider_kind: string;
  reason: string;
  resume_args: string[] | null;
}

/**
 * Decide `native_resume` vs `portable_context`. `native_resume` requires
 * BOTH a provider whose resume capability is `supported` AND a recorded
 * `agent_session.value` to resume; anything else falls back to
 * `portable_context` with the reason recorded — resume is preferred but
 * never faked (provider-switching-and-context.md semantics).
 */
export function decideStrategy(
  record: HandoffRecord,
  providerOverride?: string | undefined,
): StrategyDecision {
  if (record.strategy === "checkpoint_ref" || record.strategy === "manual") {
    throw new HandoffExecError(
      `strategy "${record.strategy}" is recorded intent only and is not executable in this version; recreate with --strategy portable_context or native_resume`,
      "unsupported_strategy",
      { strategy: record.strategy },
    );
  }
  const provider = resolveProviderKind(record, providerOverride);
  if (provider === null) {
    throw new HandoffExecError(
      "no provider kind resolvable for agent.start; pass --provider or set target.provider_hint / a provider_kind on the source pane",
      "provider_unknown",
    );
  }
  if (record.strategy === "native_resume") {
    const info = resumeInfo(provider);
    const sessionId = record.transfer.agent_session?.value;
    const hasSessionId = typeof sessionId === "string" && sessionId !== "";
    if (info.native_resume === "supported" && info.resume_args_template !== null && hasSessionId) {
      const args = buildResumeArgs(info.resume_args_template, sessionId as string);
      return {
        requested: record.strategy,
        used: "native_resume",
        provider_kind: provider,
        reason: `provider "${provider}" supports native resume; resuming agent_session ${sessionId} with args [${args.join(" ")}]`,
        resume_args: args,
      };
    }
    const why =
      info.native_resume !== "supported"
        ? `provider "${provider}" native_resume is ${info.native_resume}`
        : hasSessionId
          ? "resume argv template missing"
          : "no agent_session.value recorded on the source identity";
    return {
      requested: record.strategy,
      used: "portable_context",
      provider_kind: provider,
      reason: `native_resume requested but ${why}; falling back to portable_context (fresh session + bounded payload)`,
      resume_args: null,
    };
  }
  return {
    requested: record.strategy,
    used: "portable_context",
    provider_kind: provider,
    reason: "portable_context: fresh target session + bounded payload injected as the first prompt",
    resume_args: null,
  };
}

// --- Prompt construction -------------------------------------------------------

/**
 * Hard safety bound on the injected prompt. The payload budgets
 * (excerpt ≤ 8192, refs ≤ 32, requirements ≤ 32×500) keep real prompts
 * near ~28k chars; exceeding this means the budgets were bypassed and
 * injection is refused rather than silently truncated.
 */
export const MAX_PROMPT_CHARS = 65_536;

function describeRef(ref: PayloadRef): string {
  switch (ref.kind) {
    case "conversation_session": {
      const events = ref.event_refs?.length ? ` (events: ${ref.event_refs.join(", ")})` : "";
      return `- conversation_session ${ref.plugin}: ${ref.session_key}${events}`;
    }
    case "checkpoint":
      return `- checkpoint ${ref.plugin}: ${ref.id}`;
    case "external": {
      const label = ref.label !== undefined ? ` (${ref.label})` : "";
      return `- external ${ref.target}: ${ref.value}${label}`;
    }
  }
}

/**
 * Build the first-prompt text carrying the bounded payload. References
 * are listed for the receiving agent to resolve on demand through the
 * owning plugins' public CLIs — the payload itself stays references +
 * excerpt, never a transcript copy.
 */
export function buildHandoffPrompt(
  record: HandoffRecord,
  decision: StrategyDecision,
  context?: { remote?: { label: string; target: string; session: string }; bundlePath?: string },
): string {
  const t = record.transfer;
  const lines: string[] = [
    `[herdr handoff ${record.id}]`,
    `This session continues work transferred from another herdr agent session.`,
    `Source: provider_kind=${t.provider_kind ?? "unknown"} pane=${t.pane_id}` +
      ` workspace=${t.workspace_id ?? "?"} tab=${t.tab_id ?? "?"} cwd=${t.cwd ?? "?"}` +
      ` host=${t.host} herdr_session=${t.herdr_session ?? "default"}.`,
  ];
  if (decision.used === "native_resume") {
    lines.push(
      `Strategy native_resume: the provider session was resumed natively; the delta context for this transfer follows.`,
    );
  } else {
    lines.push(
      `Strategy portable_context: this is a fresh session; the bounded payload below is the initial context.`,
    );
  }
  if (t.agent_session?.value) {
    lines.push(`Source agent_session: ${t.agent_session.value}`);
  }
  lines.push("", "References (resolve via the owning plugin's public CLI for full detail):");
  if (record.payload.refs.length === 0) {
    lines.push("- (none)");
  } else {
    for (const ref of record.payload.refs) lines.push(describeRef(ref));
  }
  if (record.payload.requirements && record.payload.requirements.length > 0) {
    lines.push("", "Requirements:");
    for (const req of record.payload.requirements) lines.push(`- ${req}`);
  }
  if (record.payload.excerpt) {
    lines.push(
      "",
      `Excerpt (source: ${record.payload.excerpt.source}${record.payload.excerpt.truncated ? ", truncated" : ""}):`,
      record.payload.excerpt.text,
    );
  }
  if (context?.remote !== undefined) {
    lines.push(
      "",
      `Cross-machine transfer: target host is remote machine "${context.remote.label}" (${context.remote.target}, herdr session ${context.remote.session}).`,
      "Payload refs of kind conversation_session/checkpoint resolve against rebuildup.* plugin state on the SOURCE host; on this host they are external_ref — do not assume the owning plugins or their state exist here.",
      ...(context.bundlePath !== undefined
        ? [
            `Portable bundle written at ${context.bundlePath} (contract herdr-plugins.handoff/bundle/v1).`,
          ]
        : []),
    );
  }
  const text = `${lines.join("\n")}\n`;
  if (text.length > MAX_PROMPT_CHARS) {
    throw new HandoffExecError(
      `handoff prompt exceeds ${MAX_PROMPT_CHARS} chars (${text.length}); payload budgets exceeded`,
      "payload_too_large",
    );
  }
  return text;
}

// --- Target plan ---------------------------------------------------------------

export type TargetPlan =
  | { kind: "existing_pane"; pane: PaneInfo }
  | { kind: "tab"; workspace_id: string }
  | { kind: "workspace" };

export interface ExecuteFlags {
  targetPane?: string | undefined;
  targetWorkspace?: string | undefined;
  newWorkspace?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  cleanupOnFailure?: boolean | undefined;
  waitMs?: number | undefined;
  dryRun?: boolean | undefined;
  /** Saved-machine selector for cross-machine execution (#105). */
  remote?: string | undefined;
}

function paneBusy(snapshot: SessionSnapshot, paneId: string): boolean {
  const agent = snapshot.agents?.[paneId];
  return typeof agent?.agent === "string" && agent.agent !== "";
}

function requireUsablePane(snapshot: SessionSnapshot, paneId: string): PaneInfo {
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
  if (!pane) {
    throw new HandoffExecError(
      `target pane not found in session snapshot: ${paneId}`,
      "target_not_found",
    );
  }
  if (paneBusy(snapshot, paneId)) {
    throw new HandoffExecError(
      `target pane ${paneId} already runs an agent; refusing to start another`,
      "target_busy",
      { pane_id: paneId },
    );
  }
  return pane;
}

/**
 * Resolve WHERE the handoff lands. Precedence: explicit flags >
 * `record.target` hints > a dedicated new workspace (cwd inherited from
 * the source). All checks are read-only — nothing is created here.
 */
export function resolveTargetPlan(
  record: HandoffRecord,
  snapshot: SessionSnapshot,
  flags: ExecuteFlags,
): TargetPlan {
  const explicit = [
    flags.targetPane !== undefined,
    flags.targetWorkspace !== undefined,
    flags.newWorkspace === true,
  ].filter(Boolean).length;
  if (explicit > 1) {
    throw new HandoffExecError(
      "choose at most one of --target-pane, --target-workspace, --new-workspace",
      "usage",
    );
  }

  // Explicit flags fully override the recorded target hints.
  const paneId = flags.targetPane ?? (explicit === 0 ? record.target?.pane_id : undefined);
  if (paneId !== undefined) {
    return { kind: "existing_pane", pane: requireUsablePane(snapshot, paneId) };
  }
  const workspaceId =
    flags.targetWorkspace ?? (explicit === 0 ? record.target?.workspace_id : undefined);
  if (workspaceId !== undefined) {
    return { kind: "tab", workspace_id: workspaceId };
  }
  // Default (and --new-workspace): a dedicated workspace inheriting the
  // source cwd. A bare provider_hint/note target also lands here.
  return { kind: "workspace" };
}

// --- Observation / done verdict -------------------------------------------------

export interface TargetCheck {
  state: "ok" | "pane_missing" | "unchecked";
  reason: string | null;
  agent_status: string | null;
  pane_present: boolean | null;
  agent_session: ExecutionAgent["agent_session"];
  state_change_seq: number | null;
}

/**
 * Locate the execution target inside a session snapshot. Same
 * session_key gating as `checkTransfer`: a foreign snapshot proves
 * nothing about this record's panes.
 */
export function checkTarget(
  record: HandoffRecord,
  snapshot: SessionSnapshot | null,
  currentSessionKey?: string,
): TargetCheck {
  const empty: TargetCheck = {
    state: "unchecked",
    reason: null,
    agent_status: null,
    pane_present: null,
    agent_session: null,
    state_change_seq: null,
  };
  const target = record.execution?.target;
  if (target === null || target === undefined) {
    return { ...empty, reason: "not_executed" };
  }
  if (snapshot === null) return { ...empty, reason: "snapshot_unavailable" };
  if (currentSessionKey !== undefined && record.transfer.session_key !== currentSessionKey) {
    return { ...empty, reason: "other_session" };
  }
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === target.pane_id);
  if (!pane) {
    return { ...empty, state: "pane_missing", pane_present: false, reason: "target_pane_missing" };
  }
  const agent = snapshot.agents?.[target.pane_id];
  return {
    state: "ok",
    reason: null,
    agent_status: typeof agent?.agent_status === "string" ? agent.agent_status : null,
    pane_present: true,
    agent_session: agentSessionRef(agent),
    state_change_seq: typeof agent?.state_change_seq === "number" ? agent.state_change_seq : null,
  };
}

/**
 * `done` verdict: raw `agent_status === "done"`, or `idle` with
 * `state_change_seq` strictly beyond the pre-prompt baseline (evidence
 * the agent actually ran a turn after delivery). `blocked`, `working`,
 * missing panes, and unchanged seq all stay `delivered` — the observed
 * status is reported, never reinterpreted as success.
 */
export function isDoneObservation(
  agentStatus: string | null,
  liveSeq: number | null,
  baselineSeq: number | null,
): boolean {
  if (agentStatus === "done") return true;
  if (agentStatus === "idle" && baselineSeq !== null && liveSeq !== null && liveSeq > baselineSeq) {
    return true;
  }
  return false;
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code !== undefined && /timeout|timed out/i.test(code)) return true;
    return /timeout|timed out/i.test(err.message);
  }
  return false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Execute --------------------------------------------------------------------

export interface ExecuteDeps {
  /** LOCAL transport: source-identity snapshot + same-host execution. */
  transport: HandoffTransport;
  /** `sessionKeyFor(options)` — gates staleness to the record's session. */
  sessionKey?: string | undefined;
  now?: (() => Date) | undefined;
  /**
   * Cross-machine execution (#105): a probed remote machine plus its
   * transport. When present, target planning/creation/prompt/observation
   * run against the REMOTE session snapshot+transport while the source
   * staleness gate still reads the LOCAL snapshot. The caller (CLI)
   * resolves and probes the machine BEFORE calling — a failed probe is
   * a pre-mutation refusal, never a fabricated execution.
   */
  remote?: { probe: RemoteProbe; transport: HandoffTransport } | undefined;
}

export interface ExecuteResult {
  record: HandoffRecord;
  outcome: "delivered" | "done" | "dry_run" | "failed";
  /** Present for dry_run: the resolved plan + prompt, nothing mutated. */
  plan?: TargetPlan;
  decision?: ReturnType<typeof decideStrategy>;
  prompt_text?: string;
  /** Present for remote execution: probed machine identity. */
  remote?: RemoteExecutionInfo;
  /** Present for outcome "failed": the persisted execution error. */
  error?: ExecutionError;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

/**
 * Execute a handoff record end-to-end. Throws `HandoffExecError` for
 * pre-mutation refusals (record untouched); returns `outcome:"failed"`
 * with the persisted `failed` record for post-`ready` failures.
 */
export async function executeHandoff(
  id: string,
  flags: ExecuteFlags,
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  const now = deps.now ?? (() => new Date());
  const transport = deps.transport;

  const state = await loadState();
  const record = state.handoffs[id];
  if (record === undefined) {
    throw new HandoffExecError(`handoff not found: ${id}`, "handoff_not_found");
  }
  if (record.status !== "pending" && record.status !== "ready") {
    throw new HandoffExecError(
      `handoff ${id} has status "${record.status}"; only pending/ready records can execute`,
      "invalid_state",
      { status: record.status },
    );
  }

  // Live snapshot is mandatory: the staleness gate and target planning
  // both read it. Unreachable → honest error, record untouched.
  let snapshot: SessionSnapshot;
  try {
    snapshot = await transport.snapshot();
  } catch (err) {
    throw new HandoffExecError(
      `herdr session unreachable: ${errorMessage(err)}`,
      "session_unreachable",
    );
  }
  const transferCheck = checkTransfer(record, snapshot, deps.sessionKey);
  if (transferCheck.state !== "ok") {
    throw new HandoffExecError(
      `refusing to apply handoff ${id}: source identity check is ${transferCheck.state}` +
        (transferCheck.state === "stale"
          ? ` (${transferCheck.reason})`
          : ` (${transferCheck.reason})`),
      "stale_source",
      { transfer_check: transferCheck },
    );
  }

  const remote = deps.remote;
  const remoteInfo = remote !== undefined ? remoteInfoOf(remote.probe) : undefined;

  const decision = decideStrategy(record, flags.provider);
  // The prompt may reference the bundle path before the file exists; the
  // path is deterministic, and the bundle is written before `ready`.
  const promptText = buildHandoffPrompt(
    record,
    decision,
    remote !== undefined && remoteInfo !== undefined
      ? {
          remote: {
            label: remoteInfo.label,
            target: remoteInfo.target,
            session: remoteInfo.session,
          },
          bundlePath: bundleFilePath(id),
        }
      : undefined,
  );
  // Target planning reads the REMOTE snapshot for cross-machine runs —
  // pane/workspace ids live in the remote session, not the local one.
  const plan = resolveTargetPlan(record, remote?.probe.snapshot ?? snapshot, flags);

  if (flags.dryRun === true) {
    return {
      record,
      outcome: "dry_run",
      plan,
      decision,
      prompt_text: promptText,
      ...(remoteInfo !== undefined ? { remote: remoteInfo } : {}),
    };
  }

  // Portable bundle (#105): written BEFORE the ready transition so a
  // bundle-write failure leaves the record pending — never a delivered
  // remote handoff without its portable payload on disk.
  let bundleInfo: ExecutionBundle | undefined;
  if (remote !== undefined && remoteInfo !== undefined) {
    const bundle = buildPortableBundle(record, remoteInfo, now());
    try {
      await writeBundle(bundle, id);
    } catch (err) {
      throw new HandoffExecError(
        `portable bundle write failed: ${errorMessage(err)}`,
        "bundle_write",
      );
    }
    const pluginStateRefs = bundle.payload.refs.filter(
      (r) => r.portability === "plugin_state",
    ).length;
    bundleInfo = {
      contract: bundle.contract,
      path: bundleFilePath(id),
      refs: bundle.payload.refs.length,
      plugin_state_refs: pluginStateRefs,
      external_refs: bundle.payload.refs.length - pluginStateRefs,
    };
  }

  // Execution surface transport: remote CLI bridge for cross-machine,
  // the injected local transport otherwise.
  const execTransport = remote?.transport ?? transport;

  // --- pending|ready → ready -------------------------------------------------
  const execution: HandoffExecution = {
    decided_at: nowIso(now),
    strategy_used: decision.used,
    provider_kind: decision.provider_kind,
    decision: decision.reason,
    resume_args: decision.resume_args,
    target: record.execution?.target ?? null,
    agent: record.execution?.agent ?? null,
    prompt: record.execution?.prompt ?? null,
    error: null,
    cleaned_up: record.execution?.cleaned_up ?? false,
    observed: record.execution?.observed ?? null,
    ...(remoteInfo !== undefined ? { remote: remoteInfo } : {}),
    ...(bundleInfo !== undefined ? { bundle: bundleInfo } : {}),
  };
  await updateState((s) => {
    const r = s.handoffs[id];
    if (r === undefined)
      throw new HandoffExecError(`handoff not found: ${id}`, "handoff_not_found");
    if (!canTransitionStatus(r.status, "ready") && r.status !== "ready") {
      throw new HandoffExecError(
        `handoff ${id} cannot transition ${r.status} → ready`,
        "invalid_state",
      );
    }
    r.status = "ready";
    r.execution = execution;
    r.updated_at = nowIso(now);
  });

  // --- surface creation --------------------------------------------------------
  const fail = async (step: string, err: unknown): Promise<ExecuteResult> => {
    const message = errorMessage(err);
    const execError: ExecutionError = { step, message, at: nowIso(now) };
    // Cleanup only ever closes a pane THIS plugin created.
    let cleanedUp = false;
    if (flags.cleanupOnFailure === true && execution.target?.created === true) {
      try {
        await execTransport.paneClose(execution.target.pane_id);
        cleanedUp = true;
      } catch {
        // Best-effort: the pane may already be gone; record what happened.
      }
    }
    await updateState((s) => {
      const r = s.handoffs[id];
      if (r?.execution) {
        r.execution.error = execError;
        r.execution.cleaned_up = cleanedUp;
      }
      if (r && (r.status === "pending" || r.status === "ready")) {
        r.status = "failed";
      }
      if (r) r.updated_at = nowIso(now);
    });
    const fresh = await loadState();
    return { record: fresh.handoffs[id] as HandoffRecord, outcome: "failed", error: execError };
  };

  try {
    if (execution.target === null) {
      let surface: ExecutionTarget;
      if (plan.kind === "existing_pane") {
        surface = {
          pane_id: plan.pane.pane_id,
          workspace_id: plan.pane.workspace_id ?? null,
          tab_id: plan.pane.tab_id ?? null,
          created: false,
        };
      } else if (plan.kind === "tab") {
        const created = await execTransport.tabCreate({
          workspace_id: plan.workspace_id,
          cwd: record.transfer.cwd ?? undefined,
          label: `handoff ${id}`,
          focus: false,
        });
        surface = {
          pane_id: created.root_pane.pane_id,
          workspace_id:
            (created.tab as { workspace_id?: string }).workspace_id ?? plan.workspace_id,
          tab_id: (created.tab as { tab_id?: string }).tab_id ?? null,
          created: true,
        };
      } else {
        const created = await execTransport.workspaceCreate({
          cwd: record.transfer.cwd ?? undefined,
          label: `handoff ${id}`,
          focus: false,
        });
        surface = {
          pane_id: created.root_pane.pane_id,
          workspace_id:
            (created.workspace as { workspace_id?: string }).workspace_id ??
            (created.root_pane as { workspace_id?: string }).workspace_id ??
            null,
          tab_id:
            (created.tab as { tab_id?: string }).tab_id ??
            (created.root_pane as { tab_id?: string }).tab_id ??
            null,
          created: true,
        };
      }
      execution.target = surface;
      await updateState((s) => {
        const r = s.handoffs[id];
        if (r?.execution) r.execution.target = surface;
      });
    }
    const surface = execution.target;
    if (surface === null) throw new HandoffExecError("target surface unresolved", "internal");

    // --- agent.start ------------------------------------------------------------
    const startArgs: string[] = [...(decision.resume_args ?? [])];
    if (flags.model !== undefined) {
      const modelFlag = resumeInfo(decision.provider_kind).model_flag ?? "--model";
      startArgs.push(modelFlag, flags.model);
    }
    const agentName = `handoff ${id}`;
    try {
      await execTransport.agentStart({
        name: agentName,
        kind: decision.provider_kind,
        paneId: surface.pane_id,
        ...(startArgs.length > 0 ? { args: startArgs } : {}),
        timeoutMs: AGENT_START_TIMEOUT_MS,
      });
    } catch (err) {
      return await fail("agent_start", err);
    }

    // Post-start identity capture: generation signals BEFORE the prompt so
    // the done-verdict baseline is meaningful.
    let agentInfo: ExecutionAgent;
    try {
      const agent = await execTransport.agentGet(surface.pane_id);
      agentInfo = {
        name: agentName,
        kind: decision.provider_kind,
        pane_id: surface.pane_id,
        agent_session: agentSessionRef(agent),
        state_change_seq:
          typeof agent.state_change_seq === "number" ? agent.state_change_seq : null,
        agent_status: typeof agent.agent_status === "string" ? agent.agent_status : null,
      };
    } catch (err) {
      return await fail("agent_start", err);
    }
    execution.agent = agentInfo;

    // --- payload injection --------------------------------------------------------
    try {
      await execTransport.agentPrompt(surface.pane_id, promptText);
    } catch (err) {
      return await fail("prompt", err);
    }
    execution.prompt = {
      delivered_at: nowIso(now),
      chars: promptText.length,
      waited: flags.waitMs !== undefined,
    };

    // ready → delivered; sibling live records for the same source
    // identity are superseded in the same atomic write.
    await updateState((s) => {
      const r = s.handoffs[id];
      if (r === undefined) return;
      if (canTransitionStatus(r.status, "delivered")) {
        r.status = "delivered";
      }
      if (r.execution) {
        r.execution.target = surface;
        r.execution.agent = agentInfo;
        r.execution.prompt = execution.prompt;
        r.execution.error = null;
      }
      r.updated_at = nowIso(now);
      for (const other of Object.values(s.handoffs)) {
        if (other.id === id) continue;
        if (
          (other.status === "pending" || other.status === "ready") &&
          other.transfer.session_key === r.transfer.session_key &&
          other.transfer.pane_id === r.transfer.pane_id
        ) {
          other.status = "superseded";
          other.updated_at = nowIso(now);
        }
      }
    });
  } catch (err) {
    if (err instanceof HandoffExecError) throw err;
    return await fail("surface", err);
  }

  // --- optional bounded observation ----------------------------------------------
  const targetPaneId = execution.target?.pane_id;
  if (flags.waitMs !== undefined && targetPaneId !== undefined) {
    try {
      await execTransport.agentWait(
        targetPaneId,
        { until: ["idle", "done", "blocked"], timeoutMs: flags.waitMs },
        flags.waitMs + CLIENT_MARGIN_MS,
      );
    } catch (err) {
      if (!isTimeoutError(err)) {
        // Post-delivery observation failure is NOT a delivery failure:
        // the prompt was already accepted. `status` reconcile keeps
        // reporting the raw observed state afterwards.
      }
      // wait timeout → stays delivered; lazy `status` reconcile continues.
    }
    const current = (await loadState()).handoffs[id];
    if (current?.status === "delivered") {
      const obs = await observeOnce(execTransport, current, now);
      await updateState((s) => {
        const r = s.handoffs[id];
        if (r?.execution) {
          r.execution.observed = {
            agent_status: obs.agent_status,
            pane_present: obs.pane_present,
            checked_at: obs.checked_at,
          };
        }
        if (
          r &&
          r.status === "delivered" &&
          obs.pane_present === true &&
          isDoneObservation(obs.agent_status, obs.state_change_seq ?? null, baselineSeq(r))
        ) {
          r.status = "done";
        }
        if (r) r.updated_at = nowIso(now);
      });
    }
  }

  const finalRecord = (await loadState()).handoffs[id] as HandoffRecord;
  const finalStatus = finalRecord.status;
  const outcome =
    finalStatus === "done" ? "done" : finalStatus === "delivered" ? "delivered" : "failed";
  return { record: finalRecord, outcome };
}

// --- Lazy reconciliation (status command) -----------------------------------------

interface ObservedSnapshot {
  agent_status: string | null;
  pane_present: boolean | null;
  checked_at: string;
  state_change_seq: number | null;
}

function baselineSeq(record: HandoffRecord): number | null {
  return record.execution?.agent?.state_change_seq ?? null;
}

async function observeOnce(
  transport: HandoffTransport,
  record: HandoffRecord,
  now: () => Date,
): Promise<ObservedSnapshot> {
  const paneId = record.execution?.target?.pane_id;
  if (paneId === undefined) {
    return {
      agent_status: null,
      pane_present: null,
      state_change_seq: null,
      checked_at: nowIso(now),
    };
  }
  try {
    const agent = await transport.agentGet(paneId);
    return {
      agent_status: typeof agent.agent_status === "string" ? agent.agent_status : null,
      pane_present: true,
      state_change_seq: typeof agent.state_change_seq === "number" ? agent.state_change_seq : null,
      checked_at: nowIso(now),
    };
  } catch (err) {
    const gone = /not_found|no_such|gone|exited|missing|closed/i.test(errorMessage(err));
    return {
      agent_status: null,
      pane_present: gone ? false : null,
      state_change_seq: null,
      checked_at: nowIso(now),
    };
  }
}

/**
 * Lazy `delivered → done` reconciliation driven by `status`: evaluates
 * the target pane inside the caller-provided snapshot (same session_key
 * gate) and persists `execution.observed` plus the transition when the
 * done verdict holds. Returns the (possibly updated) record, or null
 * when the record is not a delivered handoff with a target.
 */
export async function reconcileDelivered(
  id: string,
  input: {
    snapshot: SessionSnapshot | null;
    sessionKey?: string | undefined;
    now?: (() => Date) | undefined;
  },
): Promise<HandoffRecord | null> {
  const now = input.now ?? (() => new Date());
  return updateState((s) => {
    const r = s.handoffs[id];
    if (r === undefined || r.status !== "delivered" || r.execution?.target == null) {
      return null;
    }
    const check = checkTarget(r, input.snapshot, input.sessionKey);
    const observed: ExecutionObservation = {
      agent_status: check.agent_status,
      pane_present: check.pane_present,
      checked_at: nowIso(now),
    };
    r.execution.observed = observed;
    if (
      check.state === "ok" &&
      isDoneObservation(check.agent_status, check.state_change_seq, baselineSeq(r))
    ) {
      r.status = "done";
    }
    r.updated_at = nowIso(now);
    return r;
  });
}

/**
 * Remote variant of `reconcileDelivered` (#105): the target pane lives in
 * the remote herdr session, so observation goes through the remote
 * transport's `agent.get` — there is no local snapshot to gate on. The
 * caller MUST have verified `record.execution.remote.machine_id`
 * matches the probed machine before calling; this function trusts the
 * injected transport. Same done verdict, same honest `observed` record.
 */
export async function reconcileRemoteDelivered(
  id: string,
  input: {
    transport: HandoffTransport;
    now?: (() => Date) | undefined;
  },
): Promise<HandoffRecord | null> {
  const now = input.now ?? (() => new Date());
  const record = (await loadState()).handoffs[id];
  if (
    record === undefined ||
    record.status !== "delivered" ||
    record.execution?.target == null ||
    record.execution.remote === undefined
  ) {
    return null;
  }
  const obs = await observeOnce(input.transport, record, now);
  return updateState((s) => {
    const r = s.handoffs[id];
    if (r === undefined || r.status !== "delivered" || r.execution === undefined) {
      return null;
    }
    r.execution.observed = {
      agent_status: obs.agent_status,
      pane_present: obs.pane_present,
      checked_at: obs.checked_at,
    };
    if (
      obs.pane_present === true &&
      isDoneObservation(obs.agent_status, obs.state_change_seq, baselineSeq(r))
    ) {
      r.status = "done";
    }
    r.updated_at = nowIso(now);
    return r;
  });
}
