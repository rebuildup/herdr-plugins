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

// --- cache token breakdown (T3 / #92) ------------------------------------------

/**
 * Whether a provider's cache-token accounting can be trusted in the
 * aggregated output. `reported` = the conversations adapter declares
 * cache-token mapping and the provider is supported; `unsupported` =
 * the provider/adapter has no cache-token accounting (explicit, never
 * a silent zero); `unknown` = the capability matrix could not verify
 * (provider absent from it or capability fetch failed).
 */
export type CacheTokenStatus = "reported" | "unsupported" | "unknown";

/** Per-provider cache-token row of the `usage` cache breakdown. */
export interface CacheTokenProviderEntry {
  provider: string;
  status: CacheTokenStatus;
  /** Usage-carrying events summed for this provider (0 = none measured). */
  events: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Why the status is not `reported`; null when reported. */
  detail: string | null;
}

export interface UsageCacheTokens {
  providers: CacheTokenProviderEntry[];
}

// --- subscription quota (T2 / #91, ADR-0014) ---------------------------------

/**
 * Per-provider quota probe outcome. `ok` means fresh or cached provider
 * data; every other status is an honest non-answer — never a fabricated
 * zero. `unsupported` = no quota artifact exists for the provider;
 * `no_credential` = the provider's credential store has no usable
 * login; `credential_expired` = a token exists but is past expiry
 * (refresh is out of scope, ADR-0014); `request_failed` = the quota
 * endpoint could not be read (HTTP/transport/parse).
 */
export type QuotaStatus =
  | "ok"
  | "unsupported"
  | "no_credential"
  | "credential_expired"
  | "request_failed";

export type QuotaWindowKind = "session" | "weekly" | "monthly" | "other";

/** One provider-reported quota/reset window. */
export interface QuotaWindow {
  id: string;
  label: string;
  kind: QuotaWindowKind;
  /** 0-100 utilization as reported by the provider. */
  used_percent: number;
  /** ISO-8601 reset instant, or null when the provider did not report one. */
  resets_at: string | null;
  /** Provider-reported or derived window length in minutes; null when unknown. */
  window_duration_mins: number | null;
}

export interface QuotaCacheInfo {
  /** True when the payload came from the on-disk short-term cache. */
  hit: boolean;
  /** Age of the cached reading in seconds; null on a fresh fetch. */
  age_seconds: number | null;
  ttl_seconds: number;
}

/** One provider's quota report inside a `quota` command result. */
export interface QuotaProviderResult {
  provider: string;
  status: QuotaStatus;
  /** Human-readable reason for non-ok statuses; null when ok. */
  detail: string | null;
  /** Provider plan label (e.g. subscription type); null when unreported. */
  plan: string | null;
  windows: QuotaWindow[];
  /** When the provider endpoint last answered successfully; null otherwise. */
  checked_at: string | null;
  /** When this report entry was produced. */
  fetched_at: string;
  /** True when serving a cached reading older than the fresh TTL. */
  stale: boolean;
  stale_reason: string | null;
  /** Banked reset credits count when the provider reports them; else null. */
  reset_credits_available: number | null;
  cache: QuotaCacheInfo;
}

/** Endpoint overrides (test hooks / future proxies); full URLs. */
export interface QuotaEndpoints {
  claude?: string | undefined;
  codexUsage?: string | undefined;
  codexCredits?: string | undefined;
}

// --- HTTP quota hubs / CLIProxyAPI-equivalent sources (T3 / #92, ADR-0015) ------

/**
 * One configured quota hub (CLIProxyAPI-compatible management API).
 * `url` is not secret; the management key is NEVER stored here —
 * `keyEnv` names the environment variable that holds it (ADR-0015).
 */
export interface QuotaHubConfig {
  id: string;
  url: string;
  /** Env var holding the hub management key. Default when absent. */
  keyEnv?: string | undefined;
}

/** Per-account outcome inside a hub report. */
export interface HubAccountResult {
  /** Hub-side auth-file id — a local label, not a credential. */
  account: string;
  /** Provider id reported by the hub (`claude`, `codex`, …). */
  provider: string;
  status: QuotaStatus | "skipped";
  detail: string | null;
  plan: string | null;
  windows: QuotaWindow[];
  checked_at: string | null;
  reset_credits_available: number | null;
}

/** Hub-level quota report inside a `quota`/`divergence` result. */
export interface QuotaHubResult {
  id: string;
  kind: "cliproxy-api";
  /** Sanitized hub base URL (origin + path); null when unparseable. */
  endpoint: string | null;
  status: "ok" | "no_credential" | "unauthorized" | "request_failed";
  detail: string | null;
  checked_at: string | null;
  fetched_at: string;
  stale: boolean;
  stale_reason: string | null;
  cache: QuotaCacheInfo;
  accounts: HubAccountResult[];
}

// --- quota vs measured divergence report (T3 / #92) ----------------------------

/**
 * How the measured token window relates to the provider's quota
 * windows. Quota `used_percent` and transcript token sums are
 * different units from different sources — this field only describes
 * window alignment, never equivalence.
 */
export type DivergenceWindowAlignment =
  | "unbounded"
  | "matches_quota_window"
  | "custom_window"
  | "unknown";

export type DivergenceVerdict =
  /** Both sides present; units differ — reported side by side. */
  | "different_units"
  /** Quota side answered but nothing was measured for the provider. */
  | "no_measured_usage"
  /** Quota side could not answer (any non-ok status). */
  | "quota_unavailable"
  /** Neither side has data. */
  | "no_data";

export interface DivergenceMeasured {
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
}

export interface DivergenceQuotaSide {
  status: QuotaStatus;
  detail: string | null;
  plan: string | null;
  checked_at: string | null;
  stale: boolean;
  windows: QuotaWindow[];
}

export interface DivergenceComparison {
  provider: string;
  verdict: DivergenceVerdict;
  detail: string | null;
  quota: DivergenceQuotaSide | null;
  measured: DivergenceMeasured | null;
  window_alignment: DivergenceWindowAlignment;
}

// --- estimated API cost (T4 / #93) ---------------------------------------------

/**
 * Pricing-table status for the `cost` command. `ok` = fresh fetch or
 * in-TTL cache hit; `stale` = serving a cached table older than the
 * TTL because the source could not be reached; `unavailable` = no
 * usable table at all — every model reports unpriced, never a
 * fabricated zero.
 */
export type PricingStatus = "ok" | "stale" | "unavailable";

/**
 * User-supplied price override (config.json `modelPrices`), USD per
 * million tokens — the same shape T3 Code exposes as custom model
 * prices. Cache rates fall back to the input rate when omitted.
 */
export interface ModelPriceOverride {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  cacheReadCostPerMillionTokens?: number;
  cacheWriteCostPerMillionTokens?: number;
}

/** Serializable pricing provenance reported by `cost`. */
export interface PricingInfo {
  status: PricingStatus;
  /** Rate-table source URL actually used (override or default). */
  source: string;
  /** When the table was fetched; the cache `fetched_at` on a hit. */
  fetched_at: string | null;
  cache: { hit: boolean; age_seconds: number | null; ttl_seconds: number };
  /** Number of models in the loaded table (0 when unavailable). */
  known_models: number;
  /** Number of user `modelPrices` overrides merged into lookups. */
  user_overrides: number;
  /** Sanitized failure detail for non-ok statuses; null otherwise. */
  detail: string | null;
}

/** Where a model's estimated cost came from. */
export type CostSource =
  /** Priced by the rate table (LiteLLM or a user `modelPrices` override). */
  | "model_priced"
  /** Contributed tokens but no rate exists — cost is null, never guessed. */
  | "unpriced";

/** One `by_model` row of the `cost` command. */
export interface ModelCostEntry {
  key: string | null;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
  thinking_tokens: number | null;
  /** Sum of provider-reported `cost_usd`; null when none reported. */
  provider_reported_cost_usd: number | null;
  /** List-price estimate under the rate table; null when unpriced or
   * the table is unavailable. An estimate, never a bill. */
  estimated_cost_usd: number | null;
  cost_source: CostSource;
}

/** A model that contributed tokens but has no rate-table entry. */
export interface UnpricedModel {
  key: string | null;
  events: number;
  total_tokens: number;
}

/** The `cost` block of the `cost` command payload. */
export interface CostEstimate {
  /** Always true — this block is an estimate by contract. */
  estimate: true;
  /** Fixed human-readable disclaimer (estimate ≠ billing). */
  disclaimer: string;
  /** Sum of `estimated_cost_usd` over priced models only; null when no
   * model could be priced (unavailable table or all unpriced). */
  estimated_cost_usd: number | null;
  /** False when unpriced models contributed tokens — the total then
   * covers priced models only and understates the true estimate. */
  estimate_complete: boolean;
  priced_models: number;
  unpriced_models: UnpricedModel[];
  /** Mirror of `totals.provider_reported_cost_usd` for side-by-side
   * reading — provider-reported cost stays a separate figure. */
  provider_reported_cost_usd: number | null;
  pricing: PricingInfo;
}
