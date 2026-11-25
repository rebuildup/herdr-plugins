# ADR-0016: Estimated API cost pricing source and cache retention

Status: Accepted (release-0-5-0 candidate, Issue #93 / parent #28 T4)

## Context

Issue #93 finalizes `rebuildup.usage`: an estimated API-cost figure
distinct from real billing, retention/GC for plugin state, and the
stable `herdr-plugins.usage/v1` contract. #28's acceptance requires
the estimate-vs-billing distinction to be explicit and missing data
to stay non-fabricated.

Two decisions needed an ADR-level record:

1. **Where do per-model prices come from?** T3 Code
   (`apps/server/src/usage/usagePricing.ts` + `UsageService.ts`)
   fetches LiteLLM's `model_prices_and_context_window.json` at
   runtime, caches it for 24h, and falls back to the stale cache —
   the same pattern this plugin already uses for quota readings.
   Alternatives: (a) vendor a price snapshot into the repo — goes
   stale silently and bloats the plugin; (b) provider billing APIs —
   none expose per-token list prices, and subscription billing is
   exactly what the estimate must not impersonate; (c) no pricing —
   fails the ticket.

2. **How long may plugin caches live?** `quota`/`divergence` caches
   (T2/T3) had a fresh TTL but no retention bound: stale-serve was
   unbounded and removed providers'/hubs' files accumulated
   forever. #93 requires a spec'd retention that never deletes
   referenced data.

## Decision

**Pricing source: LiteLLM `model_prices_and_context_window.json`,
fetched at runtime, cached under the plugin state dir.**

- `cost` fetches the public price list (default
  `PRICING_SOURCE_URL`; `HERDR_USAGE_PRICING_URL` env or
  `pricingUrl` config are test/proxy hooks), parses standard
  per-token rates only, and caches the *parsed* table at
  `pricing-cache/litellm.json` — fresh TTL 24h
  (`pricingCacheTtlSeconds`), retention 30 days.
- Speed variants, context tiers, and 1-hour cache-write rates are
  not applied: aggregated totals carry no per-request speed or
  prompt-size signal, so only standard rates can be applied
  honestly. 1-hour cache writes price at the standard
  cache-creation rate (the index does not record the TTL split).
- Lookup is exact → bare-name → date-suffix-stripped; **unknown
  models report `unpriced` with `estimated_cost_usd: null`, never a
  guessed price**. User `modelPrices` overrides (USD per million
  tokens, T3's custom-price shape) take precedence and are counted
  in `pricing.user_overrides`.
- The estimate is always labeled: `cost.estimate: true`, a fixed
  `disclaimer`, `pricing.source`/`fetched_at`/`status`
  (`ok`/`stale`/`unavailable`), and `estimate_complete: false` when
  unpriced models contributed tokens. `provider_reported_cost_usd`
  remains a separate field — provider-reported cost is never blended
  into the estimate and the estimate is never presented as a bill.
- No credential material is involved: the price list is public,
  unauthenticated data (ADR-0014/0015 unaffected).

**Retention/GC: one shared 30-day window for every plugin cache.**

- `PLUGIN_CACHE_RETENTION_SECONDS` (30 days) bounds
  `quota-cache/*.json` (provider + hub readings) and
  `pricing-cache/*`. A cache entry is *referenced* — and therefore
  never deleted — while its payload timestamp is inside retention:
  fresh reads, in-TTL hits, and stale-serve-on-failure all qualify.
- `gcPluginStateCache` runs best-effort at the start of every
  `collectQuota`/`collectQuotaHubs`/`collectPricing`: it removes
  entries older than retention, orphaned `*.tmp-*` write temps, and
  unparseable files (which no reader can reference anyway).
- Reads additionally refuse entries past retention, so a failed GC
  can never resurrect ancient data as "stale".
- `usage` keeps no aggregate index — totals are recomputed per call,
  so there is nothing usage-side to retain. The conversations event
  index is owned and retained by `rebuildup.conversations` (its own
  lifecycle, ADR-0012); the spec records this boundary explicitly.

## Consequences

- `cost` degrades honestly: pricing source down + no cache →
  `pricing.status: "unavailable"`, every model `unpriced`,
  `estimated_cost_usd: null`, `pricing_unavailable` warning, exit 0.
- Stale price tables are served flagged (`status: "stale"`,
  `pricing_table_stale` warning) rather than failing the command.
- Disk usage under `HERDR_PLUGIN_STATE_DIR` is bounded: a handful of
  small JSON files, all ≤30 days old.
- If LiteLLM changes schema or disappears, the failure mode is
  `unavailable`/`stale` statuses — detectable, never silent zeros.
- The estimate's accuracy is bounded by list prices vs. actual
  billing (subscription discounts, promo pricing, taxes) — inherent
  to the feature and disclosed in every payload.
