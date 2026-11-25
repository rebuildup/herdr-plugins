# Contract: `herdr-plugins.automations/v1`

> **Status: DRAFT.** Defined by Issue #137 (parent #32 T1) alongside
> ADR-0022 (firing mechanism) and ADR-0023 (delivery, idempotency,
> boundaries). #144 (T2) implemented the task-registry surface
> (`create`/`list`/`get`/`update`/`set-enabled`/`delete`/`run-now`/
> `runs`/`reconcile`); #145 (T3) implemented the firing drivers
> (`fire`/`tick`/`watch`/`schedule`), run delivery, and driver
> reporting; #146/#147 flesh out event/webhook triggers.
> External clients MUST depend only on this contract, never on the
> plugin's internal state file format.

Versioned structured interface for the `rebuildup.automations` plugin:
scheduled and event-triggered agent prompts/runs. Upstream reference:
T3 Code scheduled tasks / webhook automations
(`packages/contracts/src/scheduledTask.ts`,
`apps/server/src/scheduledTasks/` @ `9cc4018c`) — adapted to herdr's
no-daemon model (ADR-0002/0005, ADR-0022).

## Invocation and discovery

Installed via `herdr plugin install rebuildup/herdr-plugins/plugins/automations`
(pre-release: `--ref release-0-7-0` or a commit SHA; dev: `herdr plugin
link <repo>/plugins/automations`). Run `<plugin_root>/src/cli.ts` with
`bun run`; `capability` returns the discovery document
(`contract`, `plugin`, `version`, `commands`, `state_file`, …) in the
same shape as `herdr-plugins.inbox/v1`.

Global flags: `--session NAME`, `--socket PATH`, `--timeout MS`.
Success = one JSON document on stdout; failure = one JSON error object
on stderr, exit `2` usage / `1` handled error. Socket/transport
failures are errors — never silently treated as success.

## Concepts

- **Task** — a durable record: what to run (`prompt`), when
  (`schedule`), where (`destination`), and how late runs behave
  (`misfire`).
- **Run** — one execution of a task. Keyed by the idempotency key
  `task_id + scheduled_for` (§Idempotency).
- **Occurrence** — a scheduled instant derived deterministically from
  a task's `schedule`. `scheduled_for` IS the occurrence instant;
  drivers never choose it.
- **Driver** — whatever invokes `tick`/`fire`: the OS scheduler entry
  (`schedule install`), the opt-in `watch` process, or a manual call.
  The plugin holds no clock (ADR-0022).
- **Trigger** — why a run exists: `schedule` | `manual` | `event` |
  `webhook`. Only `schedule` and `manual` are reachable in v1.

## Schedule schema

Discriminated union on `type`. All times are RFC 3339 / ISO 8601 with
offset unless noted.

```jsonc
// interval — every_ms >= 60000 (MIN_SCHEDULED_TASK_INTERVAL_MS, same as upstream)
{ "type": "interval", "every_ms": 3600000 }

// fixed_time — local wall-clock time; time_zone optional IANA name,
// absent = host local zone at evaluation time (recorded on the run).
{ "type": "fixed_time", "time_of_day": "09:30",
  "weekdays": [1, 2, 3, 4, 5],            // optional; 0=Sunday..6=Saturday; absent = daily
  "time_zone": "Asia/Tokyo" }             // optional

// once — single occurrence at run_at (must include offset)
{ "type": "once", "run_at": "2026-03-01T09:00:00+09:00" }

// RESERVED — schema may appear in stored tasks but `create`/`update`
// MUST reject new ones with error code "unsupported_schedule" until
// the owning ticket lands (#146 event, #147 webhook).
{ "type": "webhook", "…": "reserved" }
{ "type": "event",   "…": "reserved (#146)" }
```

`interval` occurrences are anchored at the task's last fired
occurrence (or `created_at` for the first), so effective period is
`every_ms` with firing jitter bounded by the driver's tick interval
(≤ 60 s for OS/watch drivers — documented, ADR-0022).

## Task record

```jsonc
{
  "contract": "herdr-plugins.automations/v1",
  "task_id": "task_01J…",
  "name": "nightly review",
  "prompt": "Review open PRs and summarize.",
  "schedule": { "type": "interval", "every_ms": 86400000 },
  "enabled": true,
  "misfire": "skip",                      // "skip" | "run_once"; default "skip"
  "destination": {
    "kind": "pane",                       // "pane" | "launch"
    "pane_id": "w1:t1:p1"                 // kind=pane: existing agent pane (agent.prompt)
    // kind=launch instead:
    // "surface": { "workspace_id": "…" } | { "new_workspace": true } | { "tab_id": "…" },
    // "agent": "claude", "launch_args": ["--foo"],
    // "via": "direct",                    // "direct" | reserved "handoff-execute" (ADR-0023 §2)
    // "handoff_record_id": "…"            // optional; resolved via rebuildup.handoff contract
  },
  "created_by": "cli|mcp|hook",           // actor string; MCP exposure deferred (#30)
  "created_at": "…", "updated_at": "…",
  // T2 (#144) bookkeeping — occurrences are owed only inside enabled
  // windows: [enabled_at, disabled_at ?? now]. Pause materializes owed
  // missed runs before disabled_at closes the window.
  "enabled_at": "…", "disabled_at": null,
  // Interval grid origin: created_at initially, advanced by #145 fires
  // to the last fired scheduled_for; reset on schedule update.
  "schedule_anchor_at": "…",
  "last_run_at": null, "run_count": 0,
  "next_run_at": "…",                     // derived at read; null when disabled/past
  "driver": {                             // derived at read, honest about coverage
    "state": "os-scheduler|watch|none|install_failed|stale",
    "detail": "…"                         // e.g. stale entry path, watch pid, error
  },
  // T2 (#144) derived read-side fields (never stored):
  "missed_total": 0,                      // owed occurrences past grace with no run record
  "missed_truncated": false               // true when reporting was capped
}
```

## Run record

```jsonc
{
  "contract": "herdr-plugins.automations/v1",
  "run_id": "run_01J…",
  "task_id": "task_01J…",
  "trigger": "schedule",                  // "schedule" | "manual" | "event" | "webhook"
  "scheduled_for": "2026-03-01T09:00:00.000Z",  // null for trigger=manual
  "status": "running",                    // lifecycle below
  "created_at": "…", "started_at": "…", "finished_at": null,
  "destination_snapshot": { "…": "pane/agent identity at fire time" },
  "result": null,                         // { "summary": "…", "agent_status": "done" } — observed values only
  "error": null                           // { "code": "…", "message": "…" }
}
```

### Run status lifecycle

`scheduled` → `running` → terminal: `success` | `failed` | `skipped` |
`cancelled` | `missed`.

- `missed` — derived at read time for occurrences that passed with
  no run record (lazy resolution; may be materialized on write).
  NEVER reported as `success`. Reads emit derived entries with
  `run_id: null` and `derived: true`; `reconcile` (and pause via
  `set-enabled false`) materialize them into real `missed` records.
- An occurrence is owed only inside an enabled window
  (`enabled_at` .. `disabled_at`/now) and only becomes `missed` after
  a **60 s grace** (`MISSED_GRACE_MS`) — the documented driver jitter
  bound (ADR-0022), so a just-passed occurrence a tick can still fire
  is never pre-judged.
- `skipped` — driver declined the occurrence (e.g. `misfire: skip`
  late fire, `max_fires`/cooldown for event triggers).
- `success`/`failed` reflect OBSERVED delivery/execution results
  only (API acceptance, agent status transitions). PTY text is never
  parsed into success (AGENTS §4).

## Commands

| Command | Status | Description |
| --- | --- | --- |
| `capability` | implemented (#137/#144) | Discovery document. |
| `create` | implemented (#144) | `--name --prompt --schedule <json> --destination <json> [--misfire] [--enabled] [--created-by]`; schedule `update` resets `schedule_anchor_at`. |
| `list` / `get` | implemented (#144) | Task views with derived `next_run_at`/`driver`/`missed_total`; `list [--enabled] [--limit]`. |
| `update` | implemented (#144) | Partial update of name/prompt/schedule/destination/misfire; ≥1 field required. |
| `set-enabled` | implemented (#144) | `true` opens a new owed window (`enabled_at=now`); `false` materializes owed missed runs then closes it (`disabled_at=now`). |
| `delete` | implemented (#144) | Removes the task AND its run records; unknown id → `task_not_found`. |
| `run-now` | implemented (#144 registry, #145 execution) | Creates a `trigger:"manual"`, `scheduled_for:null` run and delivers it synchronously through the same run path as `fire`; never collides with the occurrence key. |
| `runs` | implemented (#144) | Run history newest-first; stored runs merged with derived `missed` entries (`run_id:null`, `derived:true`) unless `--stored-only`; `--task/--status/--limit`. |
| `reconcile [--task]` | implemented (#144) | Materializes derived missed occurrences into real `missed` run records (idempotent). |
| `fire <task-id> --scheduled-for <ts>` | implemented (#145) | Idempotent single-occurrence fire; see §Fire semantics. |
| `tick` | implemented (#145) | Scan due occurrences across enabled tasks; apply `misfire`; fire. The OS/watch driver entrypoint. |
| `watch [--interval SEC]` | implemented (#145) | Opt-in foreground driver: sleep-until-next-due (capped at `--interval`, default 60 s) + `tick` loop; registers a pid-checked `watch` driver record. |
| `schedule install\|uninstall\|status` | implemented (#145) | OS scheduler adapter — ONE entry per plugin invoking `tick` (launchd / systemd --user timer / schtasks); records an `os-scheduler` driver record. |
| `hook` (event entrypoint) | #146 | `[[events]]` handler for reserved `event` schedules. |
| `serve` (webhook) | #147 | Only if #147 adopts opt-in foreground serve; otherwise absent. |

## Fire semantics (normative, #145)

- `fire <task-id> --scheduled-for <ts>` validates `ts` against the
  task's schedule: it MUST be a genuine occurrence instant
  (`isOccurrenceInstant` — interval grid, exact `once.run_at`, or a
  `fixed_time` wall-clock round-trip), MUST NOT be in the future, and
  MUST lie inside the enabled window. Violations →
  `invalid_occurrence`. Driver-supplied values are validated, never
  trusted.
- Existing records for the key are checked BEFORE schedule
  re-validation (the interval anchor advances to the last fired
  occurrence, so a spent key can fall off the current grid).
- Idempotent no-op: an existing run in `scheduled | running | success |
  failed` is returned unchanged. `missed | skipped | cancelled` do not
  block — an explicit `fire` is a legitimate retry and creates a new
  run record (the honest history keeps both).
- Misfire on explicit fire: an occurrence older than the 60 s grace
  fired under `misfire:"skip"` records a terminal `skipped` run
  (`error.code:"misfire_skip"`) and is never executed; under
  `run_once` (or inside the grace) it executes normally. `run-now`
  (`trigger:"manual"`, `scheduled_for:null`) always executes — it is
  the manual override.
- `tick` partitions each enabled task's unresolved due occurrences at
  exactly the `deriveMissed` cutoff (`now - MISSED_GRACE_MS`):
  - inside grace → fire each through the run path;
  - past grace → `misfire:"skip"` materializes them `missed` (never
    executed); `misfire:"run_once"` fires the MOST RECENT late
    occurrence once and materializes the rest `missed`.
- Anchor invariant: `schedule_anchor_at` advances to a fired
  occurrence only after every earlier owed occurrence has a run
  record — `tick`/`fire` materialize missed occurrences first
  (excepting the key about to fire) so pre-anchor occurrences can
  never silently drop out of the owed/missed derivation.
- Preflight: `fire`/`tick`/`run-now` probe herdr connectivity
  (`session.snapshot`) BEFORE creating any run record. Transport
  failure → `socket_unavailable`, exit non-zero, NO record; the
  occurrence resolves `missed` on next read. Failures after the
  record exists (destination gone, agent errors, mid-delivery
  transport loss) become honest `failed` runs with the observed code.

## Run delivery (normative, #145 — ADR-0023)

- Prompt provenance: every delivered prompt begins with
  `[automations] scheduled task <task_id> ("<name>") run <run_id> —
  scheduled_for <iso>|manual run` so automation input is always
  distinguishable from user input.
- `destination.kind="pane"`: `agent.get` verifies a live agent
  (missing/closed → `destination_unavailable`), then `agent.prompt`
  delivers; observed `agent_status` is recorded in `result`.
- `destination.kind="launch"`: the surface resolves to a fresh shell
  pane — `{new_workspace:true}` → `workspace.create`,
  `{workspace_id}` → `tab.create`, `{tab_id}` → `pane.split` of the
  tab's first pane — then `agent.start` (`kind=destination.agent`,
  `args=launch_args`) and `agent.prompt` (with the same brief
  prompt-registry retry as handoff execute). `via:"handoff-execute"`
  is schema-reserved and fails honestly `unsupported_destination`.
- Run status observes API/agent-status results only; PTY text is
  never parsed into success. `destination_snapshot` records the
  fire-time resolved identities (pane/workspace/tab/agent/argv).

## Driver reporting (normative, #145)

- `watch` registers a `watch` driver record (pid + heartbeat) for its
  session registry and removes it on clean stop; `schedule
  install|status` maintains an `os-scheduler` record (platform,
  entry, status).
- Task `driver.state` derives honestly: live watch pid → `watch`;
  installed OS entry → `os-scheduler`; failed install →
  `install_failed`; dead pid / missing entry → `stale`; nothing →
  `none`. Coverage is reported, never implied.

## Idempotency (normative)

- Idempotency key = `task_id + scheduled_for`. `scheduled_for` is
  computed plugin-side from the schedule; driver-supplied values are
  validated, not trusted.
- `fire`/`tick` encountering an existing run for the key in
  `scheduled | running | success | failed` returns that run — no
  duplicate execution. Concurrent fires serialize on the
  single-writer state lock.
- `missed | skipped | cancelled` runs do not auto-retry; v1 has no
  automatic retry (manual `run-now`/`retry`-like re-fire is a new
  decision per occurrence).

## Missed-run & offline policy (normative)

- Occurrences are owed only inside enabled windows
  (`enabled_at`..`disabled_at`/now) and become `missed` only after the
  60 s driver-jitter grace; reads (`list`, `get`, `runs`) resolve them
  deterministically into derived `missed` entries (lazy resolution,
  ADR-0002 path 1). Nothing is reported as having run that did not.
- `set-enabled false` materializes owed missed runs before closing
  the window, so a later resume cannot silently forgive occurrences
  an earlier read already reported.
- `misfire: "skip"` (default): late occurrences are marked `missed`,
  never executed. `misfire: "run_once"`: the next `tick` fires the
  most recent missed occurrence once, then resumes the schedule.
- herdr/socket unreachable at fire time → transport error, exit
  non-zero, NO run record fabricated; the occurrence resolves as
  `missed` on next read. No store-and-forward queue in v1.
- Driver coverage is reported, not assumed: task `driver.state`
  distinguishes `os-scheduler | watch | none | install_failed |
  stale`; `schedule status` reports entry drift honestly.

## Error model

JSON error object on stderr:
`{"contract","ok":false,"error":{"code","message","task_id"?}}`.

| Code | Meaning |
| --- | --- |
| `usage` | Bad args (exit 2). |
| `invalid_schedule` | Schedule fails schema validation (incl. past `once.run_at`, bad zone/weekday). |
| `unsupported_schedule` | Reserved type (`webhook`/`event`) or platform-inexpressible schedule. |
| `invalid_task` | Destination/name/prompt/misfire fails validation (#144 additive code). |
| `task_not_found` | Unknown `task_id`. |
| `destination_unavailable` | Pane closed / no live agent / surface gone at fire time. |
| `socket_unavailable` | herdr socket unreachable — never reported as success. |
| `lock_timeout` | Single-writer lock could not be acquired in time. |
| `state_corrupt` | State file unreadable; refuses to guess. |
| `driver_unavailable` | `tick`/`fire` invoked with no resolvable driver context where required. |
| `invalid_occurrence` | `fire --scheduled-for` is not a genuine occurrence instant / is future / outside the enabled window (#145). |
| `unsupported_destination` | Reserved `via:"handoff-execute"` or otherwise undeliverable destination shape at fire time (#145). |
| `unsupported_platform` | Host platform has no `schedule` adapter (#145). |
| `error` | Catch-all handled failure (exit 1). |

## State and identity

- Durable state ONLY under `HERDR_PLUGIN_STATE_DIR`
  (`state.json` + lock file), single-writer lock + atomic rename
  (ADR-0001). Config under `HERDR_PLUGIN_CONFIG_DIR`.
- Task/run ids are plugin-generated (`task_*`/`run_*` + ULID/UUID);
  identity always resolves Host/Session via the socket the CLI
  targets — state is session-namespaced like `rebuildup.inbox`
  (hostname + socket path) so tasks never leak across sessions/hosts.
- `created_by` records the invoking actor surface; v1 actors are
  `cli` and `hook` (MCP deferred to #30).

## Boundaries (normative summary — see ADR-0023)

- No daemon, no HTTP server (except a possible #147 opt-in `serve`,
  which would be explicit foreground, localhost-bound).
- Automations invoke `rebuildup.handoff`/`rebuildup.controls`
  surfaces; they never reimplement agent lifecycle, and there is no
  automatic handoff on failure/idle (ADR-0021 §6).
- `webhook`/`event` schedules are reserved until #146/#147; forge
  (Issue/PR) events and multi-stage durable workflows are out of v1.
- CLI-only in v1; MCP exposure is #30's decision.
