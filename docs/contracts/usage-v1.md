# Contract `herdr-plugins.usage/v1`

Token-usage aggregation + subscription quota CLI contract for the
`rebuildup.usage` herdr plugin (Issue #90 T1, Issue #91 T2 / parent
#28). Follows the same conventions as
`herdr-plugins.conversations/v1` and the other plugin contracts.

The plugin is **read-only**: `usage` keeps no durable state and
recomputes every aggregate from the `rebuildup.conversations`
normalized index on each call. `quota` caches successful provider
readings briefly under the plugin state dir (quota numbers only —
never credentials, ADR-0014). It never reads PTY text, never scans
provider transcripts itself, and never fabricates usage numbers.

## Data source (ADR-0013)

`rebuildup.usage` consumes `rebuildup.conversations` **only through its
public read-only CLI contract** — the `usage` event-paging command plus
the `capability` provider matrix — never its state files. The
conversations plugin root resolves in this order:

1. `--conversations-root DIR` / `HERDR_USAGE_CONVERSATIONS_ROOT` /
   `conversationsRoot` in `config.json` — explicit override.
2. Sibling `../conversations` next to this plugin's root (covers the
   repo layout and managed `plugins/<name>` installs).
3. `herdr plugin list --json` discovery (`HERDR_BIN_PATH` or `herdr`
   on `PATH`).

State/config dirs for the conversations child are pinned explicitly
(`HERDR_PLUGIN_STATE_DIR`/`_CONFIG_DIR` are set to the *conversations*
plugin dirs), so ambient plugin env can never redirect its state.
Overridable via `--conversations-state-dir` /
`--conversations-config-dir`, `HERDR_USAGE_CONVERSATIONS_STATE_DIR` /
`_CONFIG_DIR`, or `config.json` keys `conversationsStateDir` /
`conversationsConfigDir`.

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.usage"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.usage/v1"` and `sources` reports
   `conversations-index` `available`.

## Invocation

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts usage [--pane PANE] [--session-id ID] [--provider ID] \
  [--from ISO] [--to ISO] [--session NAME] [--socket PATH] [--timeout MS] \
  [--offline] [--conversations-root DIR] [--conversations-state-dir DIR]
bun run src/cli.ts quota [--provider ID] [--refresh] [--timeout MS]
```

- All commands print exactly one JSON document on stdout. Handled
  errors print `{contract, ok:false, error:{code,message,kind?}}` on
  **stderr** and exit 1; usage errors exit 2.
- `--session`/`--socket`/`--timeout` select the herdr session/socket
  for live-binding checks inside the conversations read (best-effort;
  unreachable degrades to `live: null`, never an error). `--offline`
  skips live checks entirely.
- `--pane`/`--session-id`/`--provider` are forwarded to the
  conversations `usage` selector (`--session-id` takes a record key
  `<provider>:<id>` or bare session id — same semantics as
  `conversations`).
- `--from`/`--to` are ISO-8601 timestamps compared as instants,
  inclusive on both ends, against each event's provider timestamp.
  `--from` after `--to`, or an unparseable bound, is a usage error.

## `capability`

```json
{
  "contract": "herdr-plugins.usage/v1",
  "command": "capability",
  "plugin": "rebuildup.usage",
  "version": "0.5.0",
  "read_only": true,
  "mutation_commands": [],
  "commands": ["capability", "usage"],
  "sources": [
    {
      "id": "conversations-index",
      "kind": "normalized-events",
      "contract": "herdr-plugins.conversations/v1",
      "status": "available",
      "plugin_root": "/abs/…/plugins/conversations",
      "resolved_via": "sibling",
      "freshness": "as of the last `rebuildup.conversations index`/`refresh` run…"
    },
    {
      "id": "subscription-quota-api",
      "kind": "provider-quota",
      "status": "available",
      "credential_boundary": "docs/adr/0014-usage-quota-credential-boundary.md",
      "providers": {
        "claude": "implemented …",
        "codex": "implemented …",
        "opencode": "unsupported …"
      },
      "freshness": "short-term cache (default 300s) …"
    },
    { "id": "provider-cli-billing", "kind": "cli-billing-endpoint", "status": "unsupported", "planned_in": "#92" }
  ],
  "aggregation": { "dimensions": ["provider","model","host","project","session","pane"], "…": "…" },
  "generated_at": "…"
}
```

`sources` is the authoritative data-source matrix and extends
additively: `conversations-index` reports `available` (with
`plugin_root`/`resolved_via`) or `unavailable` (with `detail`) — the
command never fails on source resolution. `subscription-quota-api`
reports `available` with a per-provider implementation matrix and a
pointer to the credential-boundary ADR; `provider-cli-billing` remains
an explicit `unsupported` placeholder (`planned_in` #92) so consumers
can distinguish "not implemented" from "no data".

## `usage`

Pages the entire conversations `usage` export (opaque per-session byte
cursors, 500 events/page), deduplicates, applies the optional time
window, and aggregates.

```json
{
  "contract": "herdr-plugins.usage/v1",
  "command": "usage",
  "window": { "from": "2026-01-01T00:00:00Z", "to": null },
  "filters": { "pane_id": null, "session_id": null, "provider": null },
  "totals": {
    "events": 3,
    "sessions_with_usage": 2,
    "input_tokens": 130,
    "output_tokens": 22,
    "cache_read_input_tokens": 43,
    "cache_creation_input_tokens": 8,
    "thinking_tokens": 6,
    "thinking_token_events": 2,
    "total_tokens": 203,
    "provider_reported_cost_usd": 0.0123,
    "provider_reported_cost_events": 1,
    "excluded_untimestamped_events": 0,
    "duplicate_events_skipped": 0,
    "events_without_event_id": 0
  },
  "breakdowns": {
    "by_provider":  [{ "key": "claude", "events": 2, "input_tokens": 30, "…": "…" }],
    "by_model":     [{ "key": "claude-test-1", "…": "…" }],
    "by_host":      [{ "key": "macbook", "…": "…" }],
    "by_project":   [{ "key": "/repo/proj", "…": "…" }],
    "by_session":   [{ "key": "claude:<id>", "…": "…" }],
    "by_pane":      [{ "key": "w1:p1", "…": "…" }]
  },
  "coverage": {
    "sessions_total": 2,
    "sessions_ok": 2,
    "sessions_with_issues": 0,
    "sessions_stale": 0,
    "sessions_events_missing": 0,
    "providers": [
      { "provider": "claude", "provider_status": "supported", "sessions": 1, "sessions_ok": 1, "sessions_with_issues": 0, "usage_events": 1 }
    ]
  },
  "sessions": [ { "…": "contributing session registry entries" } ],
  "source": {
    "plugin": "rebuildup.conversations",
    "contract": "herdr-plugins.conversations/v1",
    "plugin_root": "/abs/…/plugins/conversations",
    "resolved_via": "sibling",
    "pages": 1,
    "complete": true
  },
  "warnings": [],
  "generated_at": "…"
}
```

### Totals semantics

- `events` — usage-carrying events summed (after dedup + window).
- `input_tokens` / `output_tokens` / `cache_read_input_tokens` /
  `cache_creation_input_tokens` — sums of the provider-reported fields
  carried on `assistant_message` events by the conversations contract.
- `total_tokens` — sum of the four canonical buckets. `thinking_tokens`
  is **not** added on top: it is a provider detail of output/reasoning
  accounting, reported separately.
- `thinking_tokens` / `provider_reported_cost_usd` — `null` when **no**
  contributing event reported them; never zero-fabricated.
  `provider_reported_cost_usd` sums the provider-reported `cost_usd`
  field only — it is **not** a billing amount and not an estimated API
  price (that distinction is T4/#93 scope).
- `excluded_untimestamped_events` — events dropped by `--from`/`--to`
  because the provider timestamp was absent/unparseable. Without a
  window they are included and this stays 0.
- `duplicate_events_skipped` — events dropped because the same
  `(session_key, event_id)` was already counted (index rewrites can
  replay events mid-export).
- `events_without_event_id` — events lacking a usable `event_id`;
  included in totals but cannot be deduplicated (contract violation
  upstream — surfaced, not hidden).

### Breakdowns

`breakdowns` has six dimensions, each an array of entries sorted by
`total_tokens` desc:

| key | source |
| --- | --- |
| `by_provider` | session record key prefix (`<provider>:<id>`) |
| `by_model` | event `model`; `null` when unreported |
| `by_host` | `event.identity.host`; `null` when absent |
| `by_project` | session record `cwd` (the pane cwd at index time); `null` when unknown |
| `by_session` | session record key |
| `by_pane` | `event.identity.pane_id` (historical binding at index time); `null` when unbound |

Each entry: `{key, events, input_tokens, output_tokens,
cache_read_input_tokens, cache_creation_input_tokens, thinking_tokens
|null, total_tokens, provider_reported_cost_usd|null}`.

### Coverage — missing is not zero

`coverage` reports registry truth, separate from measured totals:

- `sessions_total` / `sessions_ok` / `sessions_with_issues` — indexed
  sessions and how many have `status != "ok"`, `error != null`, or
  `events_present == false`.
- `sessions_stale` — sessions whose pane binding changed generation
  (`agent_session_changed`); their historical usage still counts (it is
  a fact about the past), flagged here.
- `sessions_events_missing` — normalized event logs absent.
- `providers[]` — per-provider `{provider, provider_status,
  sessions, sessions_ok, sessions_with_issues, usage_events}`;
  `provider_status` comes from the conversations capability matrix
  (`supported`/`unsupported`), so "declared but unsupported" is
  distinguishable from "supported, nothing measured". Providers with
  zero indexed sessions still appear.

`sessions[]` lists only sessions that contributed ≥1 usage event, with
their registry status — a session with no measured usage is visible in
`coverage` but contributes no tokens.

### Warnings

`warnings[]` names degraded-but-successful conditions:
`export_incomplete_page_limit` (export hit the 2M-event safety cap —
totals are partial, `source.complete: false`),
`index_malformed_lines`, `index_duplicate_events_skipped`,
`index_sessions_restarted` (opencode-style event-log rewrites replayed
events — dedup absorbed them), `untimestamped_events_excluded_by_window`,
`duplicate_events_skipped`, `events_without_event_id`.

An entirely empty index returns `totals.events: 0`,
`coverage.sessions_total: 0`, and `hint` suggesting
`rebuildup.conversations index` — zeros here mean "nothing indexed",
not "zero usage measured".

## `quota`

Subscription quota/reset report per provider. Independent of the
conversations index — it does not resolve the conversations plugin and
needs no herdr session at all.

```bash
bun run src/cli.ts quota [--provider ID] [--refresh] [--timeout MS]
```

```json
{
  "contract": "herdr-plugins.usage/v1",
  "command": "quota",
  "cache": { "ttl_seconds": 300 },
  "providers": [
    {
      "provider": "claude",
      "status": "ok",
      "detail": null,
      "plan": "max",
      "windows": [
        {
          "id": "five_hour",
          "label": "Session (5-hour)",
          "kind": "session",
          "used_percent": 42.5,
          "resets_at": "2026-01-01T05:00:00.000Z",
          "window_duration_mins": 300
        }
      ],
      "checked_at": "2026-01-01T00:30:00.000Z",
      "fetched_at": "2026-01-01T00:31:00.000Z",
      "stale": false,
      "stale_reason": null,
      "reset_credits_available": null,
      "cache": { "hit": false, "age_seconds": null, "ttl_seconds": 300 }
    }
  ],
  "generated_at": "…"
}
```

### Provider statuses

`status` is per provider and is **data, not an error** — `quota` exits
0 whenever it can emit the envelope:

| status | meaning |
| --- | --- |
| `ok` | fresh (`cache.hit:false`) or cached (`cache.hit:true`) provider reading; `stale:true` marks a cached reading served because the endpoint failed |
| `unsupported` | no quota artifact exists (opencode API-key store, codex `auth_mode:"apikey"`, unknown provider) — `detail` records why |
| `no_credential` | the provider credential store has no usable login |
| `credential_expired` | a token exists but is past expiry; refresh is out of scope (ADR-0014) |
| `request_failed` | endpoint unreachable/HTTP error/unparseable and no cache to serve — `detail` carries `HTTP <status>` or a transport summary only |

- `windows[]` — provider-reported quota windows: `id`, `label`,
  `kind` (`session`/`weekly`/`monthly`/`other`), `used_percent`
  (0-100), `resets_at` (ISO instant or `null`), `window_duration_mins`.
  Non-`ok` statuses always carry `windows: []` — missing is never a
  fabricated zero.
- `checked_at` — when the provider endpoint last answered; `null`
  unless `status` is `ok`.
- `plan` — provider plan label (Claude `subscriptionType`, Codex plan
  name); `null` when unreported.
- `reset_credits_available` — banked Codex reset-credit count when the
  credits endpoint answers; `null` otherwise (never fabricated).
- `stale`/`stale_reason` — `true` only when serving a cached reading
  older than the fresh TTL because the endpoint failed; the reason is
  recorded, the data is labeled.

### Quota freshness & rate limiting

Successful readings are cached at `<HERDR_PLUGIN_STATE_DIR>/quota-cache/
<provider>.json` for `ttl_seconds` (default 300, config
`quotaCacheTtlSeconds`). `--refresh` bypasses the fresh-cache read.
The cache stores quota numbers only — never credential material
(ADR-0014). Requests time out after `--timeout` ms (default 10s);
endpoint overrides exist only as test/proxy hooks:

- env: `HERDR_USAGE_QUOTA_CLAUDE_URL`, `HERDR_USAGE_QUOTA_CODEX_USAGE_URL`,
  `HERDR_USAGE_QUOTA_CODEX_CREDITS_URL`
- config.json: `quotaEndpoints: {claude, codexUsage, codexCredits}`

When `codexUsage` is overridden without `codexCredits`, the credits
call is skipped (a mock must opt in explicitly).

### Credential boundary (ADR-0014)

`quota` reads provider credential artifacts **in memory only** to
authenticate the provider's own read-only quota endpoints: Claude
`$CLAUDE_CONFIG_DIR/.credentials.json` (macOS Keychain
`Claude Code-credentials` fallback only when `CLAUDE_CONFIG_DIR` is
unset) and Codex `$CODEX_HOME/auth.json`
(ChatGPT auth only). Tokens are never logged, persisted, cached,
emitted, or passed to subprocesses; expired tokens report
`credential_expired` rather than triggering a refresh. Full rules:
`docs/adr/0014-usage-quota-credential-boundary.md`.

## Errors

`kind` values: `conversations_unavailable` (plugin root not resolvable
or override invalid), `conversations_error` (the conversations CLI
exited non-zero — stderr detail carried in `message`), plus usage
errors (exit 2) for bad `--from`/`--to`. A missing conversations
**index** is not an error — it is the honest empty result above.

## Versioning

`herdr-plugins.usage/v1` is **stable** as of plugin v0.5.0: command
surface (`capability`/`usage`/`quota`), totals/breakdown/coverage and
quota report shapes, and error `kind` taxonomy are the v1 contract.
Additive fields may appear anywhere; clients must ignore unknown
fields. `sources`, `breakdowns` dimensions, `coverage.providers`,
quota `windows`, and provider `status` values extend additively.

A breaking change — removing/renaming a command or field, changing an
error `kind`'s meaning, altering dedup/window semantics — bumps to
`herdr-plugins.usage/v2`, shipped alongside v1 for at least one
release; v1 is then frozen, not deleted.
