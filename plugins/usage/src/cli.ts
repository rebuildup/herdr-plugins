/**
 * rebuildup.usage CLI — token usage aggregation contract
 * (`herdr-plugins.usage/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * Aggregation consumes the `rebuildup.conversations` read-only export
 * (`usage` event paging + `capability` provider matrix) — never its
 * state files, never PTY text (ADR-0013). The plugin is read-only and
 * keeps no durable state: totals are recomputed from the index on
 * every call.
 */

import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import { aggregateUsage, buildCacheTokens } from "./aggregate";
import { computeModelCosts } from "./cost";
import { buildDivergence } from "./divergence";
import { collectQuotaHubs, DEFAULT_HUB_KEY_ENV, hubBaseUrl } from "./hub";
import {
  type BreakdownEntry,
  CONTRACT,
  CONVERSATIONS_CONTRACT,
  type CostEstimate,
  type ModelPriceOverride,
  type PricingInfo,
  type QuotaEndpoints,
  type QuotaHubConfig,
  type SourceOptions,
  type UsageTotals,
  type UsageWindow,
} from "./model";
import { collectPricing, PRICING_CACHE_TTL_SECONDS, PRICING_SOURCE_URL } from "./pricing";
import { collectQuota, QUOTA_CACHE_TTL_SECONDS, QUOTA_PROVIDERS } from "./quota";
import {
  type CliCallOptions,
  exportUsageEvents,
  fetchConversationsCapability,
  resolveConversationsSource,
  type UsageSelectors,
} from "./source";

const PLUGIN_ID = "rebuildup.usage";
const PLUGIN_VERSION = "0.6.0";

interface CliOptions {
  command: string;
  args: string[];
  session: string | undefined;
  socketPath: string | undefined;
  timeoutMs: number | undefined;
  offline: boolean | undefined;
  pane: string | undefined;
  sessionId: string | undefined;
  provider: string | undefined;
  from: string | undefined;
  to: string | undefined;
  conversationsRoot: string | undefined;
  conversationsStateDir: string | undefined;
  conversationsConfigDir: string | undefined;
  refresh: boolean | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = {
    command,
    args: [],
    session: undefined,
    socketPath: undefined,
    timeoutMs: undefined,
    offline: undefined,
    pane: undefined,
    sessionId: undefined,
    provider: undefined,
    from: undefined,
    to: undefined,
    conversationsRoot: undefined,
    conversationsStateDir: undefined,
    conversationsConfigDir: undefined,
    refresh: undefined,
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const next = () => args[++i];
    if (arg === "--session") options.session = next();
    else if (arg === "--session-id") options.sessionId = next();
    else if (arg === "--pane") options.pane = next();
    else if (arg === "--provider") options.provider = next();
    else if (arg === "--from") options.from = next();
    else if (arg === "--to") options.to = next();
    else if (arg === "--socket") options.socketPath = next();
    else if (arg === "--timeout") {
      const value = Number(next());
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else if (arg === "--offline") options.offline = true;
    else if (arg === "--conversations-root") options.conversationsRoot = next();
    else if (arg === "--conversations-state-dir") options.conversationsStateDir = next();
    else if (arg === "--conversations-config-dir") options.conversationsConfigDir = next();
    else if (arg === "--refresh") options.refresh = true;
    else rest.push(arg);
  }
  options.args = rest;
  return options;
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message: string, code = 1, kind?: string, extra?: Record<string, unknown>): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind) error.kind = kind;
  if (extra) Object.assign(error, extra);
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function now(): string {
  return new Date().toISOString();
}

// --- config ------------------------------------------------------------------

interface PluginConfig {
  timeoutMs?: number;
  conversationsRoot?: string;
  conversationsStateDir?: string;
  conversationsConfigDir?: string;
  quotaCacheTtlSeconds?: number;
  quotaEndpoints?: QuotaEndpoints;
  /** CLIProxyAPI-equivalent quota hubs (T3 / #92, ADR-0015). */
  quotaHubs?: QuotaHubConfig[];
  /** Estimated-cost pricing (T4 / #93): source override + TTL + user prices. */
  pricingUrl?: string;
  pricingCacheTtlSeconds?: number;
  modelPrices?: Record<string, ModelPriceOverride>;
}

async function loadConfig(): Promise<PluginConfig> {
  const file = path.join(pluginDirs(PLUGIN_ID).configDir, "config.json");
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(file, "utf8")) as PluginConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Validated hub configs from config.json (malformed entries dropped). */
function hubConfigs(config: PluginConfig): QuotaHubConfig[] {
  if (!Array.isArray(config.quotaHubs)) return [];
  return config.quotaHubs.filter(
    (h): h is QuotaHubConfig =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as QuotaHubConfig).id === "string" &&
      (h as QuotaHubConfig).id !== "" &&
      typeof (h as QuotaHubConfig).url === "string" &&
      (h as QuotaHubConfig).url !== "",
  );
}

/** CLI flag > env > config.json > default for each source override. */
function sourceOptions(
  flags: {
    conversationsRoot?: string | undefined;
    conversationsStateDir?: string | undefined;
    conversationsConfigDir?: string | undefined;
  },
  config: PluginConfig,
): SourceOptions {
  return {
    conversationsRoot:
      flags.conversationsRoot ??
      process.env.HERDR_USAGE_CONVERSATIONS_ROOT ??
      config.conversationsRoot,
    conversationsStateDir:
      flags.conversationsStateDir ??
      process.env.HERDR_USAGE_CONVERSATIONS_STATE_DIR ??
      config.conversationsStateDir,
    conversationsConfigDir:
      flags.conversationsConfigDir ??
      process.env.HERDR_USAGE_CONVERSATIONS_CONFIG_DIR ??
      config.conversationsConfigDir,
  };
}

function callOptions(options: CliOptions, config: PluginConfig): CliCallOptions {
  const call: CliCallOptions = {};
  if (options.session !== undefined) call.session = options.session;
  if (options.socketPath !== undefined) call.socketPath = options.socketPath;
  const timeout = options.timeoutMs ?? config.timeoutMs;
  if (timeout !== undefined) call.timeoutMs = timeout;
  if (options.offline === true) call.offline = true;
  return call;
}

// --- capability ---------------------------------------------------------------

async function cmdCapability(): Promise<void> {
  const config = await loadConfig();
  const resolved = await resolveConversationsSource(sourceOptions({}, config));
  // capability must never fail on source resolution — report it.
  const sourceEntry = resolved.ok
    ? {
        id: "conversations-index",
        kind: "normalized-events",
        contract: CONVERSATIONS_CONTRACT,
        status: "available",
        plugin_root: resolved.source.plugin_root,
        resolved_via: resolved.source.resolved_via,
        freshness:
          "as of the last `rebuildup.conversations index`/`refresh` run; run it to pick up new transcripts",
      }
    : {
        id: "conversations-index",
        kind: "normalized-events",
        contract: CONVERSATIONS_CONTRACT,
        status: "unavailable",
        detail: resolved.error,
      };

  emit({
    contract: CONTRACT,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    read_only: true,
    mutation_commands: [],
    commands: ["capability", "usage", "quota", "divergence", "cost"],
    sources: [
      sourceEntry,
      {
        id: "subscription-quota-api",
        kind: "provider-quota",
        status: "available",
        credential_boundary: "docs/adr/0014-usage-quota-credential-boundary.md",
        providers: {
          claude: "implemented (oauth usage endpoint, ~/.claude credentials / macOS Keychain)",
          codex: "implemented (wham usage endpoint, ChatGPT auth.json only)",
          opencode: "unsupported (per-provider API keys; no subscription quota artifact)",
        },
        freshness:
          "short-term cache (default 300s) under the plugin state dir; stale readings are flagged, never silently refreshed",
        detail:
          "Quota probes never emit credential material; see ADR-0014 for the read/logging boundary.",
      },
      {
        id: "cliproxy-api",
        kind: "http-quota-hub",
        status: "available",
        credential_boundary: "docs/adr/0015-usage-hub-credential-boundary.md",
        hubs: hubConfigs(config).map((h) => {
          const keyEnv = h.keyEnv ?? DEFAULT_HUB_KEY_ENV;
          return {
            id: h.id,
            endpoint: hubBaseUrl(h.url)?.endpoint ?? null,
            key_env: keyEnv,
            key_configured: (process.env[keyEnv]?.trim() ?? "") !== "",
          };
        }),
        providers: {
          claude: "implemented via hub api-call (provider token stays hub-side)",
          codex: "implemented via hub api-call (provider token stays hub-side)",
          note: "hub accounts of other providers are reported per-account as unsupported",
        },
        freshness:
          "shares the quota cache TTL under the plugin state dir; stale readings are flagged, never silently refreshed",
        detail:
          "Hub management keys come from env vars named by config `quotaHubs[].keyEnv`; they are sent only to the configured hub origin and never logged, persisted, cached, or emitted (ADR-0015).",
      },
      {
        id: "model-pricing",
        kind: "price-table",
        status: "available",
        source: PRICING_SOURCE_URL,
        freshness:
          "cached under the plugin state dir (default 24h TTL, 30-day retention); stale tables are flagged, never silently trusted",
        detail:
          "Estimated API cost only — list-price math over standard rates, never a bill. Unknown models report unpriced, never a guessed price. User overrides via config `modelPrices`.",
      },
    ],
    aggregation: {
      dimensions: ["provider", "model", "host", "project", "session", "pane"],
      window: "--from/--to ISO-8601 bounds on event timestamps (inclusive)",
      dedup: "(session_key, event_id); index rewrites are flagged, never hidden",
      honesty:
        "missing usage is never zero-fabricated; provider_reported_cost_usd is not a billing amount",
    },
    generated_at: now(),
  });
}

// --- usage --------------------------------------------------------------------

function parseWindow(options: CliOptions): { from_ms: number | null; to_ms: number | null } {
  let fromMs: number | null = null;
  let toMs: number | null = null;
  if (options.from !== undefined) {
    fromMs = Date.parse(options.from);
    if (Number.isNaN(fromMs)) fail(`invalid --from timestamp: ${options.from}`, 2);
  }
  if (options.to !== undefined) {
    toMs = Date.parse(options.to);
    if (Number.isNaN(toMs)) fail(`invalid --to timestamp: ${options.to}`, 2);
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    fail(`--from (${options.from}) is after --to (${options.to})`, 2);
  }
  return { from_ms: fromMs, to_ms: toMs };
}

/**
 * Build the `usage` command payload (shared by `usage` and
 * `divergence`). Calls `fail()` (process exit) on source/export
 * errors, same as before.
 */
async function buildUsageReport(
  options: CliOptions,
  config: PluginConfig,
  window: UsageWindow,
): Promise<Record<string, unknown>> {
  const resolved = await resolveConversationsSource(sourceOptions(options, config));
  if (!resolved.ok) {
    fail(resolved.error, 1, resolved.kind, {
      hint: "install rebuildup.conversations or set conversationsRoot in config.json",
    });
  }
  const source = resolved.source;
  const call = callOptions(options, config);
  const selectors: UsageSelectors = {
    pane: options.pane,
    sessionId: options.sessionId,
    provider: options.provider,
  };

  const exported = await exportUsageEvents(source, call, selectors);
  if ("error" in exported) {
    fail(exported.error, 1, exported.kind);
  }

  const capability = await fetchConversationsCapability(source, call);
  const providerStatus: Record<string, string> = {};
  const cacheCapability: Record<string, string> = {};
  for (const p of capability?.providers ?? []) {
    providerStatus[p.id] = p.status;
    if (p.usage?.cache_tokens !== undefined) cacheCapability[p.id] = p.usage.cache_tokens;
  }

  const aggregate = aggregateUsage({
    events: exported.events,
    sessions: exported.sessions,
    window,
    providerStatus,
  });

  // Providers declared by conversations but with zero indexed sessions
  // still belong in coverage — "supported but nothing indexed" is a
  // different state from "unsupported".
  const seenProviders = new Set(aggregate.coverage.providers.map((p) => p.provider));
  for (const p of capability?.providers ?? []) {
    if (seenProviders.has(p.id)) continue;
    aggregate.coverage.providers.push({
      provider: p.id,
      provider_status: p.status,
      sessions: 0,
      sessions_ok: 0,
      sessions_with_issues: 0,
      usage_events: 0,
    });
  }
  aggregate.coverage.providers.sort(
    (a, b) => b.usage_events - a.usage_events || a.provider.localeCompare(b.provider),
  );

  // Cache-token breakdown: measured sums from the provider buckets,
  // accounting status from the adapter capability matrix (T3 / #92).
  const cacheTokens = buildCacheTokens({
    providers: aggregate.coverage.providers,
    measured: aggregate.breakdowns.by_provider,
    cacheCapability,
  });

  const warnings: string[] = [];
  if (!exported.complete) warnings.push("export_incomplete_page_limit");
  if (exported.malformed_lines > 0) warnings.push("index_malformed_lines");
  if (exported.duplicates_skipped > 0) warnings.push("index_duplicate_events_skipped");
  if (exported.restarted_sessions.length > 0) warnings.push("index_sessions_restarted");
  if (aggregate.totals.excluded_untimestamped_events > 0) {
    warnings.push("untimestamped_events_excluded_by_window");
  }
  if (aggregate.totals.duplicate_events_skipped > 0) warnings.push("duplicate_events_skipped");
  if (aggregate.totals.events_without_event_id > 0) warnings.push("events_without_event_id");

  return {
    contract: CONTRACT,
    command: "usage",
    window:
      window.from_ms === null && window.to_ms === null
        ? null
        : {
            from: options.from ?? null,
            to: options.to ?? null,
          },
    filters: {
      pane_id: options.pane ?? null,
      session_id: options.sessionId ?? null,
      provider: options.provider ?? null,
    },
    totals: aggregate.totals,
    breakdowns: aggregate.breakdowns,
    cache_tokens: cacheTokens,
    coverage: aggregate.coverage,
    sessions: aggregate.sessions,
    source: {
      plugin: "rebuildup.conversations",
      contract: exported.contract ?? CONVERSATIONS_CONTRACT,
      plugin_root: source.plugin_root,
      resolved_via: source.resolved_via,
      pages: exported.pages,
      complete: exported.complete,
    },
    warnings,
    ...(aggregate.totals.events === 0 && aggregate.coverage.sessions_total === 0
      ? {
          hint: "no indexed sessions; run `rebuildup.conversations index` to build the transcript index",
        }
      : {}),
    generated_at: now(),
  };
}

async function cmdUsage(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const window = parseWindow(options);
  emit(await buildUsageReport(options, config, window));
}

// --- quota ----------------------------------------------------------------------

/**
 * Subscription quota/reset report. Per-provider outcomes are data, not
 * errors: the command exits 0 whenever it can produce the envelope, and
 * each provider carries an explicit status (`ok` / `unsupported` /
 * `no_credential` / `credential_expired` / `request_failed`). Credential
 * material never appears in output (ADR-0014).
 */
async function cmdQuota(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const call = callOptions(options, config);
  const providers =
    options.provider !== undefined && options.provider !== "" ? [options.provider] : undefined;
  // Endpoint overrides: env wins over config.json (both are test/proxy
  // hooks; see contract). Env is folded in here so collectQuota's own
  // env resolution sees one consistent override set.
  const envEndpoints: QuotaEndpoints = {
    claude: process.env.HERDR_USAGE_QUOTA_CLAUDE_URL ?? config.quotaEndpoints?.claude,
    codexUsage: process.env.HERDR_USAGE_QUOTA_CODEX_USAGE_URL ?? config.quotaEndpoints?.codexUsage,
    codexCredits:
      process.env.HERDR_USAGE_QUOTA_CODEX_CREDITS_URL ?? config.quotaEndpoints?.codexCredits,
  };
  const ttl =
    typeof config.quotaCacheTtlSeconds === "number" && config.quotaCacheTtlSeconds > 0
      ? Math.floor(config.quotaCacheTtlSeconds)
      : QUOTA_CACHE_TTL_SECONDS;

  const results = await collectQuota({
    providers,
    refresh: options.refresh === true,
    timeoutMs: call.timeoutMs ?? 10_000,
    endpoints: envEndpoints,
    cacheTtlSeconds: ttl,
  });
  const hubs = await collectQuotaHubs({
    hubs: hubConfigs(config),
    refresh: options.refresh === true,
    timeoutMs: call.timeoutMs ?? 10_000,
    cacheTtlSeconds: ttl,
  });

  emit({
    contract: CONTRACT,
    command: "quota",
    cache: { ttl_seconds: ttl },
    providers: results,
    hubs,
    generated_at: now(),
  });
}

// --- cost -------------------------------------------------------------------------

/** Fixed disclaimer attached to every `cost` payload (T4 / #93). */
export const COST_DISCLAIMER =
  "estimated_cost_usd is a list-price ESTIMATE computed from the model " +
  "pricing table (LiteLLM snapshot or user modelPrices overrides) over " +
  "standard token rates. It is not a bill, invoice, or subscription " +
  "charge: it excludes speed premiums, context-tier repricing, provider " +
  "discounts, taxes, and quota consumption. provider_reported_cost_usd is " +
  "a separate provider-reported figure and is never blended in. Models " +
  "without a rate report unpriced — see cost.unpriced_models.";

/**
 * Estimated API cost report (T4 / #93). Runs the same aggregation as
 * `usage`, then prices each `by_model` bucket against the rate table.
 * The estimate is always labeled (`cost.estimate: true` +
 * `disclaimer`); an unavailable table degrades to all-unpriced with a
 * `pricing_unavailable` warning, never an error exit and never a
 * fabricated zero.
 */
async function cmdCost(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const window = parseWindow(options);
  const report = await buildUsageReport(options, config, window);
  const call = callOptions(options, config);

  const pricingTtl =
    typeof config.pricingCacheTtlSeconds === "number" && config.pricingCacheTtlSeconds > 0
      ? Math.floor(config.pricingCacheTtlSeconds)
      : PRICING_CACHE_TTL_SECONDS;
  const pricing = await collectPricing({
    refresh: options.refresh === true,
    timeoutMs: call.timeoutMs ?? 10_000,
    // env > config.json > default (same precedence as quota endpoints)
    sourceUrl: process.env.HERDR_USAGE_PRICING_URL ?? config.pricingUrl,
    ttlSeconds: pricingTtl,
    modelPrices: config.modelPrices,
  });

  const breakdowns = report.breakdowns as { by_model: BreakdownEntry[] };
  const totals = report.totals as UsageTotals;
  const computation = computeModelCosts(breakdowns.by_model, pricing);

  const cost: CostEstimate & { by_model: ReturnType<typeof computeModelCosts>["by_model"] } = {
    estimate: true,
    disclaimer: COST_DISCLAIMER,
    estimated_cost_usd: computation.estimated_cost_usd,
    estimate_complete: computation.estimate_complete,
    priced_models: computation.priced_models,
    unpriced_models: computation.unpriced_models,
    provider_reported_cost_usd: totals.provider_reported_cost_usd,
    pricing: pricing.info satisfies PricingInfo,
    by_model: computation.by_model,
  };

  const warnings = [...(report.warnings as string[])];
  if (pricing.info.status === "unavailable") warnings.push("pricing_unavailable");
  if (pricing.info.status === "stale") warnings.push("pricing_table_stale");
  if (computation.unpriced_models.length > 0) warnings.push("unpriced_models");

  emit({
    contract: CONTRACT,
    command: "cost",
    window: report.window,
    filters: report.filters,
    cost,
    totals,
    breakdowns: report.breakdowns,
    coverage: report.coverage,
    sessions: report.sessions,
    source: report.source,
    warnings,
    ...(typeof report.hint === "string" ? { hint: report.hint } : {}),
    generated_at: now(),
  });
}

// --- divergence -------------------------------------------------------------------

/**
 * Quota-vs-measured divergence report (T3 / #92). Runs the same
 * aggregation as `usage`, probes the direct provider quota sources,
 * and places both sides side by side per provider — different units,
 * different scopes, never reconciled. Hub (cliproxy) readings are
 * reported under `hubs` but excluded from `comparisons`: a hub account
 * cannot be proven to be the same subscription as the locally indexed
 * transcripts.
 */
async function cmdDivergence(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const window = parseWindow(options);
  const report = await buildUsageReport(options, config, window);
  const call = callOptions(options, config);
  const ttl =
    typeof config.quotaCacheTtlSeconds === "number" && config.quotaCacheTtlSeconds > 0
      ? Math.floor(config.quotaCacheTtlSeconds)
      : QUOTA_CACHE_TTL_SECONDS;

  const coverage = report.coverage as {
    providers: { provider: string; provider_status?: string | null }[];
  };
  const breakdowns = report.breakdowns as { by_provider: BreakdownEntry[] };
  const providerIds = new Set<string>([
    ...coverage.providers.map((p) => p.provider),
    ...QUOTA_PROVIDERS.map((p) => p.id),
  ]);
  if (options.provider !== undefined && options.provider !== "") {
    providerIds.clear();
    providerIds.add(options.provider);
  }

  const envEndpoints: QuotaEndpoints = {
    claude: process.env.HERDR_USAGE_QUOTA_CLAUDE_URL ?? config.quotaEndpoints?.claude,
    codexUsage: process.env.HERDR_USAGE_QUOTA_CODEX_USAGE_URL ?? config.quotaEndpoints?.codexUsage,
    codexCredits:
      process.env.HERDR_USAGE_QUOTA_CODEX_CREDITS_URL ?? config.quotaEndpoints?.codexCredits,
  };
  const quotaResults = await collectQuota({
    providers: [...providerIds],
    refresh: options.refresh === true,
    timeoutMs: call.timeoutMs ?? 10_000,
    endpoints: envEndpoints,
    cacheTtlSeconds: ttl,
  });
  const hubs = await collectQuotaHubs({
    hubs: hubConfigs(config),
    refresh: options.refresh === true,
    timeoutMs: call.timeoutMs ?? 10_000,
    cacheTtlSeconds: ttl,
  });

  const comparisons = buildDivergence({
    providers:
      options.provider !== undefined && options.provider !== ""
        ? coverage.providers.filter((p) => p.provider === options.provider)
        : coverage.providers,
    measured: breakdowns.by_provider,
    quota: quotaResults,
    window,
  });

  emit({
    contract: CONTRACT,
    command: "divergence",
    window: report.window,
    filters: report.filters,
    comparisons,
    hubs,
    notes: [
      "comparisons cover direct provider quota sources only; hub (cliproxy) readings under `hubs` are excluded because a hub account cannot be proven to be the same subscription as the locally indexed transcripts",
      "quota used_percent and measured token sums are different units from different sources — verdict `different_units` reports both sides and never reconciles them",
    ],
    source: report.source,
    generated_at: now(),
  });
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "capability":
      return cmdCapability();
    case "usage":
      return cmdUsage(options);
    case "quota":
      return cmdQuota(options);
    case "cost":
      return cmdCost(options);
    case "divergence":
      return cmdDivergence(options);
    case "help":
    case "--help":
    case "-h":
      emit({
        contract: CONTRACT,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        usage:
          "bun run src/cli.ts <capability|usage|quota|divergence|cost> [--pane PANE] [--session-id ID] [--provider ID] [--from ISO] [--to ISO] [--refresh] [--session NAME] [--socket PATH] [--timeout MS] [--offline] [--conversations-root DIR] [--conversations-state-dir DIR]",
      });
      return;
    default:
      fail(`unknown command: ${options.command}`, 2);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
