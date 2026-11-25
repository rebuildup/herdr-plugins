# ADR-0004: Pane metadata projection; Agent View deferred

## Status

Accepted (2026-01).

## Context

The spec asks for "appropriate projection to herdr metadata and Agent View".
herdr offers two surfaces: per-pane metadata tokens (`pane.report_metadata`)
and a single global Agent View slot (`agent.view.set`/`clear`).

## Decision

- Project organize state onto pane metadata tokens `inbox_state` /
  `inbox_snoozed_until`, namespaced and merge-safe.
- Do NOT call `agent.view.set` in v0.1: it is a single global slot shared by
  all plugins; claiming it would evict other plugins' views and conflict
  with herdr-t3's own Agent View usage. A dedicated inbox surface belongs to
  a client (herdr-t3) consuming the v1 contract, or to a future herdr
  upstream feature for per-plugin view slots.

## Consequences

- TUI users see organize state via pane metadata (title chips etc. depend on
  herdr's rendering support for token namespaces).
- No cross-plugin view conflicts; inbox remains usable purely through CLI +
  metadata.

## Revisit when

- herdr adds per-plugin/namespaced view slots, or
- herdr-t3 demonstrates a concrete need for a plugin-owned Agent View.
