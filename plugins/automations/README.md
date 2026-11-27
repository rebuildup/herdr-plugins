# rebuildup.automations

Scheduled and event-triggered agent runs for herdr — the
standalone-plugin port of T3 Code's scheduled tasks / webhook
automations, adapted to herdr's no-daemon model.

- Plugin ID: `rebuildup.automations`
- Install: `herdr plugin install rebuildup/hoxay-plugins/plugins/automations`
  (pre-release: append `--ref release-0-7-0` or a commit SHA)
- Contract (STABLE): `herdr-plugins.automations/v1` —
  `docs/contracts/automations-v1.md`
- Spec: `docs/specs/automations.md`; decisions: ADR-0022 (firing),
  ADR-0023 (delivery/boundaries), ADR-0026 (webhook = upstream gap)
- Runtime prerequisite: [Bun](https://bun.sh) on `PATH`.

## Status

T4 event triggers (#146) sit on top of the T3 firing + delivery
(#145) and T2 registry: `fire`/`tick` idempotent occurrence firing
with misfire policies, `schedule install|uninstall|status` OS
adapters (launchd / systemd --user / schtasks) and opt-in `watch`,
run delivery via `agent.prompt`/`agent.start` with `[automations]`
provenance, honest `driver.state` reporting, and `event` schedules
fired by herdr `[[events]]` manifest hooks (see below). T5 (#147)
finalized the contract as STABLE: webhook triggers are
unsupported in v1 — an upstream gap (ADR-0026), see below. The
plugin holds no clock and no daemon — external clocks call the
idempotent `tick`/`fire` path and herdr calls the hook entrypoint
(ADR-0022).

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
bun run src/cli.ts fire <task_id> --scheduled-for <iso8601>
bun run src/cli.ts tick
bun run src/cli.ts watch [--interval SEC]
bun run src/cli.ts schedule install|uninstall|status
bun run src/cli.ts help
```

Global flags: `--session NAME --socket PATH --timeout MS`.

Schedules: `interval` (`every_ms >= 60000`), `fixed_time`
(`time_of_day` HH:MM + optional `weekdays` 0=Sun..6=Sat + optional IANA
`time_zone`), `once` (ISO 8601 with explicit offset, must be future),
`event` (below). `webhook` is schema-reserved →
`unsupported_schedule` permanently in v1 (ADR-0026 — see §Webhook).

### Event schedules (#146)

```json
{ "type": "event",
  "on": "pane.agent_status_changed",
  "filter": { "agent_status": "done" },
  "debounce_ms": 5000, "cooldown_ms": 60000, "max_fires": 10 }
```

`on` is one of the 22 hook-eligible dotted event names
(`workspace.*`/`worktree.*`/`tab.*`/`pane.*` — the manifest subscribes
to all of them). `filter` exact-matches extracted dimensions
(`pane_id`, `tab_id`, `workspace_id`, `agent`, `agent_status`);
`debounce_ms` collapses bursts into one fire anchored at the first
mark; `cooldown_ms`/`max_fires` decline bursts into honest `skipped`
runs (`error.code` `cooldown`/`max_fires`).

Mechanism: herdr invokes `src/hook.ts` per `[[events]]` manifest
entry; the hook only records a pending mark (capped at 500,
overflow counted) — no socket work, no delivery. The next `tick` or
`watch` pass drains matching marks and delivers through the same run
path as clock fires (`trigger:"event"`, `scheduled_for` = burst
anchor, same idempotency key). `pane.agent_status_changed` also
records the observed status on the latest delivered run for that
pane (`result.agent_status`/`agent_status_at`). Events herdr never
delivers never fire — `tick` reports `events.fired:0`.

### Webhook (#147) — unsupported in v1

T3 Code's webhook automations need an inbound HTTP endpoint
(HMAC-SHA256 verification, filters, dedupe/coalesce). herdr has no
inbound HTTP or tunnel path, and an opt-in foreground `serve`
listener would violate the ADR-0002 no-daemon invariant, so ADR-0026
records `webhook` schedules as an **upstream gap**: `create`/`update`
reject them with `unsupported_schedule`, there is no `serve`
command, and `planned_commands` is empty. Offline semantics, had an
endpoint existed, would still be sender-side retry only — the plugin
never buffers requests it cannot receive. Resolution condition:
herdr ships an inbound HTTP/tunnel API (or equivalent plugin hook);
upstream Issues are currently not filed (prior feature requests were
closed by the upstream rate-limit bot — see `docs/specs/automations.md`
§Upstream gap candidates).

`run-now` records and delivers a manual run
(`trigger:"manual"`, `scheduled_for:null`) through the same
`agent.prompt`/`agent.start` path as scheduled fires; it always
executes and never collides with the occurrence idempotency key.

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

## Interactive TUI (#243)

The plugin ships a tab-placed pane entrypoint plus an `open` action
(`herdr-plugins.tui/v1`; ADR-0031/0032/0033):

```toml
# herdr-plugin.toml (already declared)
[[panes]] id = "main"  placement = "tab"  command = ["bun","run","src/tui.ts","main"]
[[actions]] id = "open" contexts = ["pane","workspace"]  command = ["bun","run","src/tui.ts","open"]
```

- `open` pins the origin context (workspace/tab/focused pane/cwd) once
  and calls `plugin.pane.open` with `placement = "tab"`, forwarding the
  pins as `HERDR_TUI_*` env vars. `HERDR_PANE_ID` inside the UI is the
  UI pane's own surface identity — never a mutation target. Every CLI
  call additionally carries `--socket <resolved>`, so the UI always
  targets the same herdr session (and session-namespaced registry) it
  was launched in — schedule management works GUI-less on WSL/SSH/
  headless hosts.
- The UI consumes this plugin's own CLI (`src/cli.ts`) for every read
  and mutation, so the public contract stays the single source of
  truth and CLI/MCP/GUI behavior cannot drift. Opening performs reads
  only — `tick` drains, `reconcile` materialization, and `schedule
  status` driver-record writes never run implicitly; they are explicit,
  confirm-gated keys in the driver diagnostics view.
- Surfaces: task list/search (`/` filter), guided create/edit forms
  (name, prompt, schedule `interval`/`fixed_time`/`once`/`event` —
  `webhook` renders disabled per ADR-0026 — destination `pane`/`launch`,
  misfire policy), per-task detail with recent runs, enable/disable,
  run-now, per-task reconcile, delete, a runs history viewer (stored
  runs merged with honestly-labeled derived `missed` entries), and
  driver diagnostics (stored driver state + explicit `schedule
  status|install|uninstall`, `tick` now, detached `watch` start).
- Every mutation is confirm-gated (exact target + consequence, Esc
  cancels), checked against `capability`/`mutation_commands` (fail
  closed when unavailable), and task mutations re-validate via `get`
  immediately before writing — a vanished task aborts `stale`, a
  changed `updated_at` asks before applying.
- Non-TTY stdin degrades to a plain-text task list; the non-
  interactive CLI is unchanged.

Opt-in keybind (user-owned; plugins never write herdr config):

```toml
[[keys.command]]
key = "prefix+A"
type = "plugin_action"
command = "rebuildup.automations.open"
description = "open automations TUI"
```
