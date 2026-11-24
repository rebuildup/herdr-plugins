# RC verification — v0.1.0 (`rebuildup.inbox`)

Verification record for the v0.1.0 release candidate. Fixed target:

- Release branch HEAD: `c84a7c1e3b448480f7c7c8f7c23ba1811c0f072e`
  (`release-0-1-0`, includes PRs #11–#14)
- herdr: `0.9.5` (`~/.local/share/mise/installs/herdr/0.9.5/herdr`)
- OS: macOS (arm64). Linux/Windows plugin paths are covered by unit-level
  path resolution and herdr's own platform handling; no dedicated runs yet.
- Bun: `1.4.4`

## Environment

Isolated named herdr session `plugin-rc-1` under
`/var/tmp/herdr-plugin-rc` with dedicated `XDG_CONFIG_HOME` /
`XDG_STATE_HOME` / `HERDR_CONFIG_PATH` (`[experimental] allow_nested`).
The user's live session was never touched. Session stopped and deleted
after verification.

## Results

| Area | Method | Result |
| --- | --- | --- |
| Quality gates | `bun run validate:fast` (tsc strict, biome, 17 tests) | PASS |
| Manifest validity | `herdr plugin link` / `install` manifest validation | PASS (after adding required `min_herdr_version`) |
| `herdr plugin link` | linked `plugins/inbox`, `plugin list`, config dir reported | PASS |
| GitHub install | `herdr plugin install rebuildup/herdr-plugins/plugins/inbox --ref release-0-1-0 --yes` → resolved `656efbd`, then updated to `c84a7c1` | PASS |
| Manifest actions | `plugin.action.invoke` settle/restore → exit 0, structured JSON on stdout, state mutated | PASS |
| Event hook `pane.closed` | close pane → hook ran (plugin log `succeeded`), state entry deleted | PASS (found+fixed event-name serialization bug) |
| Event hook `pane.agent_status_changed` | simulated envelope through `hook.ts` (snapshot + resolve + metadata path) | PASS (code path); live agent transition not re-run this RC |
| Startup hook | server restart → `reconcile` ran once (`plugin log` `event=startup`, exit 0) | PASS |
| Disable / enable | `plugin disable`/`enable`, registry `enabled` flag toggles | PASS |
| Update | `plugin update --yes` → new generation checkout at `c84a7c1`, old generation retained | PASS |
| State preservation | settle state survived link→unlink→GitHub install→uninstall→reinstall→update | PASS (state dir is keyed by plugin id, outside checkout) |
| CLI contract | `list`/`settle`/`restore`/`capability` JSON shape, `session`/`state_file` echo, structured stderr errors | PASS |
| External client dirs | `pluginDirs()` resolves `plugins/config/<id>` and `plugins/<id>` under XDG dirs; encoding mirrors herdr | PASS |

## Defects found and fixed during RC

1. `min_herdr_version` missing → herdr rejected link/install
   (`invalid_plugin_min_herdr_version`). Fixed in `1821a5b`.
2. `HERDR_PLUGIN_EVENT_JSON` serializes event names in snake_case
   (`pane_closed`) while the hook compared dotted names — `pane.closed`
   state cleanup silently never ran. Fixed in `9141666`.
3. `subscribe()` hung forever when herdr rejected the subscription
   (ack error never rejected `started`). Fixed in `fce71af`.
4. `pluginPathComponent()` lacked herdr's 120-char cap/hash suffix. Fixed
   in `fce71af`.
5. Snooze deadline parse ran inside the state lock; a parse failure would
   strand the lock file. Moved before lock acquisition in `fce71af`.

## Known limitations

- `pane.agent_status_changed` live delivery was verified in the earlier
  development session; this RC verified the hook code path via a simulated
  envelope plus the identical delivery mechanism proven by `pane.closed`.
- No resident daemon: snooze expiry materializes lazily on reads; prompt
  metadata refresh requires `watch` (opt-in) — documented in the contract.
- Attention granularity limited to herdr's `agent_status` (upstream gap,
  Issue #8); Agent View is a single slot (Issue #9).
- Remote hosts: socket API is local-only; remote operation requires running
  the CLI on the target host or an existing socket forward (contract doc).
- Linux/Windows installs not exercised on real hardware for this RC.
