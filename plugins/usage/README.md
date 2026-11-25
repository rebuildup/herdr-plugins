# rebuildup.usage

Token usage aggregation for herdr panes
(`herdr-plugins.usage/v1`).

## Install

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/usage
```

Prerequisites: herdr ≥ 0.9.0, Bun on `PATH`, and the
[`rebuildup.conversations`](../conversations/) plugin installed and
indexed (`conversations index`/`refresh`) — usage aggregates its
normalized event index through the public read-only contract, never
its state files (ADR-0013). `capability` and `usage` work without a
reachable herdr session (`--offline` or automatic degrade).

## What it does

- Sums provider-reported token usage — `input_tokens`,
  `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, plus `thinking_tokens` detail — from
  usage-carrying conversation events.
- Breaks totals down by provider / model / host / project (pane cwd) /
  session / pane.
- Filters by `--pane`, `--session-id`, `--provider`, and an inclusive
  `--from`/`--to` time window on provider timestamps.
- Deduplicates on `(session_key, event_id)` so index rewrites cannot
  double count.
- Reports coverage honestly: unsupported providers, sessions with
  missing/stale/error index state, and missing event logs are counted
  separately — missing usage is never zero-fabricated, and
  `provider_reported_cost_usd` is labeled as provider-reported, not a
  billing amount.

No credential handling, quota endpoints, or cost estimation in this
version — those land in #91/#92/#93 behind the `sources[]` matrix.

## Usage

```bash
# from the plugin root (see `herdr plugin list --json` → plugin_root)
bun run src/cli.ts capability
bun run src/cli.ts usage [--pane PANE] [--session-id ID] [--provider ID] \
  [--from ISO] [--to ISO] [--session NAME] [--socket PATH] [--timeout MS] \
  [--offline] [--conversations-root DIR] [--conversations-state-dir DIR]
```

- `capability` → contract banner, `sources[]` data-source matrix
  (`conversations-index` available/unavailable + declared-unsupported
  quota/billing slots), aggregation dimensions.
- `usage` → `{totals, breakdowns, coverage, sessions, source,
  warnings}`. Selectors forward to `conversations usage`; the whole
  export is paged (500 events/page) and aggregated in one call.

The conversations plugin is located via `--conversations-root` /
`HERDR_USAGE_CONVERSATIONS_ROOT` / `conversationsRoot` config → sibling
`../conversations` → `herdr plugin list --json`. Its state dir defaults
to the standard plugin state location and can be overridden with
`--conversations-state-dir` / `HERDR_USAGE_CONVERSATIONS_STATE_DIR` /
`conversationsStateDir`.

Full contract: `docs/contracts/usage-v1.md`.
Spec: `docs/specs/usage.md`. Design: ADR-0013.
