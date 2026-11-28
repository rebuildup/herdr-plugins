# Spec: Machines plugin (`rebuildup.machines`)

Read-only inventory and probe over herdr **saved machines** — the
residual of the T3Code remote-access/devices inventory (#34) assigned
to #161. Boundary is fixed by ADR-0028
(`docs/adr/0028-remote-machines-inventory-boundary.md`): the plugin
survives **narrowed to read-only `list` / `probe` / `capability`**;
machine lifecycle stays with the herdr CLI; zero credential handling.

## Sources

- herdr saved machines: `herdr machine list --json` →
  `{id, label, target, session, enabled, selected}`; lifecycle via
  `herdr machine add/remove/enable/disable/reconnect` (herdr core,
  `src/cli/machine.rs`).
- ADR-0020 remote execution: `herdr --machine <label-or-id> <cli>`
  routes any API-backed CLI subcommand through an SSH bridge to the
  remote host's `remote-api-bridge` (`SavedSshApiBridge`).
- `plugins/handoff/src/remote.ts` — the proven transport/envelope/
  error-taxonomy patterns this plugin mirrors (duplicated minimally per
  ADR-0028 §2; no `packages/` extraction).
- Live verification: `docs/research/machines-v1-live-verification.md`
  (Ubuntu (WSL), herdr 0.9.5 / protocol 22) and the earlier
  `docs/research/handoff-remote-api-verification.md`.

## Scope

In scope:

- Enumerate saved machines (`list`).
- Probe one or all machines (`probe`): reachability via remote
  `api snapshot`, remote `version`/`protocol`, remote plugin surface
  via `plugin list --json`.
- Last-known probe metadata cached in plugin state for `list` to merge.
- Contract discovery (`capability`).

Out of scope (never reimplemented):

- Machine lifecycle: add / remove / rename / enable / disable /
  reconnect — `herdr machine …` owns these.
- Credentials: SSH keys, agent, targets' auth — OpenSSH/herdr-owned.
  The plugin passes target strings to argv only.
- Device streaming, guest links, T3 Connect, peer-link OAuth,
  managed policy, background service, updating — #34 classification.

## Model

### MachineEntry

One saved machine from `herdr machine list --json`:

| field | type | note |
| --- | --- | --- |
| `id` | string | stable machine id (selector of last resort) |
| `label` | string | human label; unique-ish, matched case-insensitively |
| `target` | string | SSH target (host alias / user@host) |
| `session` | string | remote herdr session bound to the profile |
| `enabled` | boolean | herdr-reported enable state |
| `selected` | boolean \| null | herdr's "selected" marker when present |

Selector resolution: exact `id` match first, then case-insensitive
`label` match. Multiple label matches → `machine_ambiguous` (usage,
exit 2); no match → `machine_not_found` (usage, exit 2).

### MachineProbe

Result of probing one machine — the unit stored in plugin state and
returned by `probe`:

| field | type | note |
| --- | --- | --- |
| `contract` | `"herdr-plugins.machines/v1"` | |
| `machine_id` | string | |
| `state` | ProbeState | see below |
| `probed_at` | ISO-8601 | |
| `reachable` | boolean \| null | null when not probed (disabled) |
| `server_version` | string \| null | remote `session.snapshot` version |
| `protocol` | number \| null | remote API protocol |
| `plugin_surface` | PluginSurface | `supported` / `unsupported` / `unknown` |
| `plugins` | RemotePluginEntry[] \| null | remote `plugin list` entries |
| `plugin_surface_error` | string \| null | why surface is not supported |
| `error_kind` | string \| null | coarse kind when `state != ok` |
| `error` | string \| null | human-readable detail |

### ProbeState taxonomy

| state | meaning |
| --- | --- |
| `ok` | remote `api snapshot` answered; version/protocol recorded |
| `disabled` | herdr reports the machine disabled — **no SSH attempt** |
| `unreachable` | bridge/SSH/session failure before a remote answer (incl. timeout) |
| `unsupported_remote` | remote answered but lacks machine API forwarding (`remote-api-bridge`, ADR-0020) |
| `error` | anything else (remote `{error}` envelope, malformed output, unexpected failure) |

### PluginSurface

| value | meaning |
| --- | --- |
| `supported` | remote `plugin list --json` returned a `plugin_list` result envelope with a `plugins` array — API-backed enumeration of the **remote** host's plugins |
| `unsupported` | the call failed or returned no usable result (older herdr without the `plugin.list` API method, bridge error, malformed payload) |
| `unknown` | not probed (machine disabled/unreachable) |

`plugin_surface: "unsupported"` is an honest degradation, never a
fabricated inventory (ADR-0028 §4). Verified live: `plugin.list` is an
API method (`Method::PluginList` over the socket; `--machine` routes it
through the bridge and machine connection errors never fall back to
local state — upstream `src/cli/plugin.rs`), and the WSL remote
returned `{plugins: []}` consistent with its plugin-less
`~/.config/herdr`.

## Commands

```bash
./bin/machines capability
./bin/machines list
./bin/machines probe <machine-id|label>
./bin/machines probe --all
```

- `list` — live `herdr machine list --json` merged with
  `state.probes[machine_id]` as `last_probe` (null when never probed).
  Never probes live.
- `probe` — resolves the selector (or iterates all machines for
  `--all`), runs the remote calls, records each result to plugin state
  (`HERDR_PLUGIN_STATE_DIR/state.json`, lock + atomic rename), emits
  `{contract, command, total, results[]}`.

Exit codes: 0 success, 1 handled error, 2 usage (`machine_not_found`,
`machine_ambiguous`, bad arguments).

## Transport and safety

- Every remote call is a fresh `herdr` CLI spawn with a 45s timeout;
  ambient `HERDR_*` env (`HERDR_SOCKET_PATH`, `HERDR_SESSION`, pane/
  workspace/tab ids, …) is stripped from children — ADR-0020 rule 1.
- Probe calls per machine: `api snapshot` then `plugin list --json`.
  `probe --all` is sequential — each call re-opens the SSH bridge, so
  parallelism adds connection churn without correctness gain.
- `{id, result|error}` envelope parsing tolerates noise lines and reads
  the last JSON envelope on stdout then stderr (same convention as
  herdr-client / handoff).
- State stores probe metadata only; probes for machines no longer in
  `machine list` are ignored by `list` (never applied to a different
  machine — keyed by stable machine id).

## Consumers

herdr-t3 remote-machines display, the #30 MCP server, and automation
targeting consume `herdr-plugins.machines/v1` — never plugin internals.
