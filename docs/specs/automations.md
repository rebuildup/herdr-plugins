# Spec: Automations plugin (`rebuildup.automations`)

Scheduled and event-triggered agent runs for herdr — the
standalone-plugin port of T3 Code's scheduled tasks / webhook
automations, adapted to herdr's no-daemon constraint.

Parent: #32 (Automations) / #22. Decomposition: #137 (T1, this doc +
ADR-0022/0023 + contract skeleton), #144 (T2 registry — implemented),
#145 (T3 firing/delivery), #146 (T4 event triggers), #147 (T5 webhook).

## Sources (upstream inventory — confirmed at t3code @ `9cc4018c`)

Verified against the pinned checkout during #137; the #32 research
comment's inventory is confirmed accurate:

- `packages/contracts/src/scheduledTask.ts` — schedule union
  (`interval`/`fixed_time`/`once`/`webhook`),
  `MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000`, `TimeOfDay` HH:MM,
  `weekdays` 0=Sunday..6=Saturday, `once.runAt` ISO-with-offset,
  `ScheduledTaskThreadMode = new_thread | continue | fresh_session`,
  task fields (`enabled`, `nextRunAt`, `lastRunStatus`, `runCount`,
  `webhook` endpoint), run statuses
  (`never|running|succeeded|failed`), webhook signature
  (header/encoding hex|base64/prefix, HMAC-SHA256), filters ≤ 16,
  dedupe (replayKey 7-day, coalesceKey + window 10–3600 s default
  120 s), `maxDeliveryAgeMinutes` ≤ 24 h.
- `apps/server/src/scheduledTasks/` — `Schedule.ts`
  (`nextScheduledRunAt`: interval advances elapsed time incl. DST;
  fixed_time scans ≤ 7 days for weekday match; once must be future),
  `ScheduledTaskService.ts` (event-sourced runs, thread binding on
  first run), `webhook{Route,Filter,Template,Verification,Dedupe}.ts`,
  `RelayDeliveryProof.ts` (offline hold lives relay-side).
- MCP surface (`apps/server/src/mcp/toolkits/orchestrator/tools.ts`):
  `schedule_task` (create/update), `list_scheduled_tasks`,
  `delete_scheduled_task`, `run_scheduled_task_now`; webhook URLs
  returned only to run-authorized callers; read-only clients
  rejected.
- `docs/user/project-settings.md` — Scheduled tasks / Webhook
  automations sections (the issue's `docs/user/workflows.md`
  reference does not exist at the pinned revision).

## Model

### Task

`task_id`, `name`, `prompt`, `schedule`, `enabled`, `misfire`
(`skip`|`run_once`), `destination` (`pane` prompt-target or `launch`
surface+agent), `created_by`, timestamps, derived `next_run_at`,
`last_run_at`, `run_count`, `driver` coverage state. T2 adds the
enabled-window bookkeeping `enabled_at`/`disabled_at` (occurrences are
owed only while enabled; pause materializes owed missed runs before
the window closes) and `schedule_anchor_at` (interval grid origin —
`created_at`, advanced by #145 fires, reset on schedule `update`).
Full schema: `docs/contracts/automations-v1.md`.

### Run

`run_id`, `task_id`, `trigger` (`schedule|manual|event|webhook`),
`scheduled_for` (occurrence instant; `null` for manual), `status`
lifecycle `scheduled → running → success|failed|skipped|cancelled|
missed`, timestamps, `destination_snapshot`, observed-only `result`,
`error`. Idempotency key `task_id + scheduled_for`.

### Schedules (v1)

| Type | v1 | Notes |
| --- | --- | --- |
| `interval` `every_ms ≥ 60000` | in | occurrences anchored at last fired; ≤60 s driver jitter |
| `fixed_time` `time_of_day` + `weekdays?` + `time_zone?` | in | zone defaults to host-local at evaluation, recorded on run |
| `once` `run_at` ISO+offset | in | past `run_at` at create → `invalid_schedule` |
| `webhook` | reserved | rejected `unsupported_schedule` until #147 |
| `event` | reserved | rejected until #146 (`[[events]]` hook path) |

### Firing architecture (ADR-0022)

The plugin holds no clock. Drivers invoke `tick` (scan due
occurrences → apply `misfire` → `fire` each) or `fire` directly:

- `schedule install|uninstall|status` — OS scheduler adapter,
  ONE entry per plugin → `automations tick` (launchd /
  systemd --user timer `Persistent=true` / schtasks `/sc minute`).
- `watch` — opt-in foreground process, sleep-until-next-due.
- `fire <task-id> --scheduled-for <ts>` — manual/idempotent
  single-occurrence entrypoint.

### Delivery (ADR-0023)

- `destination.kind = "pane"` → `agent.prompt` to the pane's live
  agent (T3 `continue` analogue).
- `destination.kind = "launch"` → `agent.start` fresh agent in a
  chosen surface (T3 `new_thread`/`fresh_session` analogue); optional
  `handoff_record_id` resolves context via `rebuildup.handoff`
  (invoke, never reimplement; no auto-handoff — ADR-0021 §6).
- Prompts carry an `[automations]` provenance prefix.
- Run status observes API/agent-status results only; no PTY-text
  success fabrication.

## v1 scope confirmation

**In**: interval/fixed_time/once schedules; task CRUD +
pause/resume (`set-enabled`)/run-now/delete/runs; idempotent fire,
misfire policy, missed-run lazy resolution; OS-scheduler + watch
drivers; pane/launch destinations; CLI surface.

**T2 registry semantics (#144, implemented)**:

- Occurrence math is deterministic and clock-injected
  (`plugins/automations/src/model.ts`): interval occurrences are
  `schedule_anchor_at + k·every_ms`; `fixed_time` resolves
  `HH:MM`+`weekdays`+IANA `time_zone` (host-local when absent) via
  `Intl`; `once` is a single ISO+offset instant that must be future
  at write time.
- Owed window = `[enabled_at, disabled_at ?? now]`; occurrences
  inside disabled periods are never owed. An occurrence becomes
  `missed` only after `MISSED_GRACE_MS` = 60 s — the documented
  driver jitter bound, so a just-passed occurrence a `tick` can
  still fire is not pre-judged.
- Reads (`list`/`get`/`runs`) derive missed occurrences lazily
  (`run_id:null`, `derived:true`, capped at 200/task with
  `missed_truncated`); `reconcile` and `set-enabled false`
  materialize them into real `missed` run records (idempotent).
- `run-now` records `trigger:"manual"`, `scheduled_for:null`,
  `status:"scheduled"` — execution is the #145 run path; the record
  honestly stays `scheduled` until then.
- `delete` removes the task and all its run records; state is
  session-namespaced (`hostname + canonical socket path`) under
  `HERDR_PLUGIN_STATE_DIR/state.json` with the standard
  single-writer lock + atomic rename.

**Reserved (schema present, rejected until owning ticket)**:
`webhook` (#147 — opt-in `serve` vs upstream gap, HMAC/filters/
dedupe/coalesce decided there), `event` (#146 — `[[events]]` hook
triggers with filter/debounce/cooldown).

**Out of v1**: multi-stage durable workflows and question/approval
orchestration (T3 orchestrator is a separate system; herdr composes
via explicit handoff `delegate`/`merge-back` invocations — revisit
only with a demonstrated unmet requirement); Issue/PR forge events
(requires polling clock or webhook inbound — both blocked/deferred);
MCP `schedule_task` surface (CLI-only v1; #30 decides exposure,
soft non-blocking dependency); automatic retry; store-and-forward
offline queue.

## Honesty invariants

- No fabricated runs: transport failure at fire → error exit, no run
  record; occurrence resolves `missed` at next read.
- Driver coverage is reported (`driver.state` on tasks,
  `schedule status`): `none`/`install_failed`/`stale` are visible,
  never implied-armed. Until #145 lands, the registry reports
  `driver.state = "none"` honestly.
- `missed` is derived deterministically from schedule + run records +
  the enabled window; reads and writes agree (ADR-0002 path 1).
  Derived entries carry `run_id:null`/`derived:true`; materialized
  entries are real `missed` records — never `success`.
- Unsupported platform schedule expressions → `unsupported_schedule`
  per task in `schedule status`, not silent skipping.

## State, identity, locking

`HERDR_PLUGIN_STATE_DIR/state.json` + single-writer file lock +
atomic rename (ADR-0001). Session-namespaced like inbox (hostname +
socket path). Config under `HERDR_PLUGIN_CONFIG_DIR`. Nothing inside
the installed source tree.

## #60 / #30 boundaries (ADR-0023)

- project-scripts triggers run **scripts** in dedicated panes
  (ADR-0010); automations run **agent prompts/launches**. Shared
  trigger-source gap (structured worktree/settle events) is one
  upstream candidate Issue serving both.
- MCP: CLI-only v1; `herdr-plugins.automations/v1` is the contract a
  future #30 `schedule_task` tool would consume.

## Upstream gap candidates (filing deferred to #147)

1. herdr timer/scheduled plugin hook (retires OS/watch drivers).
2. Inbound webhook HTTP path / tunnel equivalent (blocks `webhook`).
3. Structured worktree/settle events (shared with #60, #146).

## Non-goals

- Reimplementing herdr agent lifecycle, provider runtimes, Agent
  Router, or orchestration (AGENTS §1/§4).
- PTY-text parsing for run outcomes.
- Resident processes of any kind beyond user-started `watch`.
