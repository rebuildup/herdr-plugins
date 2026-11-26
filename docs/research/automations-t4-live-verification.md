# Live verification — `rebuildup.automations` event triggers (#146 / parent #32 T4)

End-to-end smoke of `event` schedules against **real herdr 0.9.5**
manifest `[[events]]` hooks — complementing the fake-hook/transport
contract tests (`tests/automations-t4.test.ts`).

- Plugin: `plugins/automations` @ branch `146` (v0.4.0)
- herdr: `0.9.5` (protocol 22, isolated named session `verify146`,
  headless `herdr server`)
- Bun: `1.4.4`; platform: macOS (arm64)
- Agent: real `codex 0.171.0` in pane `w1:p1` (real `~/.codex`
  credentials via real `HOME`; providers read/use only what they
  write)

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `verify146` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`HERDR_CONFIG_PATH` (`/var/tmp/herdr-plugin-146`) — the user's live sessions were never targeted; every CLI call ran under `env -i` with only the isolated vars, `HERDR_SESSION=verify146`, and ambient `HERDR_*` socket/workspace vars unset |
| plugin install | `herdr plugin link plugins/automations` inside the isolated session — manifest registered all 22 `[[events]]` entries |
| plugin state | herdr-owned plugin state dir (`state/herdr/plugins/rebuildup.automations/state.json`); CLI calls ran with `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` unset so `pluginDirs()` resolves the same XDG path |

The isolated session was stopped and deleted afterwards
(`herdr session delete verify146`); evidence retained at
`/var/tmp/herdr-plugin-146` (server log, env recipe in `env.sh`,
final `state.json`).

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | Manifest wiring | `plugin link` registered all 22 `[[events]]` → `bun run src/hook.ts`; `plugin list` shows them enabled — PASS |
| 2 | Hook mark recording | `herdr workspace create` produced real `workspace.created`/`tab.created`/`tab.focused`/`pane.focused`/`pane.created` deliveries; `state.json` `pending_events` holds the marks with canonical dotted names and raw snake_case `data` payloads — PASS |
| 3 | `event` schedule create/update | `create --schedule '{"type":"event","on":"tab.created","debounce_ms":2000}'` accepted; `update` to `pane.agent_status_changed` + `filter{agent_status,pane_id}` + `cooldown_ms`/`max_fires` accepted — PASS |
| 4 | Pre-enabled marks never fire | Marks recorded before `enabled_at` stayed pending and did not fire (consumed=1 for the single in-window mark) — PASS |
| 5 | `tab.created` → tick → run | `herdr tab create` → mark; `tick` reported `events:{consumed:1,fired:1,pending:7}`; run `trigger:"event"`, `scheduled_for` = mark `received_at`, delivery attempted — run honestly `failed` `destination_unavailable` (target pane had no agent) — PASS |
| 6 | `pane.agent_status_changed` → fire → success | Real codex agent in `w1:p1` produced observed `idle`/`working`/`idle` transitions; task filtered `agent_status:"idle"` + `pane_id:"w1:p1"` + `cooldown_ms:3600000` + `max_fires:3`; `tick` → `events:{consumed:3,fired:1,suppressed:2}` — PASS |
| 7 | Run record | `runs` shows: 1 `success` event run (`scheduled_for` = first burst anchor, `result.agent_status:"idle"` + `agent_status_at` folded from a LATER observed status while codex processed the delivered prompt), 2 `skipped` runs with `error.code:"cooldown"`, plus the earlier honest `failed` run — PASS |
| 8 | Observation loop | The automation's own `agent.prompt` drove codex `working → idle`; the hook folded that observed `idle` into the delivered run's `result.agent_status`/`agent_status_at` — observed values only, no fabricated completion — PASS |
| 9 | No feedback loop | `cooldown_ms` suppressed the automation-prompt-induced status churn: post-fire idle marks declined as `skipped`, never re-fired — PASS |

## Notes / honest limits

- Delivery `success` means `agent.prompt` was accepted and the
  observed post-submit status recorded — codex's actual reply text
  was not asserted (PTY text is never parsed, AGENTS §4).
- `agent_status:"done"` was not observed for codex (turn completion
  reports `idle`); the `done` filter value is still schema-valid and
  covered by fake-event contract tests.
- Pending unmatched marks (e.g. `working` transitions, pre-window
  marks) remain in `pending_events` bounded by the 500 cap —
  reported via `events.pending`, never silently dropped.
