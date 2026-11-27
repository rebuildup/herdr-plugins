/**
 * High-level herdr socket operations used by plugins.
 * Every function opens one request connection; only `subscribe` stays open.
 */

import type { AgentInfo, AgentListResult, SessionSnapshot } from "./snapshot";
import { type RequestOptions, request, resolveTarget, subscribe } from "./socket";

export interface CallOptions extends RequestOptions {
  /** Named herdr session; explicit flag, beats ambient HERDR_SESSION/HERDR_SOCKET_PATH. */
  session?: string | undefined;
  /** Explicit socket path; beats ambient HERDR_SOCKET_PATH/HERDR_SESSION. */
  socketPath?: string | undefined;
  /**
   * Mutating operation: target resolution fails closed with
   * `target_required` when it would fall back to the implicit default
   * session socket (no explicit flag and no ambient HERDR_* target).
   */
  mutation?: boolean | undefined;
}

function socketFor(options: CallOptions): string {
  return resolveTarget({
    session: options.session,
    socketPath: options.socketPath,
    mutation: options.mutation,
  }).socketPath;
}

export async function sessionSnapshot(options: CallOptions = {}): Promise<SessionSnapshot> {
  const result = (await request(socketFor(options), "session.snapshot", {}, options)) as
    | ({ snapshot?: SessionSnapshot } & SessionSnapshot)
    | undefined;
  const snapshot = result?.snapshot ?? (result as SessionSnapshot);
  // The wire format carries `agents` as an array keyed by `pane_id`; normalize
  // to the map shape plugins consume.
  if (Array.isArray(snapshot.agents)) {
    const map: Record<string, AgentInfo> = {};
    for (const agent of snapshot.agents as unknown as AgentInfo[]) {
      const paneId = (agent as { pane_id?: string }).pane_id;
      if (paneId) map[paneId] = agent;
    }
    snapshot.agents = map;
  }
  return snapshot;
}

export interface WorktreeListEntry {
  path?: string;
  branch?: string | null;
  is_bare?: boolean;
  is_detached?: boolean;
  is_linked_worktree?: boolean;
  is_prunable?: boolean;
  label?: string | null;
  open_workspace_id?: string | null;
  [key: string]: unknown;
}

export interface WorktreeListResult {
  source?: {
    repo_key?: string;
    repo_name?: string;
    repo_root?: string;
    source_checkout_path?: string;
    source_workspace_id?: string;
    [key: string]: unknown;
  };
  worktrees?: WorktreeListEntry[];
  [key: string]: unknown;
}

/**
 * `worktree.list` for a repository cwd (herdr protocol 22, verified
 * 0.9.5). Read-only association surface: `trust_repository` is always
 * false — an untrusted-repo failure surfaces to the caller, which must
 * never retry with a trust grant (ADR-0029).
 */
export async function worktreeList(
  cwd: string,
  options: CallOptions = {},
): Promise<WorktreeListResult> {
  const result = (await request(
    socketFor(options),
    "worktree.list",
    { cwd, trust_repository: false },
    options,
  )) as WorktreeListResult | undefined;
  return result ?? {};
}

export async function agentList(options: CallOptions = {}): Promise<AgentListResult> {
  const result = (await request(socketFor(options), "agent.list", {}, options)) as
    | ({ agents?: AgentListResult["agents"] } & AgentListResult)
    | undefined;
  return (result?.agents ? { agents: result.agents } : (result as AgentListResult)) ?? {};
}

// Metadata `seq` orders reports from the same source; keep it monotonic even
// when two invocations land in the same millisecond.
let lastMetadataSeq = 0;
function nextMetadataSeq(): number {
  lastMetadataSeq = Math.max(Date.now(), lastMetadataSeq + 1);
  return lastMetadataSeq;
}

/**
 * Write plugin-owned metadata tokens onto a pane. `source` identifies the
 * reporting integration (required by herdr); tokens merge per source and a
 * `null` value clears a token. `seq` orders reports from the same source.
 */
export async function reportPaneMetadata(
  paneId: string,
  tokens: Record<string, string | null>,
  options: CallOptions & { source?: string | undefined; agent?: string | undefined } = {},
): Promise<unknown> {
  const params: Record<string, unknown> = {
    pane_id: paneId,
    source: options.source ?? "rebuildup.inbox",
    tokens,
    seq: nextMetadataSeq(),
  };
  if (options.agent !== undefined) params.agent = options.agent;
  return request(socketFor(options), "pane.report_metadata", params, options);
}

/**
 * Publish a plugin view into herdr's single Agent View slot. `source`
 * identifies the owning plugin; only one source's view is active at a time.
 */
export async function setAgentView(
  view: { source: string; label?: string; filter?: unknown; sort?: unknown[] },
  options: CallOptions = {},
): Promise<unknown> {
  return request(socketFor(options), "agent.view.set", view, options);
}

export async function clearAgentView(
  options: CallOptions & { source?: string | undefined } = {},
): Promise<unknown> {
  const params: Record<string, unknown> = {};
  if (options.source !== undefined) params.source = options.source;
  return request(socketFor(options), "agent.view.clear", params, options);
}

export async function showNotification(
  message: string,
  options: CallOptions & { title?: string } = {},
): Promise<unknown> {
  return request(
    socketFor(options),
    "notification.show",
    { title: options.title ?? "hoxay-plugins", message },
    options,
  );
}

/**
 * Subscribe to pane agent status changes. `pane.output_matched` subscriptions
 * require `source`/`match` params — pass them explicitly via `subscriptions`.
 */
export function subscribeAgentEvents(
  options: CallOptions & {
    subscriptions?: Array<Record<string, unknown>>;
  } = {},
) {
  const subscriptions = options.subscriptions ?? [{ type: "pane.agent_status_changed" }];
  return subscribe(socketFor(options), subscriptions, options);
}
