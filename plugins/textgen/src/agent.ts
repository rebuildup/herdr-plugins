/**
 * Agent-pane execution path for rebuildup.textgen (ADR-0017).
 *
 * Generation runs inside a dedicated herdr workspace/pane: the plugin
 * asks herdr to start a provider agent (`agent.start`), submits the
 * prompt (`agent.prompt --wait`), reads the terminal (`agent.read`),
 * extracts the marked result, and always cleans up the workspace —
 * including on failure. herdr remains the sole PTY authority; the
 * plugin never spawns the provider CLI itself on this path.
 *
 * The transport is injectable so tests can fake the Socket API; the
 * default transport is one-request-per-call over herdr's local socket
 * (packages/herdr-client).
 */

import type { CallOptions } from "../../../packages/herdr-client/src/index";
import { request, resolveSocketPath } from "../../../packages/herdr-client/src/index";
import { TextgenError } from "./model";
import { extractMarkedResult } from "./output";
import type { BuiltPrompt } from "./prompts";
import { promptToAgentText } from "./prompts";

/** Minimal Socket API surface the agent path needs (fakeable). */
export interface AgentTransport {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function socketTransport(options: CallOptions = {}): AgentTransport {
  const socketPath = options.socketPath ?? resolveSocketPath({ session: options.session });
  const timeoutMs = options.timeoutMs;
  return {
    call: (method, params) =>
      request(socketPath, method, params, timeoutMs !== undefined ? { timeoutMs } : {}) as Promise<
        Record<string, unknown>
      >,
  };
}

export interface AgentExecParams {
  /** herdr agent kind (e.g. "claude"). */
  kind: string;
  /** Agent display/start name; also the prompt/wait/read target. */
  name: string;
  /** Extra argv forwarded to `agent.start` (e.g. model flag). */
  args?: string[] | undefined;
  prompt: BuiltPrompt;
  startupTimeoutMs: number;
  promptTimeoutMs: number;
  readLines: number;
  /** Optional cwd for the dedicated workspace. */
  cwd?: string | undefined;
  /** Workspace label; defaults to a textgen-tagged label. */
  label?: string | undefined;
}

export interface AgentExecResult {
  /** Raw terminal text read back from the agent pane. */
  rawText: string;
  /** Extracted marked region, or null when markers were absent. */
  markedText: string | null;
  agentName: string;
  paneId: string;
  workspaceId: string;
  /** Non-fatal cleanup notes (e.g. workspace.close failed). */
  cleanupWarnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new TextgenError(code, "agent_execution", message, details);
}

/**
 * Run one generation inside a dedicated herdr workspace. Always attempts
 * workspace cleanup; structured errors carry the failing stage.
 */
export async function executeAgentPrompt(
  transport: AgentTransport,
  params: AgentExecParams,
): Promise<AgentExecResult> {
  const cleanupWarnings: string[] = [];
  let workspaceId: string | null = null;
  const agentName = params.name;

  try {
    // 1. Dedicated workspace + root pane (never reuse an existing pane —
    //    identity/generation invariants, and the pane may be in use).
    const created = await transport.call("workspace.create", {
      label: params.label ?? `textgen:${params.kind}`,
      focus: false,
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    });
    const workspace = asRecord(created.workspace);
    const rootPane = asRecord(created.root_pane);
    workspaceId = typeof workspace.workspace_id === "string" ? workspace.workspace_id : null;
    const paneId = typeof rootPane.pane_id === "string" ? rootPane.pane_id : "";
    if (workspaceId === null || paneId === "") {
      fail("agent_workspace_failed", "workspace.create returned no workspace/pane ids", {
        result_keys: Object.keys(created),
      });
    }

    // 2. Start the provider agent in that pane. Freshly created panes
    //    race shell readiness (`agent_pane_busy: not an available
    //    shell`); retry that specific failure briefly. Other start
    //    errors (unknown kind, blocked startup) surface immediately —
    //    retrying them could spawn a second agent process.
    let started: Record<string, unknown> | null = null;
    let lastStartError: unknown = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        started = await transport.call("agent.start", {
          name: agentName,
          kind: params.kind,
          pane_id: paneId,
          ...(params.args !== undefined && params.args.length > 0 ? { args: params.args } : {}),
          timeout_ms: params.startupTimeoutMs,
        });
        break;
      } catch (err) {
        lastStartError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (/not an available shell|agent_pane_busy/i.test(message) && attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        fail("agent_start_failed", `agent.start(${params.kind}) failed: ${message}`, {
          kind: params.kind,
        });
      }
    }
    if (started === null) {
      const message =
        lastStartError instanceof Error ? lastStartError.message : String(lastStartError);
      fail("agent_start_failed", `agent.start(${params.kind}) failed: ${message}`, {
        kind: params.kind,
      });
    }
    const startedAgent = asRecord(asRecord(started).agent);
    const reportedName =
      typeof startedAgent.name === "string" && startedAgent.name !== ""
        ? startedAgent.name
        : agentName;

    // 3. Submit the prompt and wait for a settled state. The named agent
    //    can lag registration by a beat after agent.start returns
    //    ("not an active named agent" / "not ready for prompts"); retry
    //    that specific race briefly. `agent_blocked` is never retried.
    const text = promptToAgentText(params.prompt);
    let prompted: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        prompted = await transport.call("agent.prompt", {
          target: reportedName,
          text,
          wait: {
            until: ["idle", "done", "blocked"],
            timeout_ms: params.promptTimeoutMs,
          },
        });
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const transient =
          /not an active named agent|not ready for prompts/i.test(message) && attempt < 19;
        if (transient) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        const code = /blocked/i.test(message) ? "agent_blocked" : "agent_prompt_failed";
        fail(code, `agent.prompt failed: ${message}`, { agent: reportedName });
      }
    }
    if (prompted === null) {
      fail("agent_prompt_failed", "agent.prompt failed: agent never became promptable", {
        agent: reportedName,
      });
    }
    const promptedAgent = asRecord(asRecord(prompted).agent);
    const status = promptedAgent.agent_status;
    if (status === "blocked") {
      fail("agent_blocked", "agent entered blocked state during generation", {
        agent: reportedName,
      });
    }

    // 4. Read back the terminal and extract the marked result.
    const read = await transport
      .call("agent.read", {
        target: reportedName,
        source: "recent",
        lines: params.readLines,
        strip_ansi: true,
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        fail("agent_read_failed", `agent.read failed: ${message}`, { agent: reportedName });
      });
    const readRecord = asRecord(asRecord(read).read);
    const rawText =
      typeof readRecord.text === "string"
        ? readRecord.text
        : typeof asRecord(read).text === "string"
          ? (asRecord(read).text as string)
          : "";

    return {
      rawText,
      markedText: extractMarkedResult(rawText),
      agentName: reportedName,
      paneId,
      workspaceId,
      cleanupWarnings,
    };
  } finally {
    if (workspaceId !== null) {
      try {
        await transport.call("workspace.close", { workspace_id: workspaceId });
      } catch (err) {
        cleanupWarnings.push(
          `workspace.close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
