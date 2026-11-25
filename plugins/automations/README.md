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

T1 scaffold (#137): `capability` discovery only. The plugin holds no
clock and no daemon — scheduled firing is driven by external clocks
(`schedule install` OS entries or opt-in `watch`) calling the
idempotent `tick`/`fire` path (ADR-0022). Registry CRUD lands in
#144, firing/delivery in #145, event triggers in #146, webhook
evaluation (if adopted) in #147.

## Commands

```bash
bun run src/cli.ts capability
bun run src/cli.ts help
```

Planned (see contract doc): `create`/`list`/`get`/`update`/
`set-enabled`/`delete`/`run-now`/`runs`/`fire`/`tick`/`watch`/
`schedule`/`reconcile`/`hook`.

## State

Durable state will live only under herdr's plugin state dir
(`HERDR_PLUGIN_STATE_DIR` at runtime) with a single-writer lock and
atomic rename (ADR-0001); session-namespaced like `rebuildup.inbox`.
Nothing is written inside the installed source tree.
