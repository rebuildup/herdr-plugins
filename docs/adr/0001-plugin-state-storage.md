# ADR-0001: Plugin state storage and concurrency

## Status

Accepted (2026-01).

## Context

herdr plugin v1 provides `HERDR_PLUGIN_CONFIG_DIR` / `HERDR_PLUGIN_STATE_DIR`
but no managed storage API. Multiple CLI invocations and event hooks can run
concurrently, and herdr itself offers no plugin state primitive.

## Decision

- Durable organize state: one JSON document `state.json` under
  `HERDR_PLUGIN_STATE_DIR` (external clients resolve the same path via
  `pluginDirs()` in `@herdr-plugins/client`).
- Config: `config.json` under `HERDR_PLUGIN_CONFIG_DIR`.
- Concurrency: exclusive `state.json.lock` (`O_EXCL` create, 30s stale
  threshold, 10s acquire timeout) + tmp-file + atomic rename for every
  read-modify-write.
- Reads resolve expirations deterministically at read time; writes only
  persist already-resolved mutations.

## Consequences

- No external dependencies; works offline of any daemon.
- Lock is advisory but sufficient: all writers go through `updateState`.
- State file format is internal — external clients use the v1 JSON contract
  (`docs/contracts/inbox-v1.md`), never the file directly.

## Alternatives considered

- SQLite: heavier, still needs the same lock for multi-process writers;
  unjustified for a few hundred entries.
- herdr pane metadata as state store: metadata tokens are projections, not
  durable per-plugin storage; insufficient for snooze deadlines.
