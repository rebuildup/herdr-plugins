# rebuildup.machines

Read-only inventory and probe over herdr **saved machines** (issue
#161, parent #34; boundary ADR-0028; native Rust port #326). Answers
"which remote machines exist, are they reachable, what herdr
version/protocol do they run, and do they expose a plugin surface"
through one versioned contract — consumable by herdr-t3, the #30 MCP
server, and automations without each re-implementing probe logic.

Scope is deliberately narrow: **no machine lifecycle** (add/remove/
enable/disable stays with `herdr machine …`), **no credentials** (SSH
auth is OpenSSH-owned; target strings go to argv only). Probe metadata
(last reachability, versions, plugin surface) is cached under
`HERDR_PLUGIN_STATE_DIR`.

## Contract

`herdr-plugins.machines/v1` (draft) — see
`docs/contracts/machines-v1.md`. Internal docs: `docs/specs/machines.md`,
ADR-0020 (remote execution path), ADR-0028 (inventory boundary).

## Install / binary

```bash
herdr plugin install rebuildup/hoxay-plugins/plugins/machines
```

Prerequisites: herdr ≥ 0.9.0, `herdr` CLI on `PATH` (or
`HERDR_BIN_PATH`). The plugin is a self-contained native binary
(`bin/machines`, committed prebuilt for macOS arm64 per ADR-0035); no
Bun required. Source: `src/*.rs` (cargo workspace member
`plugins/machines`).

## Usage

```bash
# from the plugin root (see `herdr plugin list --json` → plugin_root)
./bin/machines capability
./bin/machines list
./bin/machines probe <machine-id|label>
./bin/machines probe --all
```

Every command accepts the shared target flags `--socket PATH` and
`--session NAME`, which select the **local** herdr instance (explicit
flag beats ambient `HERDR_SOCKET_PATH`/`HERDR_SESSION`). The `herdr`
CLI itself has no target flags, so they are forwarded to spawned
children as `HERDR_SOCKET_PATH` / `HERDR_SESSION`. This is unrelated to
the remote `session` field on each saved machine.

- `list` — `herdr machine list --json` merged with last-known probe
  metadata (`last_probe`, null when never probed). Never probes live.
- `probe` — live probe via `herdr --machine <id>`: remote `api
  snapshot` (reachability + `version`/`protocol`) then remote
  `plugin list --json` (plugin surface; `unsupported` is an honest
  fallback for remotes without the `plugin.list` API). Disabled
  machines report `disabled` without any SSH attempt; results are
  recorded to plugin state.

Exit codes: 0 success, 1 handled error, 2 usage.

## Transport

Each remote call is a fresh `herdr` CLI spawn (45s timeout) with
ambient `HERDR_*` context stripped — the ADR-0020
`SavedSshApiBridge` path, same as handoff's `remote-probe`. Explicit
`--socket`/`--session` CLI flags are re-injected into the child env as
`HERDR_SOCKET_PATH` / `HERDR_SESSION` (see above). Probe orchestration
mirrors the retired TS implementation line-for-line; TS↔Rust parity is
verified by `scripts/diff-machines.ts` (see
`docs/research/machines-native-rust.md`).

## Interactive TUI (#247, native #326)

```toml
# herdr-plugin.toml (already declared)
[[panes]] id = "main"  placement = "tab"  command = ["./bin/machines","tui","main"]
[[actions]] id = "open" contexts = ["pane","workspace"]  command = ["./bin/machines","tui","open"]
```

- `open` pins the origin context once and calls `plugin.pane.open`
  with `placement = "tab"`, forwarding the pins as `HERDR_TUI_*` env
  vars. `HERDR_PANE_ID` inside the UI is the UI pane's own surface
  identity — never a mutation target.
- The UI calls the plugin's own domain functions in-process (the Rust
  binary is the CLI), so CLI/TUI behavior cannot drift. Opening
  performs reads only (`list`) — it never probes live.
- Surfaces: saved-machine list (enabled/disabled/selected +
  last-known probe state, `/` filter, label+detail panes), per-machine
  detail (target, session, reachability, remote herdr
  version/protocol, plugin surface, remote plugin entries), `p`robe
  selected / `a`ll (slow SSH probes run on a worker thread — progress
  shown, Esc/Ctrl-C cancels cooperatively), `i` capability/contract
  info, `R` refresh.
- READ-ONLY: the plugin has no mutating commands; the TUI exposes no
  mutating affordance. Machine lifecycle stays with `herdr machine`.
- Non-TTY stdin degrades to a plain-text machine list; the
  non-interactive CLI is unchanged.

Opt-in keybind (user-owned; plugins never write herdr config):

```toml
[[keys.command]]
key = "prefix+M"
type = "plugin_action"
command = "rebuildup.machines.open"
description = "open machines TUI"
```
