# ADR-0002: No daemon, hooks + lazy resolution for timeliness

## Status

Accepted (2026-01).

## Context

Snooze deadlines and generation advances need timely materialization, but
the project constraint for the initial stage forbids resident daemons, HTTP
servers, and high-frequency polling. herdr plugin v1 has no runtime action
registration, so plugins cannot register callbacks inside herdr.

## Decision

- Timeliness comes from three paths, in increasing cost order:
  1. Read-side resolution: every command resolves expirations/generation
     changes deterministically, so stale state is never *reported*.
  2. Event hook: `pane.agent_status_changed` triggers reconcile for the
     affected pane (herdr invokes the hook command; no polling).
  3. Opt-in `watch` command: subscription + interval reconcile for users who
     want proactive metadata refresh; not started automatically.
- Metadata token freshness may lag between events; the JSON contract is
  always correct because resolution happens at read time.

## Consequences

- Zero resident processes by default; plugin failure cannot affect herdr.
- Expired snoozes are invisible to contract clients immediately (resolved at
  read), even though the stored mark lingers until the next write.
- If a future feature needs sub-second deadline precision or push
  notifications, that becomes an ADR-level revisit (e.g. herdr upstream
  timer hooks).

## Alternatives considered

- Startup hook spawning a detached watcher: violates the no-daemon
  constraint and makes plugin teardown herdr's problem.
- `pane.output_changed` hooks: not in `PLUGIN_HOOK_EVENT_KINDS`; would be
  high-volume anyway.
