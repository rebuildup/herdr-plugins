/**
 * Run delivery for rebuildup.automations (#145, ADR-0023).
 *
 * `deliverRun` performs the actual herdr socket work for one run
 * record: `destination.kind="pane"` → `agent.prompt` to the pane's
 * live agent; `destination.kind="launch"` → resolve the surface to a
 * fresh pane (`workspace.create` / `tab.create` / `pane.split`) then
 * `agent.start` + `agent.prompt`. Every outcome is OBSERVED — API
 * acceptance and `agent_status` reads only; PTY text is never parsed
 * (AGENTS §4).
 *
 * The transport is an interface so contract tests run against fakes;
 * `herdrTransport()` adapts the typed wrappers in
 * packages/herdr-client. Transport (socket) failures are classified
 * separately from server-side rejections: callers preflight
 * connectivity BEFORE creating run records (contract §Missed-run —
 * no record is fabricated for an unreachable herdr), and any failure
 * after that point becomes an honest `failed` run.
 */

import { sessionSnapshot } from "../../../packages/herdr-client/src/commands";
import {
  type AgentGetResult,
  type AgentStartResult,
  agentGet,
  agentPrompt,
  agentStart,
  type CallOptions,
  type PaneSplitResult,
  paneSplit,
  type SessionSnapshot,
  type TabCreatedResult,
  tabCreate,
  type WorkspaceCreatedResult,
  workspaceCreate,
} from "../../../packages/herdr-client/src/index";
import { HerdrRpcError } from "../../../packages/herdr-client/src/socket";
import type { Destination, RunRecord, TaskRecord } from "./model";

// --- Transport ---------------------------------------------------------------

export interface AutomationsTransport {
  /** Cheap connectivity probe — `session.snapshot`. */
  sessionSnapshot(): Promise<SessionSnapshot>;
  agentGet(target: string): Promise<AgentGetResult>;
  agentPrompt(target: string, text: string): Promise<unknown>;
  agentStart(params: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[] | undefined;
    timeoutMs?: number | undefined;
  }): Promise<AgentStartResult>;
  workspaceCreate(params: {
    cwd?: string | undefined;
    label?: string | undefined;
    focus?: boolean | undefined;
  }): Promise<WorkspaceCreatedResult>;
  tabCreate(params: {
    cwd?: string | undefined;
    label?: string | undefined;
    focus?: boolean | undefined;
    workspace_id?: string | undefined;
  }): Promise<TabCreatedResult>;
  paneSplit(params: {
    direction: "right" | "down";
    target_pane_id?: string | undefined;
    cwd?: string | undefined;
    label?: string | undefined;
    focus?: boolean | undefined;
  }): Promise<PaneSplitResult>;
}

/** Adapt the herdr-client wrappers for one invocation. */
export function herdrTransport(options: CallOptions = {}): AutomationsTransport {
  return {
    sessionSnapshot: () => sessionSnapshot(options),
    agentGet: (target) => agentGet(target, options),
    agentPrompt: (target, text) => agentPrompt(target, text, undefined, options),
    agentStart: (params) => agentStart(params, options),
    workspaceCreate: (params) => workspaceCreate(params, options),
    tabCreate: (params) => tabCreate(params, options),
    paneSplit: (params) => paneSplit(params, options),
  };
}

// --- Prompt provenance ---------------------------------------------------------

/**
 * Structured provenance prefix (ADR-0023 §1): automation-originated
 * input is always distinguishable from user input — same intent as
 * T3's `[T3 Code: scheduled task … sent this prompt]` tag.
 */
export function buildRunPrompt(task: TaskRecord, run: RunRecord): string {
  const when =
    run.trigger === "manual" ? "manual run" : `scheduled_for ${run.scheduled_for ?? "unknown"}`;
  return (
    `[automations] scheduled task ${task.task_id} ("${task.name}") ` +
    `run ${run.run_id} — ${when}\n\n${task.prompt}`
  );
}

// --- Error classification ------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  if (err instanceof HerdrRpcError) return err.code;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** herdr socket unreachable / client-side transport failure. */
export function isTransportError(err: unknown): boolean {
  return !(err instanceof HerdrRpcError);
}

const DESTINATION_GONE_RE = /not_found|no_such|gone|exited|missing|closed|unknown agent/i;

/** Map a delivery failure to the run's honest error record. */
function runError(err: unknown): { code: string; message: string } {
  if (isTransportError(err)) {
    return {
      code: "socket_unavailable",
      message: `herdr transport failure during delivery: ${errorMessage(err)}`,
    };
  }
  const code = errorCode(err) ?? "delivery_error";
  if (DESTINATION_GONE_RE.test(code) || DESTINATION_GONE_RE.test(errorMessage(err))) {
    return { code: "destination_unavailable", message: errorMessage(err) };
  }
  return { code, message: errorMessage(err) };
}

// --- Delivery ------------------------------------------------------------------

export interface DeliveryOutcome {
  status: "success" | "failed";
  result: { summary?: string | undefined; agent_status?: string | undefined } | null;
  error: { code: string; message: string } | null;
  /** Fire-time resolved destination (pane/surface/agent identities). */
  destinationSnapshot: Record<string, unknown>;
}

function agentStatusOf(agent: AgentGetResult | null): string | undefined {
  const status = agent?.agent_status;
  return typeof status === "string" ? status : undefined;
}

class DeliveryFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** herdr agent names: `[a-z][a-z0-9_-]{0,31}` (same rule as handoff). */
export function automationAgentName(runId: string): string {
  const hex = runId.replace(/^run_/, "").replaceAll("-", "");
  return `auto-${hex.slice(0, 20) || "run"}`;
}

const AGENT_START_TIMEOUT_MS = 60_000;
const PROMPT_REGISTRY_RETRIES = 10;
const PROMPT_REGISTRY_DELAY_MS = 500;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface ResolvedSurface {
  pane_id: string;
  workspace_id: string | null;
  tab_id: string | null;
  created: "workspace" | "tab" | "split" | null;
}

/** Resolve a launch surface to a fresh shell pane (ADR-0023 §1). */
async function resolveLaunchSurface(
  destination: Extract<Destination, { kind: "launch" }>,
  task: TaskRecord,
  transport: AutomationsTransport,
): Promise<ResolvedSurface> {
  const surface = destination.surface;
  const label = `automations: ${task.name}`.slice(0, 80);
  if ("new_workspace" in surface) {
    const created = await transport.workspaceCreate({ label, focus: false });
    const paneId = optStr(created.root_pane?.pane_id);
    if (paneId === null) {
      throw new DeliveryFailure("destination_unavailable", "workspace.create returned no pane");
    }
    return {
      pane_id: paneId,
      workspace_id:
        optStr(created.workspace?.workspace_id) ?? optStr(created.root_pane?.workspace_id),
      tab_id: optStr(created.tab?.tab_id) ?? optStr(created.root_pane?.tab_id),
      created: "workspace",
    };
  }
  if ("workspace_id" in surface) {
    const created = await transport.tabCreate({
      workspace_id: surface.workspace_id,
      label,
      focus: false,
    });
    const paneId = optStr(created.root_pane?.pane_id);
    if (paneId === null) {
      throw new DeliveryFailure("destination_unavailable", "tab.create returned no pane");
    }
    return {
      pane_id: paneId,
      workspace_id: surface.workspace_id,
      tab_id: optStr(created.tab?.tab_id) ?? optStr(created.root_pane?.tab_id),
      created: "tab",
    };
  }
  // { tab_id }: split the tab's first pane — there is no pane.create
  // upstream, so an existing tab gains a sibling pane via pane.split.
  const snapshot = await transport.sessionSnapshot();
  const panes = (snapshot.panes ?? []).filter((p) => optStr(p.tab_id) === surface.tab_id);
  const targetPaneId = optStr(panes[0]?.pane_id);
  if (targetPaneId === null) {
    throw new DeliveryFailure(
      "destination_unavailable",
      `tab '${surface.tab_id}' has no pane to split`,
    );
  }
  const split = await transport.paneSplit({
    direction: "right",
    target_pane_id: targetPaneId,
    label,
    focus: false,
  });
  const paneId = optStr(split.pane?.pane_id);
  if (paneId === null) {
    throw new DeliveryFailure("destination_unavailable", "pane.split returned no pane");
  }
  return {
    pane_id: paneId,
    workspace_id: optStr(split.pane?.workspace_id) ?? optStr(panes[0]?.workspace_id),
    tab_id: surface.tab_id,
    created: "split",
  };
}

/**
 * Deliver one run. NEVER throws for delivery-level failures — every
 * outcome is returned as `success`/`failed` with observed values.
 * Callers MUST have preflighted transport connectivity before the run
 * record was created (contract: transport error → no fabricated run).
 */
export async function deliverRun(
  task: TaskRecord,
  run: RunRecord,
  transport: AutomationsTransport,
): Promise<DeliveryOutcome> {
  const destination = task.destination;
  const prompt = buildRunPrompt(task, run);
  try {
    if (destination.kind === "pane") {
      // Live-agent check first: agent.get resolves the pane's agent or
      // rejects — a closed pane / missing agent is destination_unavailable.
      const before = await transport.agentGet(destination.pane_id);
      await transport.agentPrompt(destination.pane_id, prompt);
      const after = await transport.agentGet(destination.pane_id).catch(() => null);
      return {
        status: "success",
        result: {
          summary: `prompt delivered to agent in pane ${destination.pane_id}`,
          agent_status: agentStatusOf(after) ?? agentStatusOf(before),
        },
        error: null,
        destinationSnapshot: {
          kind: "pane",
          pane_id: destination.pane_id,
          agent_status_at_delivery: agentStatusOf(before) ?? null,
        },
      };
    }

    // kind === "launch"
    if (destination.via === "handoff-execute") {
      // Reserved extension (ADR-0023 §2): schema-accepted but the
      // handoff-execute invocation path is not implemented in v1 —
      // fail honestly rather than silently delivering direct.
      throw new DeliveryFailure(
        "unsupported_destination",
        "destination.via 'handoff-execute' is reserved and not implemented in v1",
      );
    }
    const surface = await resolveLaunchSurface(destination, task, transport);
    const started = await transport.agentStart({
      name: automationAgentName(run.run_id),
      kind: destination.agent,
      paneId: surface.pane_id,
      ...(destination.launch_args !== undefined ? { args: destination.launch_args } : {}),
      timeoutMs: AGENT_START_TIMEOUT_MS,
    });
    // `agent.start` returns on interactive readiness, but herdr's
    // prompt registry can lag — retry briefly on the transient
    // "not an active named agent" race (same as handoff execute).
    let promptErr: unknown = null;
    for (let attempt = 0; attempt <= PROMPT_REGISTRY_RETRIES; attempt += 1) {
      try {
        await transport.agentPrompt(surface.pane_id, prompt);
        promptErr = null;
        break;
      } catch (err) {
        promptErr = err;
        const msg = errorMessage(err);
        const transient =
          /not an active named agent|agent_not_ready/.test(msg) &&
          attempt < PROMPT_REGISTRY_RETRIES;
        if (!transient) break;
        await sleep(PROMPT_REGISTRY_DELAY_MS);
      }
    }
    if (promptErr !== null) throw promptErr;

    const launchedAgent: AgentGetResult | null = started.agent ?? null;
    const after = await transport.agentGet(surface.pane_id).catch(() => null);
    return {
      status: "success",
      result: {
        summary:
          `agent '${destination.agent}' started in pane ${surface.pane_id}` +
          ` (surface ${surface.created ?? "existing"}) and prompt delivered`,
        agent_status: agentStatusOf(after) ?? agentStatusOf(launchedAgent),
      },
      error: null,
      destinationSnapshot: {
        kind: "launch",
        via: destination.via ?? "direct",
        agent: destination.agent,
        agent_name: automationAgentName(run.run_id),
        pane_id: surface.pane_id,
        workspace_id: surface.workspace_id,
        tab_id: surface.tab_id,
        surface_created: surface.created,
        argv: started.argv,
      },
    };
  } catch (err) {
    if (err instanceof DeliveryFailure) {
      return {
        status: "failed",
        result: null,
        error: { code: err.code, message: err.message },
        destinationSnapshot: { kind: destination.kind },
      };
    }
    return {
      status: "failed",
      result: null,
      error: runError(err),
      destinationSnapshot: { kind: destination.kind },
    };
  }
}
