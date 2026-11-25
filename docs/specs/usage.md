# Spec: rebuildup.usage — token usage aggregation (Issue #90 / #28 T1)

Goal: give herdr users and agents aggregated token usage — input /
output / cache-read / cache-creation (+ thinking detail) — over the
provider transcripts already normalized by `rebuildup.conversations`,
with honest reporting of what is missing, unsupported, or stale.

This is T1+T2 of #28. T1 (#90) shipped the aggregation core +
`herdr-plugins.usage/v1` contract; T2 (#91) adds subscription
quota/reset surfacing (`quota` command) and the credential-boundary
ADR-0014. Cache-token refinements, HTTP quota sources, and
CLIProxyAPI-style integration remain **T3 (#92)**; estimated API cost
vs. real billing and history retention are **T4 (#93)**.

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
  it can emit the envelope.

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

## Concurrency / state

`usage` keeps no durable state: every call re-exports and
re-aggregates. `quota` writes only the short-term quota cache under
`HERDR_PLUGIN_STATE_DIR` (atomic tmp+rename, best-effort). Reads never
mutate anything — the conversations side is read-only by contract
(`read_only: true`, `mutation_commands: []`), and quota probes are
GET-only. Export paging is bounded (500 events/page, 2M-event safety
cap → `export_incomplete_page_limit` warning + `source.complete:
false`).

## Explicit non-goals (T3–T4)

- No HTTP quota sources / CLIProxyAPI / divergence reports — #92.
- No reset-credit redemption or any credential mutation — #92+.
- No estimated API pricing, no cost-vs-billing distinction beyond the
  `provider_reported_cost_usd` label, no history GC — #93.
- No PTY scraping, no transcript scanning, no fabricated states.
