/**
 * Typed wrappers for herdr's pane execution surface (ADR-0010, Issue #53).
 *
 * Wire shapes mirror the official Socket API (herdr 0.9.5, protocol 22;
 * evidence: docs/research/herdr-pane-execution-spike.md). Results arrive
 * as `{type: "<method_snake>", ...fields}` envelopes; wrappers unwrap the
 * payload tolerantly and never fabricate missing fields.
 */

import type { CallOptions } from "./commands";
import type { PaneInfo, TabInfo, WorkspaceInfo } from "./snapshot";
import {
  type RequestOptions,
  request,
  resolveSocketPath,
  type Subscription,
  subscribe,
} from "./socket";

function socketFor(options: CallOptions): string {
  return options.socketPath ?? resolveSocketPath({ session: options.session });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// --- Result payloads -------------------------------------------------------

export interface WorkspaceCreatedResult {
  type: "workspace_created";
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
}

export interface TabCreatedResult {
  type: "tab_created";
  tab: TabInfo;
  root_pane: PaneInfo;
}

export interface PaneSplitResult {
  type: string;
  pane: PaneInfo;
}

export interface PaneProcessInfoProcess {
  pid: number;
  name: string;
  argv?: string[] | null;
  argv0?: string | null;
  cmdline?: string | null;
  cwd?: string | null;
  [key: string]: unknown;
}

export interface PaneProcessInfo {
  pane_id: string;
  shell_pid: number | null;
  foreground_process_group_id: number | null;
  foreground_processes: PaneProcessInfoProcess[];
  tty?: string | null;
  [key: string]: unknown;
}

export interface PaneReadResult {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: string;
  format: string;
  text: string;
  revision: number;
  truncated: boolean;
  [key: string]: unknown;
}

export interface OutputMatchedResult {
  type: "output_matched";
  pane_id: string;
  revision: number;
  matched_line: string | null;
  read: PaneReadResult;
}

// --- Creation surfaces -----------------------------------------------------

export interface CreateSurfaceOptions {
  cwd?: string | undefined;
  label?: string | undefined;
  focus?: boolean | undefined;
  env?: Record<string, string> | undefined;
}

/** `workspace.create` — dedicated workspace+tab+root pane in one call. */
export async function workspaceCreate(
  params: CreateSurfaceOptions = {},
  options: CallOptions = {},
): Promise<WorkspaceCreatedResult> {
  const result = asRecord(
    await request(socketFor(options), "workspace.create", { ...params }, options),
  );
  return {
    type: "workspace_created",
    workspace: asRecord(result.workspace) as unknown as WorkspaceInfo,
    tab: asRecord(result.tab) as unknown as TabInfo,
    root_pane: asRecord(result.root_pane) as unknown as PaneInfo,
  };
}

/** `tab.create` — new tab (optionally in an existing workspace) + root pane. */
export async function tabCreate(
  params: CreateSurfaceOptions & { workspace_id?: string | undefined } = {},
  options: CallOptions = {},
): Promise<TabCreatedResult> {
  const result = asRecord(await request(socketFor(options), "tab.create", { ...params }, options));
  return {
    type: "tab_created",
    tab: asRecord(result.tab) as unknown as TabInfo,
    root_pane: asRecord(result.root_pane) as unknown as PaneInfo,
  };
}

/** `pane.split` — split an existing pane; `direction` is required. */
export async function paneSplit(
  params: CreateSurfaceOptions & {
    direction: "right" | "down";
    target_pane_id?: string | undefined;
    workspace_id?: string | undefined;
    ratio?: number | undefined;
  },
  options: CallOptions = {},
): Promise<PaneSplitResult> {
  const result = asRecord(await request(socketFor(options), "pane.split", { ...params }, options));
  const pane =
    (result.pane as PaneInfo | undefined) ??
    (asRecord(result.split).pane as PaneInfo | undefined) ??
    ({} as PaneInfo);
  return { type: typeof result.type === "string" ? result.type : "pane_split", pane };
}

// --- Input / inspection ----------------------------------------------------

/** `pane.send_input` — literal text plus key names (e.g. ["Enter"]). */
export async function paneSendInput(
  paneId: string,
  params: { text?: string | undefined; keys?: string[] | undefined } = {},
  options: CallOptions = {},
): Promise<unknown> {
  return request(socketFor(options), "pane.send_input", { pane_id: paneId, ...params }, options);
}

/**
 * `pane.send_text` — literal text into the pane with NO Enter/submit
 * (spike-verified: text lands on the input line only). Distinct from
 * `pane.send_input`, which can append key names such as `["Enter"]`.
 */
export async function paneSendText(
  paneId: string,
  text: string,
  options: CallOptions = {},
): Promise<unknown> {
  return request(socketFor(options), "pane.send_text", { pane_id: paneId, text }, options);
}

/** `pane.send_keys` — key names only (e.g. ["ctrl+c"]). */
export async function paneSendKeys(
  paneId: string,
  keys: string[],
  options: CallOptions = {},
): Promise<unknown> {
  return request(socketFor(options), "pane.send_keys", { pane_id: paneId, keys }, options);
}

/** `pane.get` — single pane info; rejects when the pane is gone. */
export async function paneGet(paneId: string, options: CallOptions = {}): Promise<PaneInfo> {
  const result = asRecord(
    await request(socketFor(options), "pane.get", { pane_id: paneId }, options),
  );
  return asRecord(result.pane) as unknown as PaneInfo;
}

/** `pane.process_info` — shell/foreground process table for a pane. */
export async function paneProcessInfo(
  paneId: string,
  options: CallOptions = {},
): Promise<PaneProcessInfo> {
  const result = asRecord(
    await request(socketFor(options), "pane.process_info", { pane_id: paneId }, options),
  );
  const info = asRecord(result.process_info);
  return {
    pane_id: typeof info.pane_id === "string" ? info.pane_id : paneId,
    shell_pid: typeof info.shell_pid === "number" ? info.shell_pid : null,
    foreground_process_group_id:
      typeof info.foreground_process_group_id === "number"
        ? info.foreground_process_group_id
        : null,
    foreground_processes: Array.isArray(info.foreground_processes)
      ? (info.foreground_processes as PaneProcessInfoProcess[])
      : [],
    tty: typeof info.tty === "string" ? info.tty : null,
  };
}

export type PaneReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

/** `pane.read` — bounded pane text read. */
export async function paneRead(
  paneId: string,
  params: {
    source: PaneReadSource;
    lines?: number | undefined;
    format?: "text" | "ansi" | undefined;
    strip_ansi?: boolean | undefined;
  },
  options: CallOptions = {},
): Promise<PaneReadResult> {
  const result = asRecord(
    await request(socketFor(options), "pane.read", { pane_id: paneId, ...params }, options),
  );
  return asRecord(result.read) as unknown as PaneReadResult;
}

/**
 * `pane.wait_for_output` — server-side block until `match` appears in the
 * pane's read source or `timeoutMs` elapses (structured timeout error).
 * `match.type: "regex"` uses the server's regex engine; the echoed input
 * line is part of scrollback, so markers must be output-only (ADR-0010).
 */
export async function paneWaitForOutput(
  params: {
    pane_id: string;
    source: PaneReadSource;
    match: { type: "substring" | "regex"; value: string };
    timeout_ms?: number | undefined;
    lines?: number | undefined;
    strip_ansi?: boolean | undefined;
  },
  options: CallOptions & RequestOptions = {},
): Promise<OutputMatchedResult> {
  const result = asRecord(
    await request(socketFor(options), "pane.wait_for_output", { ...params }, options),
  );
  return {
    type: "output_matched",
    pane_id: typeof result.pane_id === "string" ? result.pane_id : params.pane_id,
    revision: typeof result.revision === "number" ? result.revision : 0,
    matched_line: typeof result.matched_line === "string" ? result.matched_line : null,
    read: asRecord(result.read) as unknown as PaneReadResult,
  };
}

/** `pane.close` — close a pane; emits `pane.closed`/`pane.exited`. */
export async function paneClose(paneId: string, options: CallOptions = {}): Promise<unknown> {
  return request(socketFor(options), "pane.close", { pane_id: paneId }, options);
}

// --- Events ----------------------------------------------------------------

/**
 * Lifecycle event names pushed by `events.subscribe`. herdr uses dotted
 * subscription types (`pane.closed`) while emitted event names observed on
 * the wire are snake_case (`pane_closed`) — clients must accept both.
 */
export const PANE_LIFECYCLE_EVENTS = [
  "pane.created",
  "pane.closed",
  "pane.exited",
  "pane.updated",
  "pane.focused",
  "pane.moved",
] as const;

export interface PaneLifecycleEventData {
  pane_id?: string;
  workspace_id?: string;
  [key: string]: unknown;
}

/**
 * Subscribe to pane lifecycle events (`pane.closed`, `pane.exited`, …).
 * The subscription stays open until `close()`; events arrive as
 * `{event, data}` envelopes where `data.pane_id` identifies the pane.
 * Emitted event names may be snake_case on the wire — match loosely.
 */
export function subscribePaneLifecycle(options: CallOptions = {}): Subscription {
  const subscriptions = PANE_LIFECYCLE_EVENTS.map((type) => ({ type }));
  return subscribe(socketFor(options), subscriptions, options);
}

/** True when an event name refers to a pane lifecycle event. */
export function isPaneLifecycleEvent(event: string): boolean {
  const normalized = event.replace(/_/g, ".");
  return (PANE_LIFECYCLE_EVENTS as readonly string[]).includes(normalized);
}
