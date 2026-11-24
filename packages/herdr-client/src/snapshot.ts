/**
 * Typed subset of herdr's `session.snapshot` and `agent.list` responses used by
 * herdr-plugins. These mirror the live socket schema (herdr v0.9.x, protocol
 * 22) and are intentionally permissive: unknown fields pass through.
 */

export interface AgentInfo {
  /** Agent display name (e.g. "claude"), reported by the agent source. */
  agent?: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown" | string;
  /** Monotonic per-pane counter; bumps on every agent status change. */
  state_change_seq?: number;
  completion_seq?: number;
  revision?: number;
  terminal_title_stripped?: string;
  cwd?: string;
  foreground_cwd?: string;
  tokens?: Record<string, string>;
  state_labels?: Record<string, string>;
  agent_session?: {
    /** Reporting source of the session identity. */
    source?: string;
    agent?: string;
    kind?: string;
    value?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  title?: string;
  cwd?: string;
  focused?: boolean;
  [key: string]: unknown;
}

export interface TabInfo {
  tab_id: string;
  workspace_id?: string;
  title?: string;
  [key: string]: unknown;
}

export interface WorkspaceInfo {
  workspace_id: string;
  title?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface SessionSnapshot {
  session?: { name?: string; [key: string]: unknown };
  workspaces?: WorkspaceInfo[];
  tabs?: TabInfo[];
  panes?: PaneInfo[];
  agents?: Record<string, AgentInfo>;
  [key: string]: unknown;
}

export interface AgentListResult {
  agents?: Array<AgentInfo & { pane_id?: string }>;
  [key: string]: unknown;
}

/** Per-pane agent entry keyed by pane_id, as returned in snapshots. */
export type AgentMap = Record<string, AgentInfo>;

export interface PaneAgentEntry {
  pane: PaneInfo;
  agent: AgentInfo;
}

/** Flatten snapshot panes+agents into per-pane entries. */
export function paneAgentEntries(snapshot: SessionSnapshot): PaneAgentEntry[] {
  const panes = snapshot.panes ?? [];
  const agents = snapshot.agents ?? {};
  return panes.map((pane) => ({
    pane,
    agent: agents[pane.pane_id] ?? ({} as AgentInfo),
  }));
}

/** Agent statuses that count as an active attention/working signal. */
export const ATTENTION_STATUSES = new Set(["blocked", "working"]);

export function isAttentionStatus(status: string | undefined): boolean {
  return status !== undefined && ATTENTION_STATUSES.has(status);
}
