# Machines v1 live verification (#161)

Date: 2026-11-26. Plugin `rebuildup.machines` v0.1.0, contract
`herdr-plugins.machines/v1` (draft), boundary ADR-0028.

## Environment

Local host herdr (macOS) with three saved machines from
`herdr machine list --json`:

| label | id | target | enabled |
| --- | --- | --- | --- |
| Windows | `3f85952b…` | `device-windows` | true |
| Ubuntu (WSL) | `5ac021a5…` | `device-wsl` | true |
| Lab Windows | `5979abac…` | `device-lab-win` | true |

All verification was read-only: `machine list`, `api snapshot`,
`plugin list`. No lifecycle mutation, no credential access.

## Results

### Ubuntu (WSL) — reachable, herdr 0.9.5 / protocol 22

`bun run src/cli.ts probe "Ubuntu (WSL)"` (label selector resolution
exercised):

```json
{
  "state": "ok",
  "reachable": true,
  "server_version": "0.9.5",
  "protocol": 22,
  "plugin_surface": "supported",
  "plugins": [],
  "plugin_surface_error": null,
  "error_kind": null,
  "error": null
}
```

Direct CLI evidence: `herdr --machine 5ac021a5… api snapshot` returns the
`session_snapshot` envelope (`version: "0.9.5"`, `protocol: 22`);
`herdr --machine 5ac021a5… plugin list --json` returns
`{"id":"cli:plugin","result":{"plugins":[],"type":"plugin_list"}}`.

### Remote `plugin list` semantics — verified API-backed

ADR-0028 §5 flagged remote plugin enumeration as a verification item
(`herdr plugin list` might be local-only). Verified it is **API-backed
and remote-scoped**:

- Upstream `src/cli/plugin.rs` (herdrdev/herdr): `plugin list` sends
  `Method::PluginList` over the API socket; on connection error the
  local `offline_plugin_list_response` fallback is used **only for
  local** clients — the test
  `machine_plugin_connection_errors_never_use_local_offline_state`
  asserts machine targets never see local offline state.
- Under `--machine`, the CLI connects through `SavedSshApiBridge`, so
  `plugin.list` executes on the **remote** server against the remote
  plugin directory.
- Remote host check (read-only `ssh device-wsl`): `~/.config/herdr/`
  contains `herdr.sock`, logs, `session.json`, `.plugins.lock` — and
  **no `plugins/` dir, no `plugins.json`** → the remote genuinely has
  zero installed plugins, consistent with `plugins: []`.

`plugin_surface: "supported"` therefore means "remote `plugin list`
answered with a `plugin_list` envelope". Remotes running herdr without
the `plugin.list` API method will surface `{error}` envelopes and are
reported `plugin_surface: "unsupported"` (contract-honest fallback).

### Windows — unreachable path exercised live

`bun run src/cli.ts probe Windows`:

```json
{
  "state": "unreachable",
  "reachable": false,
  "server_version": null,
  "protocol": null,
  "plugin_surface": "unknown",
  "error_kind": "remote_command_failed",
  "error": "remote machine \"Windows\" (device-windows) unreachable: herdr --machine 3f85952b… exited 1: Error: Custom { kind: ConnectionAborted, error: \"machine 'Windows' (session default): remote SSH connection failed: basic@100.118.123.62: Permission denied (publickey).\" }"
}
```

SSH auth failure (publickey) is reported as `unreachable` with the
upstream error preserved — exit code 0, honest data. Disabled-machine
and `unsupported_remote` paths are covered by fake-runner contract
tests (`tests/machines.test.ts`, 22 tests).

### `list` merge + usage errors

- `list` after probing shows `last_probe.state` per machine
  (`unreachable` for Windows, `null` for never-probed machines).
- `probe ghost` → exit 2, `{code:"usage", kind:"machine_not_found"}`.

## Upstream candidates recorded

- Remote plugin enumeration **works** on current herdr (0.9.5); no gap
  for `plugin list` itself. If older remotes lack `plugin.list`, the
  contract's `plugin_surface: "unsupported"` covers it; a
  version-gated remote plugin inventory API remains a candidate only if
  consumers need plugin *metadata* beyond id/name/version.
- Persistent remote channel (already noted in ADR-0020) unchanged.
