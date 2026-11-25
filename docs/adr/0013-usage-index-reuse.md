# ADR-0013: Usage aggregation consumes the conversations read contract

Status: Accepted (release-0-5-0 candidate, Issue #90 / parent #28 T1)

## Context

Issue #90 adds `rebuildup.usage`: token-usage aggregation over
provider-reported transcript data. #28's decomposition named three
candidate reuse mechanisms for the #5 normalized index:

- **(a)** extract the transcript-normalization library into
  `packages/` shared by both plugins;
- **(b)** `rebuildup.conversations` provides a usage-oriented
  read-only export of raw events;
- **(c)** `rebuildup.usage` scans provider transcripts independently.

Repo convention disfavors cross-plugin *state* dependencies: plugin
state lives under each plugin's own `HERDR_PLUGIN_*_DIR`, and durable
state must never be read across plugin boundaries as an integration
mechanism. `agent_session.value` is a session id, not a path, so any
transcript-level approach must re-solve the
id+cwd+known-directory resolution that ADR-0012 already proved.

## Decision

**Option (b): consume `herdr-plugins.conversations/v1` through its
public CLI.** `rebuildup.usage` pages `conversations usage` (the
read surface #88 built explicitly for #28) to exhaustion and reads
`conversations capability` for the provider support matrix. It never
opens conversations state files, never re-scans transcripts, and
keeps no durable state of its own — totals are recomputed per call.

Concretely:

- The conversations child process is spawned with
  `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` pinned to the
  *conversations* plugin dirs (resolved via override → sibling →
  `herdr plugin list --json`), so the ambient `HERDR_PLUGIN_*` env of
  the usage plugin cannot redirect its state.
- Dedup is `(session_key, event_id)` inside the aggregator, on top of
  the index's own per-page dedup — index rewrites (opencode rescan)
  can replay events across page boundaries and are absorbed, not
  hidden (`index_sessions_restarted` warning).
- Missing data stays structured: unsupported providers appear in
  `coverage.providers` with `provider_status`; sessions with
  `status != ok` / missing event logs are counted in
  `sessions_with_issues` / `sessions_events_missing`; empty index →
  `totals.events: 0` + hint, never a fabricated nonzero.
- `sources[]` in `capability` is the extension seam: T2 (#91) adds
  credential-bound quota sources, T3 (#92) HTTP/CLI billing sources —
  each a new `sources[]` entry, no contract break.

## Consequences

- A conversations index refresh is the freshness boundary: usage
  totals are "as of last `index`/`refresh`", disclosed in
  `sources[].freshness` and the spec.
- Export cost is O(usage events) subprocess pages per call; the
  2M-event safety cap reports `export_incomplete_page_limit` rather
  than silently truncating. If real usage outgrows this, a
  conversations-side streaming export command can be added
  additively to v1 without changing this contract.
- (a) remains available later if a shared *type-only* package becomes
  warranted by a second consumer; today a package would still leave
  the state-location problem unsolved, so it was rejected.
- (c) is rejected permanently for token usage: it would fork the
  cursor/guard machinery and could disagree with the index.
