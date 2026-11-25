/**
 * rebuildup.usage — shared model types for the
 * `herdr-plugins.usage/v1` contract (Issue #90 / parent #28 T1).
 *
 * The plugin aggregates provider-reported token usage out of the
 * `rebuildup.conversations` normalized event index — it never scans
 * PTY text and never fabricates numbers. Events without provider
 * usage simply do not appear in the source stream; sessions whose
 * index is missing/stale/error are reported in `coverage`, never
 * folded into zeroed totals as if measured.
 */

export const CONTRACT = "herdr-plugins.usage/v1";

/** The upstream index contract this plugin consumes (read-only). */
export const CONVERSATIONS_CONTRACT = "herdr-plugins.conversations/v1";
export const CONVERSATIONS_PLUGIN_ID = "rebuildup.conversations";

/** Token fields carried on usage-carrying conversation events. */
export interface UsageTokenFields {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  thinking_tokens?: number;
}

/** Identity subset of a normalized conversation event we aggregate on. */
export interface EventIdentity {
  host?: string | null;
  herdr_session?: string | null;
  workspace_id?: string | null;
  tab_id?: string | null;
  pane_id?: string | null;
  agent?: string | null;
  agent_session?: { agent?: string; kind?: string; value?: string } | null;
}

/** One usage-carrying event as exported by `conversations usage`. */
export interface UsageEventRecord {
  session_key: string;
  event: {
    event_id?: unknown;
    type?: unknown;
    timestamp?: unknown;
    model?: unknown;
    usage?: unknown;
    cost_usd?: unknown;
    identity?: unknown;
  };
}

/** Per-session registry entry as exported by `conversations usage`/`sessions`. */
export interface SessionCoverageEntry {
  key: string;
  provider?: string | null;
  provider_status?: string | null;
  cwd?: string | null;
  status?: string | null;
  error?: string | null;
  stale?: boolean | null;
  stale_reason?: string | null;
  events_present?: boolean | null;
  transcript_present?: boolean | null;
  event_count?: number | null;
}

/** Resolved data source for the conversations index. */
export interface SourceResolution {
  plugin_root: string;
  cli_path: string;
  state_dir: string;
  config_dir: string;
  /** How the root was found: explicit override, sibling, or herdr discovery. */
  resolved_via: "override" | "sibling" | "herdr-plugin-list";
}

/** Optional overrides for locating the conversations plugin. */
export interface SourceOptions {
  conversationsRoot?: string | undefined;
  conversationsStateDir?: string | undefined;
  conversationsConfigDir?: string | undefined;
}

/** Aggregation window; null bound = open-ended. Instants in ms. */
export interface UsageWindow {
  from_ms: number | null;
  to_ms: number | null;
}

/** One row of a breakdown dimension. */
export interface BreakdownEntry {
  /** Dimension value; null = the event/session did not report one. */
  key: string | null;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Sum over events that reported thinking tokens; null when none did. */
  thinking_tokens: number | null;
  /** Sum of the four canonical token buckets (thinking excluded — it is
   * a provider detail of output/reasoning, not an additional bucket). */
  total_tokens: number;
  /** Sum of provider-reported cost_usd; null when no event reported one. */
  provider_reported_cost_usd: number | null;
}

export interface UsageBreakdowns {
  by_provider: BreakdownEntry[];
  by_model: BreakdownEntry[];
  by_host: BreakdownEntry[];
  by_project: BreakdownEntry[];
  by_session: BreakdownEntry[];
  by_pane: BreakdownEntry[];
}

export interface ProviderCoverage {
  provider: string;
  /** Provider support status from the conversations capability matrix. */
  provider_status: string;
  sessions: number;
  sessions_ok: number;
  sessions_with_issues: number;
  usage_events: number;
}

export interface UsageCoverage {
  sessions_total: number;
  sessions_ok: number;
  sessions_with_issues: number;
  sessions_stale: number;
  sessions_events_missing: number;
  providers: ProviderCoverage[];
}

export interface UsageTotals {
  /** Usage-carrying events summed into the totals. */
  events: number;
  /** Sessions that contributed at least one usage event. */
  sessions_with_usage: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Null when no contributing event reported thinking tokens. */
  thinking_tokens: number | null;
  thinking_token_events: number;
  total_tokens: number;
  /** Sum of provider-reported `cost_usd` — NOT a billing amount. */
  provider_reported_cost_usd: number | null;
  provider_reported_cost_events: number;
  /** Events dropped by the time window for lacking a usable timestamp. */
  excluded_untimestamped_events: number;
  /** Events skipped as duplicates (same session_key + event_id). */
  duplicate_events_skipped: number;
  /** Events with no usable event_id — included, but cannot be deduped. */
  events_without_event_id: number;
}

export interface UsageAggregate {
  totals: UsageTotals;
  breakdowns: UsageBreakdowns;
  coverage: UsageCoverage;
  /** Sessions contributing usage events, with their registry status. */
  sessions: SessionCoverageEntry[];
}
