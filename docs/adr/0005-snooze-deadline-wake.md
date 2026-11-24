# ADR-0005: Deadline-driven one-shot wake for snooze expiry

## Status

Accepted (2026-11). Supersedes the "no detached process" reading of
ADR-0002 for the snooze-deadline case only.

## Context

ADR-0002 established three timeliness paths: read-side lazy resolution,
the `pane.agent_status_changed` event hook, and the opt-in `watch`
command. The gap: a snoozed pane whose agent produces no status changes
never triggers any of them, so its metadata tokens (`inbox_state=snoozed`)
stay stale in the TUI until the user manually runs `watch`/`reconcile` or
reads via the CLI. The v0.1.0 final acceptance requires prompt, automatic
restore at the snooze deadline without a resident daemon or high-frequency
polling.

## Decision

`snooze` detaches a **one-shot `_wake` process** after the state mutation
succeeds:

- Lifetime is bounded by the remaining snooze duration; it sleeps on a
  single timer (no polling loop) and exits after one `reconcile` pass.
- Reconcile is idempotent: early/duplicate wakes are harmless no-ops, and
  sleep overshoot (system suspend, timer drift) is corrected because
  expiry is evaluated against the stored `until` at reconcile time.
- Explicit `--socket`/`--session` flags are forwarded to the child;
  `HERDR_SOCKET_PATH`/`HERDR_SESSION` propagate via the environment.
- Spawn failure degrades to a `warnings[]` entry — the organize mutation
  itself already succeeded and lazy resolution still keeps the contract
  correct.
- The command is internal (`_wake`, hidden from `capability`/usage).

This does not reintroduce a daemon: each process is finite, event-like,
and failure-isolated. herdr plugin teardown does not own it; worst case it
exits silently and the next read/startup reconcile repairs metadata.

## Consequences

- Snooze expiry now materializes in pane metadata promptly on the herdr
  host without user action, on macOS/Linux/Windows (spawn uses
  `child_process.spawn` `detached` + `unref`, `windowsHide`).
- Process count grows with concurrent snoozes (one sleeper each); volume
  is user-driven and small. No cap was deemed necessary for v0.1.0.
- ADR-0002's event-hook and lazy-resolution paths remain the primary
  mechanisms; `_wake` only covers the deadline case they cannot see.

## Alternatives considered

- Resident watcher per plugin: rejected (daemon constraint, teardown
  ownership).
- OS schedulers (`at`, launchd, systemd timers, schtasks): platform
  fragmentation and installation side effects far outweigh a bounded
  sleep.
- Upstream herdr timer hooks: not available in plugin API v1; recorded as
  a future upstream ask alongside Issues #8/#9.
