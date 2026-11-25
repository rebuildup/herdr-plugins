# Spec: rebuildup.usage — token usage aggregation (Issue #90 / #28 T1)

Goal: give herdr users and agents aggregated token usage — input /
output / cache-read / cache-creation (+ thinking detail) — over the
provider transcripts already normalized by `rebuildup.conversations`,
with honest reporting of what is missing, unsupported, or stale.

This is the full #28 scope. T1 (#90) shipped the aggregation core +
`herdr-plugins.usage/v1` contract; T2 (#91) added subscription
quota/reset surfacing (`quota` command) and the credential-boundary
ADR-0014; T3 (#92) added the per-provider cache-token breakdown, the
CLIProxyAPI-equivalent HTTP quota hub source (`quotaHubs` config,
ADR-0015), and the `divergence` report comparing quota windows vs
measured tokens. T4 (#93) added the `cost` command — estimated API
cost explicitly distinct from real billing — plus state
retention/GC and the finalized stable contract (ADR-0016).

## Source decision (ADR-0013)

Options from #90: (a) extract a shared normalization lib into
`packages/`, (b) conversations provides a read-only export, (c) usage
scans transcripts independently.

**Decision: (b).** `rebuildup.usage` consumes
`herdr-plugins.conversations/v1` through the plugin's public CLI —
`usage` (pages every usage-carrying normalized event with opaque
cursors) and `capability` (provider support matrix). Rationale:

- Cross-plugin *state-file* reads stay forbidden: the child process is
  pinned to the conversations plugin dirs via
  `HERDR_PLUGIN_STATE_DIR`/`_CONFIG_DIR`, and only the versioned
  contract is consumed — a conversations internal refactor cannot
  silently corrupt usage totals as long as v1 holds.
- (a) would still need the same state-dir location problem solved,
  plus a second copy of the event-log paging machinery.
- (c) duplicates the incremental indexer, its cursors, and its
  provider adapters — the exact machinery #5 already built.

Plugin root resolution: explicit override (flag/env/config) → sibling
`../conversations` → `herdr plugin list --json`. Missing plugin →
`conversations_unavailable`, never a fallback to transcript scanning.

## Commands

- `capability` — contract banner + `sources[]` matrix. Read-only;
  never fails on source resolution.
- `usage [--pane|--session-id|--provider] [--from|--to]` — full-export
  aggregation. Selectors forward to the conversations `usage`
  command; `--session`/`--socket`/`--timeout`/`--offline` control the
  herdr connection used for live-binding metadata.
- `quota [--provider] [--refresh]` — subscription quota/reset report.
  Independent of the conversations index and of any herdr session.
  Per-provider `status` is data (`ok`/`unsupported`/`no_credential`/
  `credential_expired`/`request_failed`); the command exits 0 whenever
  it can emit the envelope. `hubs[]` reports configured
  CLIProxyAPI-compatible hubs with per-account outcomes.
- `divergence [--provider] [--from|--to] [--refresh]` — places
  subscription-quota windows and transcript-measured token sums side
  by side per provider. Verdicts: `different_units` (both present —
  reported, never reconciled), `no_measured_usage`, `quota_unavailable`,
  `no_data`. Hub readings are reported under `hubs` but excluded from
  `comparisons` (account identity is unverifiable).
- `cost [--provider] [--from|--to] [--refresh]` — estimated API cost
  per model, always labeled `estimate: true` + disclaimer, never a
  bill (T4 / ADR-0016).

## Aggregation rules

- Sum only provider-reported `usage` objects on usage-carrying events.
  Sessions/events without usage contribute coverage entries, not
  zeroed token buckets.
- Dedup on `(session_key, event_id)`; missing `event_id` is counted
  (`events_without_event_id`), not silently trusted.
- Window `--from`/`--to` (ISO-8601, inclusive instants) filters on
  event timestamps; untimestamped events are excluded-and-counted when
  a window is set, included otherwise.
- `total_tokens` = input+output+cache_read+cache_creation;
  `thinking_tokens` reported separately (provider detail, not an
  extra bucket). `provider_reported_cost_usd` sums provider-reported
  `cost_usd` — explicitly not billing, not estimated price.
- Breakdowns: provider / model / host / project(cwd) / session /
  pane(pane_id at index time). `null` keys mean "unreported", never a
  guessed bucket.
- Coverage separates registry truth (`sessions_total`, `sessions_ok`,
  `sessions_with_issues`, `sessions_stale`,
  `sessions_events_missing`, per-provider status) from measured
  totals; a supported provider with zero measured usage is
  distinguishable from an unsupported one.
- `cache_tokens.providers[]` (T3) is the per-provider cache-token
  view: measured `cache_read`/`cache_creation` sums plus a `status`
  derived from the adapter capability matrix
  (`capability.providers[].usage.cache_tokens`, additive in
  conversations v1): `reported` / `unsupported` / `unknown`. A
  provider that does not account for cache tokens is `unsupported`
  explicitly — zeros are never presented as "no cache support".

## Quota sources (T2 / ADR-0014)

Provider quota artifacts verified locally and implemented:

- **claude** — `GET api.anthropic.com/api/oauth/usage` with the OAuth
  access token from `$CLAUDE_CONFIG_DIR/.credentials.json`
  (`claudeAiOauth`), macOS Keychain `Claude Code-credentials` as
  fallback only when `CLAUDE_CONFIG_DIR` is unset. Windows:
  `five_hour` (session), `seven_day` (weekly),
  `limits[]` model-scoped weekly, `extra_usage`/`spend` (monthly).
  Expired token → `credential_expired` (no refresh — that would be a
  credential mutation).
- **codex** — `GET chatgpt.com/backend-api/wham/usage` +
  `rate-limit-reset-credits` with `tokens.access_token` from
  `$CODEX_HOME/auth.json` (ChatGPT auth only; `apikey` mode →
  `unsupported`). Windows: `primary`/`secondary` rate-limit windows
  with provider-reported or position-derived durations.
- **opencode** — `unsupported`: `auth.json` holds per-provider API
  keys; no subscription quota artifact exists.

Rules (ADR-0014 is the canonical boundary):

- Credential values exist only inside the fetch closure as an
  `Authorization` header; never logged, persisted, cached, emitted,
  or passed to subprocesses (the only subprocess is the read-only
  macOS `security` Keychain lookup).
- The quota cache (`<state>/quota-cache/<provider>.json`) stores
  `{checked_at, plan, windows, reset_credits_available}` for a short
  TTL (default 300s, `quotaCacheTtlSeconds`); stale cache is served
  flagged `stale: true` when the endpoint fails.
- Endpoint overrides (`HERDR_USAGE_QUOTA_*` env, `quotaEndpoints`
  config) are documented test/proxy hooks only.
- HTTP/transport failure → `request_failed`; with cache → `ok` +
  `stale: true`. Missing data is never a fabricated zero.

## Quota hubs / CLIProxyAPI-equivalent (T3 / ADR-0015)

`config.json` `quotaHubs: [{id, url, keyEnv?}]` declares hubs speaking
the CLIProxyAPI management API (`GET /v0/management/auth-files`,
`POST /v0/management/api-call`), the same integration shape as T3
Code's `cliproxyApi.ts`. The hub holds provider credentials; the
plugin holds only the hub management key.

- `keyEnv` names the env var holding the management key (default
  `HERDR_USAGE_QUOTA_HUB_KEY`); the value is never stored in config,
  state, cache, logs, or output (ADR-0015).
- Upstream provider calls go through `api-call` with
  `Authorization: Bearer $TOKEN$` — real provider tokens never enter
  this process. Mappers exist for claude and codex accounts (same
  window parsers as the direct path, incl. Codex reset credits);
  other hub providers report per-account `unsupported`.
- Hub statuses: `ok` / `no_credential` / `unauthorized` (401/403) /
  `request_failed`; per-account failures stay per-account. Cache:
  `quota-cache/hub-<id>.json`, same TTL, only `ok`/`unsupported`
  readings cached; stale serve flagged.
- No hub configured → `hubs: []`; unreachable/credential-less →
  structured non-`ok` statuses, never an error exit.

## Divergence report (T3)

`divergence` compares subscription-quota windows (`used_percent` +
reset instants, provider-side, all clients) against transcript-measured
token sums (local index, requested window). These are different units
from different sources: the report emits both sides per provider with
verdict `different_units` and never reconciles or converts. Window
alignment (`window_alignment`) only notes whether the `--from`/`--to`
span matches a reported quota window duration. Hub readings appear
under `hubs` but are excluded from comparisons — a hub account cannot
be proven to be the same subscription as local transcripts.

## Estimated API cost (T4 / ADR-0016)

`cost` reuses the `usage` aggregation, then prices each `by_model`
bucket against a per-model rate table — the same approach as T3
Code's `usagePricing.ts`/`UsageService.ts`, simplified to what
aggregated totals can support honestly:

- **Source**: LiteLLM `model_prices_and_context_window.json`
  (public, unauthenticated — no credential boundary impact), fetched
  at runtime and cached as a parsed table at
  `pricing-cache/litellm.json` (fresh TTL 24h
  `pricingCacheTtlSeconds`; env `HERDR_USAGE_PRICING_URL` / config
  `pricingUrl` are test/proxy hooks). Stale tables are served flagged
  (`status: "stale"`), never silently trusted; no table at all →
  `status: "unavailable"` + `pricing_unavailable` warning, exit 0.
- **Rates applied**: standard per-token input/output/cache-read/
  cache-creation only. Speed variants, context tiers, and 1-hour
  cache-write rates are not applied — aggregates carry no
  per-request signal. `thinking_tokens` is never double-counted
  (inside `output_tokens`). Lookup: user `modelPrices` override →
  exact → bare name → date-suffix-stripped; **unknown model →
  `unpriced`/`null`, never guessed**.
- **Estimate ≠ billing**: `cost.estimate: true` + fixed disclaimer on
  every payload; `provider_reported_cost_usd` stays a separate field
  (provider-reported `cost_usd` sums, already in `totals`); the
  estimate excludes speed premiums, context tiers, discounts, taxes,
  and quota consumption. `estimate_complete: false` +
  `unpriced_models[]` disclose partial coverage so a priced-only sum
  is never mistaken for complete.
- **User overrides**: config `modelPrices` (USD per million tokens,
  T3's custom-price shape) price models the table lacks — counted in
  `pricing.user_overrides`.

## State retention & GC (T4 / ADR-0016)

The plugin's only durable state is caches under
`HERDR_PLUGIN_STATE_DIR`; `usage`/`cost` aggregation keeps **no**
index (recomputed per call — the conversations event index is owned
by `rebuildup.conversations`, ADR-0012).

| path | contents | fresh TTL | retention |
| --- | --- | --- | --- |
| `quota-cache/<provider>.json` | provider quota windows | `quotaCacheTtlSeconds` (300s) | 30 days |
| `quota-cache/hub-<id>.json` | hub account quota windows | same | 30 days |
| `pricing-cache/litellm.json` | parsed LiteLLM rate table | `pricingCacheTtlSeconds` (24h) | 30 days |

`gcPluginStateCache` runs best-effort on every quota/pricing
collection: entries older than `PLUGIN_CACHE_RETENTION_SECONDS`
(30 days), orphaned `*.tmp-*` temps, and unparseable files are
removed. An entry inside retention is *referenced* (fresh, in-TTL,
or stale-serve) and is never deleted; reads independently refuse
entries past retention so a failed GC cannot resurrect ancient data.

## Concurrency / state

`usage`/`cost` aggregation keeps no durable state: every call
re-exports and re-aggregates. `quota`/`cost` write only the short-term
caches under `HERDR_PLUGIN_STATE_DIR` (atomic tmp+rename,
best-effort). Reads never mutate anything — the conversations side is
read-only by contract (`read_only: true`, `mutation_commands: []`),
and quota probes are GET-only; the pricing fetch is an unauthenticated
GET of public data. Export paging is bounded (500 events/page,
2M-event safety cap → `export_incomplete_page_limit` warning +
`source.complete: false`).

## Explicit non-goals

- No reset-credit redemption or any credential/hub mutation — out of
  scope per ADR-0014/0015.
- No speed/context-tier pricing, no billing-API integration, no
  tax/discount modeling — the estimate is list-price math only
  (ADR-0016).
- No PTY scraping, no transcript scanning, no fabricated states.
