/**
 * Agent identity resolution and generation guarding for
 * `rebuildup.controls` (Issue #99 / parent #27 T1).
 *
 * Every operation resolves `<target>` through `agent.get` first, so a
 * non-agent pane or unknown target fails before any mutation is sent.
 * The resolved identity (host / herdr session / workspace / tab / pane /
 * agent_session / state_change_seq) is echoed in every result — the
 * AGENTS.md §4 invariant that organize/control state never applies to a
 * different agent generation.
 *
 * Optional caller expectations (`--expect-pane`,
 * `--expect-state-seq`, `--expect-agent-session`) pin the generation the
 * caller observed; any mismatch aborts with `stale_generation` before
 * the mutating `agent.*` call. There is no persistent state in this
 * plugin — guards are per-invocation.
 */

import os from "node:os";
import {
  type AgentGetResult,
  agentGet,
  type CallOptions,
  HerdrRpcError,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";

export interface AgentSessionRef {
  agent?: string;
  kind?: string;
  value?: string;
}

export interface AgentIdentity {
  host: string;
  herdr_session: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  agent: string | null;
  agent_session: AgentSessionRef | null;
  /** `state_change_seq` at resolve time; null when herdr reports none. */
  state_change_seq: number | null;
  agent_status: string | null;
  interactive_ready?: boolean;
  launch_pending?: boolean;
}

export class ControlsError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function agentSessionRef(agent: AgentGetResult | undefined): AgentSessionRef | null {
  const session = agent?.agent_session;
  if (typeof session !== "object" || session === null) return null;
  const s = session as Record<string, unknown>;
  const ref: AgentSessionRef = {};
  if (typeof s.agent === "string") ref.agent = s.agent;
  if (typeof s.kind === "string") ref.kind = s.kind;
  if (typeof s.value === "string") ref.value = s.value;
  return Object.keys(ref).length > 0 ? ref : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function herdrSessionName(snapshot: SessionSnapshot | null, options: CallOptions): string {
  const name = snapshot?.session?.name;
  if (typeof name === "string" && name !== "") return name;
  return options.session ?? process.env.HERDR_SESSION ?? "default";
}

export interface ResolvedAgent {
  agent: AgentGetResult;
  identity: AgentIdentity;
}

/**
 * Resolve `target` via `agent.get` and build the full identity. RPC
 * failures propagate as `HerdrRpcError` (the CLI maps `.code` to the
 * structured error kind, e.g. `agent_not_found`); transport failures
 * surface as ordinary errors mapped to `session_unreachable`.
 */
export async function resolveAgent(target: string, options: CallOptions): Promise<ResolvedAgent> {
  const agent = await agentGet(target, options);
  return { agent, identity: await identityForAgent(agent, options) };
}

/**
 * Build the full identity for an already-resolved AgentInfo (e.g. the
 * `agent` field of an `agent.start` result). Session name is display
 * metadata; a snapshot failure must not fail the operation.
 */
export async function identityForAgent(
  agent: AgentGetResult,
  options: CallOptions,
): Promise<AgentIdentity> {
  let snapshot: SessionSnapshot | null = null;
  try {
    snapshot = await sessionSnapshot(options);
  } catch {
    snapshot = null;
  }

  const identity: AgentIdentity = {
    host: os.hostname(),
    herdr_session: herdrSessionName(snapshot, options),
    workspace_id: str(agent.workspace_id),
    tab_id: str(agent.tab_id),
    pane_id: str(agent.pane_id),
    agent: str(agent.agent) ?? agentSessionRef(agent)?.agent ?? null,
    agent_session: agentSessionRef(agent),
    state_change_seq: typeof agent.state_change_seq === "number" ? agent.state_change_seq : null,
    agent_status: str(agent.agent_status),
  };
  if (typeof agent.interactive_ready === "boolean") {
    identity.interactive_ready = agent.interactive_ready;
  }
  if (typeof agent.launch_pending === "boolean") {
    identity.launch_pending = agent.launch_pending;
  }
  return identity;
}

export interface GenerationExpectation {
  pane?: string | undefined;
  stateSeq?: number | undefined;
  agentSession?: string | undefined;
}

/**
 * Compare caller-pinned generation signals against the live agent.
 * Any provided expectation that does not match aborts with
 * `stale_generation` — the mutation is never sent.
 */
export function checkGeneration(resolved: ResolvedAgent, expected: GenerationExpectation): void {
  const mismatches: Record<string, { expected: unknown; actual: unknown }> = {};
  if (expected.pane !== undefined && expected.pane !== resolved.identity.pane_id) {
    mismatches.pane_id = { expected: expected.pane, actual: resolved.identity.pane_id };
  }
  if (expected.stateSeq !== undefined) {
    const actual = resolved.identity.state_change_seq;
    if (actual === null || actual !== expected.stateSeq) {
      mismatches.state_change_seq = { expected: expected.stateSeq, actual };
    }
  }
  if (expected.agentSession !== undefined) {
    const actual = resolved.identity.agent_session?.value ?? null;
    if (actual !== expected.agentSession) {
      mismatches.agent_session = { expected: expected.agentSession, actual };
    }
  }
  if (Object.keys(mismatches).length > 0) {
    throw new ControlsError(
      `stale agent generation for target ${resolved.identity.pane_id ?? "?"}: ${Object.keys(mismatches).join(", ")} mismatch`,
      "stale_generation",
      { identity: resolved.identity, mismatches },
    );
  }
}

/** Map a thrown value to a structured CLI failure (never fabricates success). */
export function isAgentRpcError(err: unknown): err is HerdrRpcError {
  return err instanceof HerdrRpcError;
}
