# RC verification — v0.1.0 (`rebuildup.inbox`)

Verification record for the v0.1.0 release candidate. Fixed target:

- Release branch HEAD: `8cba62b794b6d73f3b301aa536c76e2513d69a8b`
  (`release-0-1-0`, includes PRs #11–#17)
- herdr: `0.9.5` on all platforms
- Bun: `1.4.4`
- Platforms exercised: macOS (arm64), Linux (WSL2, Ubuntu), Windows 11

## Environments

| Env | Host | Session | Isolation |
| --- | --- | --- | --- |
| macOS | local (arm64) | `plugin-rc-2` | dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`HERDR_CONFIG_PATH` under `/var/tmp/herdr-plugin-rc` |
| Linux | `device-wsl` (WSL2, ssh) | `plugin-rc-wsl` | same layout under `/tmp/herdr-plugin-rc-wsl`, direct mise binary paths (shims blocked by untrusted mise config) |
| Windows | `device-windows` (Windows 11, ssh/cmd) | `plugin-rc-win` | same layout under `%TEMP%\herdr-plugin-rc`; `XDG_*` honored by herdr 0.9.5 |

The user's live sessions were never touched. Remote sessions were stopped
and deleted after verification; macOS session `plugin-rc-2` remains for
further checks and is isolated from the default session.

## Results — macOS (herdr 0.9.5, Bun 1.4.4)

| Area | Method | Result |
| --- | --- | --- |
| Quality gates | `bun run validate:fast` (tsc strict, biome, 20 tests) | PASS |
| `herdr plugin link` | linked `plugins/inbox`, `plugin list`, config dir reported | PASS |
| GitHub install | `herdr plugin install rebuildup/herdr-plugins/plugins/inbox --ref release-0-1-0 --yes` → resolved `8cba62b` | PASS |
| Manifest actions | `plugin.action.invoke` settle/restore → exit 0, structured JSON, state mutated | PASS |
| Event hook `pane.closed` | real pane close → hook `succeeded`, state entry deleted | PASS (found+fixed event-name serialization bug) |
| Event hook `pane.agent_status_changed` | **real agent transitions**: claude start → blocked, prompt-answer → idle; 3 hook deliveries `succeeded`, inbox wake observed | PASS |
| Startup hook | server restart → `reconcile` ran once (`event=startup`, exit 0) | PASS |
| Disable / enable | registry `enabled` flag toggles | PASS |
| Update | `plugin update --yes` → new generation checkout, old generation retained | PASS |
| Rollback | temp branch at `cfb65e8` → `install --ref` → old build read v2 state correctly → reinstalled `release-0-1-0` | PASS |
| State preservation | settle state survived link→uninstall→GitHub install→update→rollback cycle | PASS (state dir keyed by plugin id, outside checkout) |
| Real TUI operation | user-config `[[keys.command]]` `plugin_action` binds (`prefix+alt+i/o/r`) → settle/restore invoked from live TUI, `inbox_state` token projected/cleared | PASS |
| Snooze deadline wake | `snooze --until <iso>` → detached `_wake` process observed → at deadline, without `watch`, metadata token cleared and pane returned to inbox | PASS |
| Generation detection fix | mark recorded pre-agent-detection (`seq:-1`) → agent appears (`blocked`, `seq:2`) → pane correctly returned to inbox (PR #17) | PASS |
| CLI contract | `list`/`settle`/`restore`/`capability` JSON, session/socket echo, structured stderr errors | PASS |
| External client path | `herdr plugin list --json` → `plugin_root` → `bun run src/cli.ts` from arbitrary cwd; explicit `HERDR_SOCKET_PATH` targets the right session; bad pane id → structured error exit 1 | PASS |

## Results — Linux / WSL2 (`device-wsl`, herdr 0.9.5, Bun 1.4.4)

| Area | Result |
| --- | --- |
| GitHub install `--ref release-0-1-0` | PASS (resolved `8cba62b`) |
| `capability` / `list` / `settle` CLI | PASS; state_file under isolated `XDG_STATE_HOME` |
| Pane metadata projection | PASS (`inbox_state: settled` token via socket API) |
| `pane.closed` hook on real close | PASS (`succeeded`, state entry removed) |
| State schema | v2 namespaced `sessions["UUU <socket path>"]` written correctly | PASS |

## Results — Windows 11 (`device-windows`, herdr 0.9.5, Bun)

| Area | Result |
| --- | --- |
| GitHub install `--ref release-0-1-0` | PASS (resolved `8cba62b`) |
| `capability` / `list` / `settle` CLI | PASS; state_file under `XDG_STATE_HOME` (`%TEMP%\herdr-plugin-rc\state`) |
| Pane metadata projection | PASS (`inbox_state: settled` token) |
| `pane.closed` hook on real close | PASS (`succeeded`, state entry removed) |
| State schema | v2 namespaced, Windows socket path as session key | PASS |

Windows notes: mise shims are unusable over non-interactive ssh when the
mise config is untrusted; verification used direct install paths
(`github-herdrdev-herdr\0.9.5\herdr.exe`, `~\.bun\bin\bun.exe`). Plugin
commands (`bun run …`) resolve `bun` from the server PATH, which the
operator controls — same requirement as any plugin.

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
6. Organize marks recorded while a pane had no detected agent session
   (`seq:-1`, no fingerprint) never woke when an agent later appeared.
   Fixed in `67f081f` (PR #17), verified live on macOS.

## Remote execution path

Verified contract: run the plugin CLI **on the herdr host** (locally or via
the existing ssh/device route used for `device-wsl`/`device-windows`). State
is host-local and session-namespaced (`hostname + canonical socket path`),
so pointing a local CLI at a forwarded remote socket creates a *separate*
namespaced view rather than corrupting host state — but the supported path
is host-local execution. No custom transport was added; herdr-t3 and agents
use `herdr plugin list` → `plugin_root` → CLI, or `herdr --remote`.

## Known limitations

- `watch` long-run soak not performed; it is opt-in and identical to the
  read path already exercised.
- TUI verification used configured `plugin_action` keybinds (the only TUI
  invocation surface in plugin v1); no dedicated inbox palette exists.
- Attention granularity limited to herdr's `agent_status` (upstream gap,
  Issue #8); Agent View is a single slot (Issue #9).
- `pane.agent_status_changed` fires on status transitions herdr detects;
  providers without detection integration only produce `unknown`/shell
  states — no fabricated statuses.
