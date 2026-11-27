/**
 * rebuildup.mcp contract model — `herdr-plugins.mcp/v1` (stable).
 *
 * T1 (#135) fixes the boundary (ADR-0025), access levels, the planned
 * tool table, and the error model. T2 (#138) implemented the stdio
 * server + read tools, T3 (#139) the mutation tools, T4 (#140) the
 * event surface — all three surfaces are stable as of v1.
 */

export const CONTRACT = "herdr-plugins.mcp/v1";
export const PLUGIN_ID = "rebuildup.mcp";
export const PLUGIN_VERSION = "0.7.0";

/** Contract lifecycle: stable since T4 (#140) completed the event surface. */
export const CONTRACT_STATUS = "stable" as const;

/**
 * Per-surface stability (contract "Versioning"): the read surface is
 * stable as of T2 (#138), the mutation surface as of T3 (#139), and
 * the event surface as of T4 (#140). `capability` reports this map so
 * clients can detect what is implemented without parsing the tool table.
 */
export const SURFACE_STATUS = {
  read: "stable",
  mutation: "stable",
  events: "stable",
} as const;

/**
 * Server-side access levels (ADR-0025 §2). `supervised` maps to T3's
 * approval-required..auto band; `full` to full-access.
 */
export const ACCESS_LEVELS = ["read-only", "supervised", "full"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const DEFAULT_ACCESS_LEVEL: AccessLevel = "read-only";

/** Minimum access level a tool requires; `read-only` tools run at every level. */
export type ToolAccess = AccessLevel;

export interface ToolSpec {
  name: string;
  /** Minimum access level required to call the tool. */
  access: ToolAccess;
  /** MCP `readOnlyHint` annotation. */
  readOnly: boolean;
  /** Planned ticket surface; `implemented` flips per ticket. */
  status: "planned" | "implemented";
  /** What the tool backs onto (herdr-client method or sibling plugin CLI). */
  backs_onto: string;
}

/**
 * Planned v1 tool surface (contract `herdr-plugins.mcp/v1`, draft).
 * Order groups discovery → reads → plugin reads → mutations → events.
 */
export const TOOL_TABLE: readonly ToolSpec[] = [
  // Capability / discovery
  {
    name: "herdr_capability",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "contract + session.snapshot liveness",
  },
  {
    name: "session_snapshot",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "session.snapshot (herdr-client)",
  },
  {
    name: "agent_list",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "agent.list (herdr-client)",
  },
  {
    name: "agent_get",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "agent.get (herdr-client)",
  },
  {
    name: "agent_read",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "agent.read scrollback (herdr-client)",
  },
  {
    name: "workspace_list",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "session.snapshot workspaces (herdr-client)",
  },
  {
    name: "pane_list",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "session.snapshot panes (herdr-client)",
  },
  // Plugin contract reads
  {
    name: "conversations_search",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "rebuildup.conversations CLI (env-pinned spawn)",
  },
  {
    name: "conversations_show",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "rebuildup.conversations CLI (env-pinned spawn)",
  },
  {
    name: "git_status",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "rebuildup.git CLI (env-pinned spawn)",
  },
  {
    name: "git_files",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "rebuildup.git CLI (env-pinned spawn)",
  },
  {
    name: "git_log",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "rebuildup.git CLI (env-pinned spawn)",
  },
  {
    name: "projects_list",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "rebuildup.projects CLI (env-pinned spawn)",
  },
  {
    name: "usage_report",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "rebuildup.usage CLI (env-pinned spawn)",
  },
  // Mutations (supervised+; agent_wait is a read-level blocking observation)
  {
    name: "agent_prompt",
    access: "supervised",
    readOnly: false,
    status: "implemented",
    backs_onto: "rebuildup.controls send (identity echo + --expect-* guards)",
  },
  {
    name: "agent_wait",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "rebuildup.controls wait (blocking observation)",
  },
  {
    name: "agent_interrupt",
    access: "supervised",
    readOnly: false,
    status: "implemented",
    backs_onto: "rebuildup.controls interrupt (PTY-level send_keys)",
  },
  {
    name: "agent_start",
    access: "supervised",
    readOnly: false,
    status: "implemented",
    backs_onto:
      "rebuildup.controls start; provider permission mode capped to the negotiated access level",
  },
  {
    name: "workspace_create",
    access: "supervised",
    readOnly: false,
    status: "implemented",
    backs_onto: "herdr workspace.create (herdr-client)",
  },
  {
    name: "handoff_invoke",
    access: "supervised",
    readOnly: false,
    status: "implemented",
    backs_onto: "rebuildup.handoff execute/delegate/merge-back CLI (ADR-0021 boundaries)",
  },
  // Events (T4, #140)
  {
    name: "events_subscribe",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto:
      "events.subscribe + session.snapshot baseline (tool-polling alternative to MCP notifications)",
  },
  {
    name: "events_poll",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "in-process subscription buffer (gap/resync notices)",
  },
  {
    name: "events_wait",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "in-process subscription buffer, bounded blocking wait",
  },
  {
    name: "events_unsubscribe",
    access: "read-only",
    readOnly: true,
    status: "implemented",
    backs_onto: "subscription teardown",
  },
];

/** Structured error codes (contract "Error model"). */
export const ERROR_CODES = [
  "capability_denied",
  "not_found",
  "stale_generation",
  "session_unreachable",
  "unsupported",
  "plugin_unavailable",
  "invalid_params",
  "upstream_gap",
  "internal",
] as const;
export type McpErrorCode = (typeof ERROR_CODES)[number];

/** Recorded upstream gaps (v1 exclusions with their tracking issue). */
export const UPSTREAM_GAPS = [
  {
    id: "remote-mcp-http-oauth",
    summary:
      "herdr has no inbound HTTP server, tunnel, or OAuth/pairing mechanism; remote/hosted MCP clients cannot reach a session",
    tracking: "herdrdev/herdr#6199",
    v1: "excluded — local stdio only",
  },
  {
    id: "saved-machine-mcp-targeting",
    summary:
      "herdr --machine SSH bridge exists for CLI use; exposing remote sessions through MCP is deferred post-v1",
    tracking: "hoxay-plugins#135 ADR-0025",
    v1: "excluded",
  },
] as const;
