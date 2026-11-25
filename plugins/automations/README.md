# rebuildup.automations

Scheduled and event-triggered agent runs for herdr — the
standalone-plugin port of T3 Code's scheduled tasks / webhook
automations, adapted to herdr's no-daemon model.

- Plugin ID: `rebuildup.automations`
- Install: `herdr plugin install rebuildup/herdr-plugins/plugins/automations`
  (pre-release: append `--ref release-0-7-0` or a commit SHA)
- Contract (DRAFT): `herdr-plugins.automations/v1` —
  `docs/contracts/automations-v1.md`
- Spec: `docs/specs/automations.md`; decisions: ADR-0022 (firing),
  ADR-0023 (delivery/boundaries)
- Runtime prerequisite: [Bun](https://bun.sh) on `PATH`.

## Status

T2 registry core (#144) implemented: task CRUD, pause/resume,
manual `run-now` records, run history with deterministic missed-run
derivation, and `reconcile` materialization. The plugin holds no
clock and no daemon — scheduled firing is driven by external clocks
(`schedule install` OS entries or opt-in `watch`) calling the
idempotent `tick`/`fire` path (ADR-0022), which lands in #145; event
triggers in #146, webhook evaluation (if adopted) in #147.

## Commands

```bash
bun run src/cli.ts capability
bun run src/cli.ts create \
  --name "nightly review" \
  --prompt "Review open PRs and summarize." \
  --schedule '{"type":"interval","every_ms":86400000}' \
  --destination '{"kind":"pane","pane_id":"w1:t1:p1"}'
bun run src/cli.ts list [--enabled true|false] [--limit N]
bun run src/cli.ts get <task_id>
bun run src/cli.ts update <task_id> [--name N] [--prompt P] \
  [--schedule '<json>'] [--destination '<json>'] [--misfire skip|run_once]
bun run src/cli.ts set-enabled <task_id> <true|false>
bun run src/cli.ts delete <task_id>
bun run src/cli.ts run-now <task_id>
bun run src/cli.ts runs [--task <id>] [--status S] [--limit N] [--stored-only]
bun run src/cli.ts reconcile [--task <id>]
bun run src/cli.ts help
```

Global flags: `--session NAME --socket PATH --timeout MS`.

Schedules: `interval` (`every_ms >= 60000`), `fixed_time`
(`time_of_day` HH:MM + optional `weekdays` 0=Sun..6=Sat + optional IANA
`time_zone`), `once` (ISO 8601 with explicit offset, must be future).
`webhook`/`event` are schema-reserved → `unsupported_schedule` until
#146/#147.

`run-now` records a manual run (`trigger:"manual"`,
`scheduled_for:null`, `status:"scheduled"`); actual delivery lands
with the #145 run path.

## State

Durable state lives only under herdr's plugin state dir
(`HERDR_PLUGIN_STATE_DIR` at runtime): `state.json` + lock file,
single-writer lock + atomic rename (ADR-0001), session-namespaced
(`hostname + canonical socket path`) like `rebuildup.inbox`. Nothing
is written inside the installed source tree.

Missed runs: occurrences owed only inside enabled windows
(`[enabled_at, disabled_at ?? now]`) and only after a 60 s driver
jitter grace are derived as `missed` at read time — never reported as
having run. `reconcile` (and `set-enabled false`) materialize them
into real run records.
