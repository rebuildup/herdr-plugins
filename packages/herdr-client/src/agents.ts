/**
 * Typed wrappers for herdr's `agent.*` socket surface (Issue #99, parent
 * #27 T1). Wire shapes mirror the official Socket API (herdr 0.9.5,
 * protocol 22; `herdr api schema`).
 *
 * Semantics that callers must not paper over:
 * - `agent.prompt` submits text to the agent's PTY (bracketed paste +
 *   Enter upstream); it rejects an already-`blocked` agent with
 *   `agent_blocked` before any input is sent.
 * - `agent.send_keys` is a PTY-level key injection — there is no
 *   structured interrupt API upstream.
 * - `agent.read` returns terminal scrollback, not structured history.
 * - `target` is herdr's agent target (pane id or agent name); herdr
 *   resolves it. Wrappers never fabricate fields the server omits.
 */

import type { CallOptions } from "./commands";
import type { AgentInfo } from "./snapshot";
import { type RequestOptions, request, resolveSocketPath } from "./socket";

function socketFor(options: CallOptions): string {
  return options.socketPath ?? resolveSocketPath({ session: options.session });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// --- Enumerations (herdr protocol 22) ---------------------------------------

export const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_READ_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
export type AgentReadSource = (typeof AGENT_READ_SOURCES)[number];

export const AGENT_READ_FORMATS = ["text", "ansi"] as const;
export type AgentReadFormat = (typeof AGENT_READ_FORMATS)[number];

// --- Results ---------------------------------------------------------------

/** `agent.get` payload: the resolved agent plus its pane identity. */
export type AgentGetResult = AgentInfo;

export interface AgentPromptWaitOptions {
  until?: AgentStatus[] | undefined;
  timeoutMs?: number | undefined;
}

export interface AgentReadResult {
  target?: string;
  pane_id?: string;
  source?: string;
  format?: string;
  text?: string;
  lines?: number | null;
  truncated?: boolean;
  revision?: number;
  [key: string]: unknown;
}

// --- Methods ----------------------------------------------------------------

/** `agent.get` — resolve a target to its live AgentInfo; rejects when unknown. */
export async function agentGet(target: string, options: CallOptions = {}): Promise<AgentGetResult> {
  const result = asRecord(await request(socketFor(options), "agent.get", { target }, options));
  // Tolerant unwrap: `{agent: {...}}` envelope or a bare agent object.
  const agent = asRecord(result.agent ?? result);
  return agent as unknown as AgentGetResult;
}

/**
 * `agent.prompt` — submit `text` to the agent. `wait` maps to herdr's
 * `wait{until[],timeout_ms}`: wait for the first matching status after
 * submission. A `blocked` agent is rejected upstream with
 * `agent_blocked` before input is sent — callers must surface that as a
 * structured error, never as success.
 */
export async function agentPrompt(
  target: string,
  text: string,
  wait?: AgentPromptWaitOptions,
  options: CallOptions & RequestOptions = {},
): Promise<unknown> {
  const params: Record<string, unknown> = { target, text };
  if (wait !== undefined) {
    const wire: Record<string, unknown> = {};
    if (wait.until !== undefined) wire.until = wait.until;
    if (wait.timeoutMs !== undefined) wire.timeout_ms = wait.timeoutMs;
    params.wait = wire;
  }
  return request(socketFor(options), "agent.prompt", params, options);
}

/**
 * `agent.wait` — block until the agent reaches one of `until` (default
 * upstream: idle/done/blocked) or `timeoutMs` elapses (structured
 * `timeout` error upstream).
 */
export async function agentWait(
  target: string,
  params: { until?: AgentStatus[] | undefined; timeoutMs?: number | undefined } = {},
  options: CallOptions & RequestOptions = {},
): Promise<unknown> {
  const wire: Record<string, unknown> = { target };
  if (params.until !== undefined) wire.until = params.until;
  if (params.timeoutMs !== undefined) wire.timeout_ms = params.timeoutMs;
  return request(socketFor(options), "agent.wait", wire, options);
}

/**
 * `agent.send_keys` — PTY-level key injection (e.g. ["esc"], ["ctrl+c"]).
 * This is NOT a structured interrupt: it types into the terminal exactly
 * like `herdr agent send-keys`.
 */
export async function agentSendKeys(
  target: string,
  keys: string[],
  options: CallOptions = {},
): Promise<unknown> {
  return request(socketFor(options), "agent.send_keys", { target, keys }, options);
}

/** `agent.read` — bounded terminal scrollback read (not structured history). */
export async function agentRead(
  target: string,
  params: {
    source: AgentReadSource;
    lines?: number | undefined;
    format?: AgentReadFormat | undefined;
    stripAnsi?: boolean | undefined;
  },
  options: CallOptions = {},
): Promise<AgentReadResult> {
  const wire: Record<string, unknown> = { target, source: params.source };
  if (params.lines !== undefined) wire.lines = params.lines;
  if (params.format !== undefined) wire.format = params.format;
  if (params.stripAnsi !== undefined) wire.strip_ansi = params.stripAnsi;
  const result = asRecord(await request(socketFor(options), "agent.read", wire, options));
  const read = asRecord(result.read ?? result);
  return read as unknown as AgentReadResult;
}

/**
 * `agent.rename` — set the agent's display name; `name: null` clears it
 * (upstream `--clear`).
 */
export async function agentRename(
  target: string,
  name: string | null,
  options: CallOptions = {},
): Promise<unknown> {
  return request(socketFor(options), "agent.rename", { target, name }, options);
}
