# Spec: rebuildup.usage — token usage aggregation (Issue #90 / #28 T1)

Goal: give herdr users and agents aggregated token usage — input /
output / cache-read / cache-creation (+ thinking detail) — over the
provider transcripts already normalized by `rebuildup.conversations`,
with honest reporting of what is missing, unsupported, or stale.

This is T1 of #28. Subscription quota/reset endpoints and credential
handling are **T2 (#91)** scope; cache-token refinements, HTTP quota
sources, and CLIProxyAPI-style integration are **T3 (#92)**; estimated
API cost vs. real billing and history retention are **T4 (#93)**. T1
ships the aggregation core + `herdr-plugins.usage/v1` contract and
leaves clean seams for those tickets.

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

## Concurrency / state

No durable state: every `usage` call re-exports and re-aggregates.
Reads never mutate anything — the conversations side is read-only by
contract (`read_only: true`, `mutation_commands: []`). Export paging
is bounded (500 events/page, 2M-event safety cap →
`export_incomplete_page_limit` warning + `source.complete: false`).

## Explicit non-goals (T2–T4)

- No credential store access, no quota endpoints, no OAuth — #91 ADR.
- No HTTP quota sources / CLIProxyAPI / divergence reports — #92.
- No estimated API pricing, no cost-vs-billing distinction beyond the
  `provider_reported_cost_usd` label, no history GC — #93.
- No PTY scraping, no transcript scanning, no fabricated states.
