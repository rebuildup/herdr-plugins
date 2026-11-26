# ADR-0022: Automations firing mechanism — external clocks over an idempotent `tick`/`fire`

Status: Accepted (release-0-7-0 candidate, Issue #137 / parent #32 T1)

## Context

`rebuildup.automations` (contract `herdr-plugins.automations/v1`,
draft) schedules agent prompts (`interval` ≥ 60 s, `fixed_time`,
`once`; `webhook` and `event` triggers are reserved for #147/#146).
Upstream T3 Code fires scheduled tasks from its always-on server
(`ScheduledTaskService` + SQLite, t3code @ `9cc4018c`). herdr plugins
have no runtime timer/callback registration (`PLUGIN_HOOK_EVENT_KINDS`
is `pane.agent_status_changed` / `pane.closed` only), so the plugin
itself cannot own a clock.

Constraints (AGENTS §4, ADR-0002, ADR-0005):

- No resident daemon, no HTTP server, no high-frequency polling.
  The single sanctioned exception is ADR-0005's bounded one-shot
  `_wake` sleeper for snooze deadlines.
- Plugin install/update/disable must stay independent; a plugin
  failure must not affect herdr.
- Missed runs must be reported honestly — "it ran" is never
  fabricated, and "it did not run" is never hidden.
- Durable state only under `HERDR_PLUGIN_STATE_DIR`; single-writer
  lock + atomic rename (ADR-0001).

## Decision

**The plugin never keeps time. Every firing path is an external clock
that calls the same idempotent entrypoints:**

1. **`automations tick`** — the clock-holder entrypoint. Scans
   enabled tasks, computes due occurrences deterministically from
   each task's schedule and its last-fired marker, applies the task's
   `misfire` policy (`skip` | `run_once`), and fires each occurrence
   through the `fire` path. This is what every driver invokes.
2. **`automations watch`** — opt-in foreground process (same shape as
   `rebuildup.inbox watch`): sleeps on a single timer until the next
   due occurrence across all tasks, then runs the `tick` logic. Not
   started automatically; user-managed lifetime.
3. **`automations schedule install | uninstall | status`** — opt-in OS
   scheduler adapter. Installs **one** scheduler entry per plugin
   (not per task) that invokes `automations tick`:
   - macOS: `launchd` agent (`StartInterval` 60 s).
   - Linux: `systemd --user` timer (`OnUnitActiveSec=1min`,
     `Persistent=true` for catch-up).
   - Windows: `schtasks` (`/sc minute /mo 1`).
   The 60 s floor matches `MIN_SCHEDULED_TASK_INTERVAL_MS` = 60 000,
   so a uniform 1-minute tick expresses every v1 schedule. Interval
   tasks fire on tick boundaries (occurrence = last fired +
   `every_ms`), so effective jitter is ≤ 60 s — documented, not
   hidden.
4. **`automations fire <task-id> --scheduled-for <ts>`** — low-level
   idempotent single-occurrence fire, used by `tick` and available
   for manual/scheduled invocation.

`create`/`set-enabled` do **not** silently mutate OS scheduler state.
Arming is explicit: `schedule install` reconciles entries against
current enabled tasks (installs missing, removes stale for
disabled/deleted tasks) and is the documented "turn it on" step;
`schedule status` reports `installed | missing | stale | error`
honestly, including orphaned entries left by an uninstall.

## Options compared

| Option | Verdict | Reason |
| --- | --- | --- |
| (a) OS native scheduler → `tick` | **Adopted (primary)** | Only daemon-free path to unattended firing across herdr restarts and reboots. Uniform one-entry-per-plugin design avoids per-platform schedule-expression gaps (schtasks cannot express arbitrary `every_ms`). OS catch-up (`Persistent=`, launchd, schtasks "run ASAP") plus plugin-side deterministic missed-run detection gives honest misfire handling. |
| (b) opt-in `watch` process | **Adopted (alternative)** | Zero install side-effects, precedent-consistent (inbox `watch`, ADR-0002 path 3). Covers users who decline OS scheduler entries and platforms where the adapter fails. Honest limitation: fires only while the user keeps it running — `schedule status`/task `driver` reporting makes that visible instead of silently dead. |
| (c) bounded `_wake` multiplex | Rejected | One sleeper per task does not scale; interval tasks need self-respawning chains that die silently on reboot/crash; ADR-0005 sanctioned `_wake` for a single user-driven deadline, not a scheduler. `[[startup]]` reconcile may *detect* missed occurrences but cannot resurrect a dead chain. |
| (d) herdr upstream timer/scheduled hook | Deferred → upstream gap | Not in plugin API v1. Recorded as upstream Issue candidate alongside the webhook-inbound and structured-event gaps (see ADR-0023). If herdr ships timer hooks, `tick` remains the fallback driver — no contract change. |

## Missed-run honesty

- Occurrences are derived, not trusted: `scheduled_for` is computed
  from the schedule, never taken from the caller's clock alone.
- `tick`/`watch` firing while herdr is down fails honestly (socket
  error → non-zero exit, no fabricated run record). The occurrence
  stays unrecorded; the next read resolves it as `missed` (or fires
  once under `misfire: run_once`).
- OS scheduler entries that outlive the plugin (uninstall, moved
  checkout) invoke a missing command and fail harmlessly;
  `schedule status` surfaces the drift.

## Consequences

- v1 ships a real unattended path (`schedule install`) without any
  resident plugin process; herdr restart/teardown never owns plugin
  processes.
- `tick` is safe to invoke concurrently/repeatedly: run records are
  keyed by `task_id + scheduled_for` under the single-writer lock
  (contract §Idempotency), so duplicate OS/watch/manual invocations
  collapse to one run.
- T3 (#145) implements `tick`/`fire`/`watch`/`schedule` adapters;
  platform adapter code is confined to `plugins/automations` and is
  testable behind a fake scheduler.
- If upstream herdr adds timer hooks (candidate Issue), the ADR-0002
  timeliness ladder gains a first-class rung; `watch`/`schedule`
  remain as user-controlled drivers.

## Alternatives rejected

- **Resident watcher spawned by `[[startup]]`** — daemon constraint
  (ADR-0002); teardown ownership leaks into herdr.
- **Per-task OS entries** — multiplies platform edge cases (interval
  expression, naming, cleanup) for no correctness gain; the uniform
  `tick` already computes occurrences plugin-side where the schedule
  semantics live.
- **`_wake` chain re-arming from `[[startup]]`** — still leaves
  per-task process growth and silent chain death between herdr
  restarts; rejected for the same reasons as (c).

## Addendum (#146, T4): `event` schedules fire via manifest hooks + lazy drain

`event` schedules do not fit the clock model — their "occurrence" is
a herdr lifecycle event, not an instant on a grid. Decision:

- The manifest subscribes all 22 hook-eligible event names
  (`PLUGIN_HOOK_EVENT_KINDS` @ upstream `e8d7d97`; names like
  `pane.output_changed`/`pane.updated`/`layout.updated` are NOT
  hook-eligible and are rejected at schedule validation) to
  `src/hook.ts`, which does NO socket work and NO delivery — the
  checkpoints-hook contract. It appends a bounded pending mark
  (`MAX_PENDING_EVENTS` = 500, oldest-dropped counted) to the session
  registry.
- Marks drain lazily inside `tick`/`watch` (`prepareEventTick`),
  reusing the same run path, idempotency key (`task_id +
  scheduled_for` = burst anchor), and preflight/delivery semantics as
  clock fires. No daemon, no `events.subscribe` watch driver, no
  store-and-forward: an event herdr never delivered never exists.
- `debounce_ms`/`cooldown_ms`/`max_fires` are plugin-side burst and
  suppression semantics; declined bursts are recorded as honest
  `skipped` runs, never silently dropped.
- `pane.agent_status_changed` additionally folds the OBSERVED
  `agent_status` into the latest delivered run on that pane
  (`result.agent_status`/`agent_status_at`) — observation only, never
  a fabricated completion (AGENTS §4).

Rejected for #146: an `events.subscribe` long-lived watch driver
(violates the no-resident-process constraint and duplicates `watch`),
and treating hook receipt time as a trusted clock (marks carry
`received_at` but delivery stays lazy and idempotent).
