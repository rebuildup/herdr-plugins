# Contract: `herdr-plugins.machines/v1`

Read-only inventory and probe contract for the `rebuildup.machines`
plugin — saved-machine reachability, remote herdr version/protocol, and
remote plugin surface. External clients (herdr-t3, the #30 MCP server,
automations) MUST depend only on this contract, never on the plugin's
internal state file format.

Scope is fixed by ADR-0028 (#34 / #161): **read-only**. Machine
lifecycle (add/remove/rename/enable/disable/reconnect) is owned by the
herdr CLI (`herdr machine …`) and is never part of this contract. The
plugin handles no credentials; SSH auth is OpenSSH-owned.

Contract status: **draft** (v0.1.0). Additive changes only once stable;
breaking changes require a new contract version.

## Invocation and discovery

```bash
herdr plugin install rebuildup/hoxay-plugins/plugins/machines
# pre-release / pinned: herdr plugin install rebuildup/hoxay-plugins/plugins/machines --ref <branch|tag|sha>
# development: herdr plugin link <repo>/plugins/machines
```

An external client resolves the CLI as follows:

1. `herdr plugin list` → installed plugin entry with `plugin_root`.
2. Run `<plugin_root>/src/cli.ts` with `bun run` from any cwd.
3. `capability` returns machine-readable discovery:

```json
{
  "contract": "herdr-plugins.machines/v1",
  "contract_status": "draft",
  "command": "capability",
  "plugin": "rebuildup.machines",
  "version": "0.1.0",
  "read_only": true,
  "mutation_commands": [],
  "commands": ["capability", "list", "probe"],
  "probe_states": ["ok", "disabled", "unreachable", "unsupported_remote", "error"],
  "plugin_surfaces": ["supported", "unsupported", "unknown"],
  "transport": "herdr machine list --json + herdr --machine <id> <cli> (SavedSshApiBridge)",
  "state_file": "…",
  "notes": ["…"],
  "generated_at": "…"
}
```

## Commands

All commands print a single JSON document on stdout; errors print
`{contract, ok:false, error:{code,message,kind?,…}}` on stderr.
Exit codes: `0` success, `1` handled error, `2` usage.

### Target selection

Every command accepts the shared plugin target flags:

```bash
bun run src/cli.ts <command> [--socket PATH] [--session NAME]
```

They select the **local** herdr instance whose saved machines are
listed/probed — the same flags external clients append to every plugin
CLI invocation. Resolution order is explicit flag > ambient
`HERDR_SOCKET_PATH`/`HERDR_SESSION` env > default, matching the
herdr-client contract. The `herdr` CLI has no target flags of its own,
so the plugin forwards them to spawned `herdr` children as
`HERDR_SOCKET_PATH` / `HERDR_SESSION` (herdr's own precedence:
`HERDR_SOCKET_PATH` > `HERDR_SESSION`). Ambient `HERDR_*` context is
otherwise stripped from children per ADR-0020. These flags are
unrelated to the remote `session` field on each saved `MachineEntry`,
which names the session on the probed remote host.

### `list`

Live enumeration merged with last-known probe metadata. Never probes.

```bash
bun run src/cli.ts list
```

Output:

```json
{
  "contract": "herdr-plugins.machines/v1",
  "command": "list",
  "total": 2,
  "machines": [
    {
      "machine": {
        "id": "5ac021a5…",
        "label": "Ubuntu (WSL)",
        "target": "device-wsl",
        "session": "default",
        "enabled": true,
        "selected": false
      },
      "last_probe": {
        "contract": "herdr-plugins.machines/v1",
        "machine_id": "5ac021a5…",
        "state": "ok",
        "probed_at": "2026-11-26T01:23:45.000Z",
        "reachable": true,
        "server_version": "0.9.5",
        "protocol": 22,
        "plugin_surface": "supported",
        "plugins": [],
        "plugin_surface_error": null,
        "error_kind": null,
        "error": null
      }
    }
  ],
  "state_file": "…",
  "generated_at": "…"
}
```

`last_probe` is `null` when the machine was never probed by this
plugin. Probe metadata for machines absent from `machine list` is
ignored (keyed by stable machine id; never applied to a different
machine).

`machine_list_failed` (exit 1) when `herdr machine list --json` fails —
an inventory that cannot enumerate fails honestly.

### `probe`

Live probe of one machine or all machines.

```bash
bun run src/cli.ts probe <machine-id|label>
bun run src/cli.ts probe --all
```

Selector resolution: exact `id` match, then case-insensitive `label`
match. `machine_ambiguous` / `machine_not_found` are usage errors
(exit 2, `kind` set, `matches`/`selector` in `error.extra`).

Per machine the plugin runs, over the ADR-0020 bridge:

1. `herdr --machine <id> api snapshot` — reachability +
   `server_version` / `protocol`.
2. `herdr --machine <id> plugin list --json` — remote plugin surface.

Each result is recorded to plugin state (last-known metadata only)
before the command returns.

Output:

```json
{
  "contract": "herdr-plugins.machines/v1",
  "command": "probe",
  "total": 1,
  "results": [ { "…MachineProbe…": "…" } ],
  "state_file": "…",
  "generated_at": "…"
}
```

`results[]` entries are `MachineProbe` objects:

| field | type | semantics |
| --- | --- | --- |
| `machine_id` | string | herdr machine id |
| `state` | `"ok" \| "disabled" \| "unreachable" \| "unsupported_remote" \| "error"` | probe outcome |
| `probed_at` | string | ISO-8601 timestamp |
| `reachable` | `boolean \| null` | null when not probed (disabled) |
| `server_version` | `string \| null` | remote herdr version |
| `protocol` | `number \| null` | remote API protocol |
| `plugin_surface` | `"supported" \| "unsupported" \| "unknown"` | remote `plugin list` surface |
| `plugins` | `[{id,name,version}] \| null` | remote plugin entries; null when not enumerated |
| `plugin_surface_error` | `string \| null` | why surface is not `supported` |
| `error_kind` | `string \| null` | coarse kind when `state != "ok"` |
| `error` | `string \| null` | human-readable detail |

`state` values:

- `ok` — snapshot answered; `server_version`/`protocol` recorded.
- `disabled` — machine disabled in herdr; **no SSH attempt is made**.
  Enable via `herdr machine enable <id>`.
- `unreachable` — SSH/bridge/session failure or timeout before a remote
  answer.
- `unsupported_remote` — remote answered but lacks machine API
  forwarding (`remote-api-bridge`; upgrade remote herdr).
- `error` — remote `{error}` envelope (kind `remote_<code>`), malformed
  output, or unexpected failure.

`plugin_surface` values:

- `supported` — remote `plugin list` returned a `plugin_list` result
  with a `plugins` array. API-backed: enumerates the **remote** host's
  installed plugins (verified live, herdr 0.9.5 / protocol 22).
- `unsupported` — the call failed or returned no usable result (remote
  herdr predates `plugin.list`, bridge error, malformed payload).
  Consumers MUST treat this as "unknown remote plugin inventory", not
  as "no plugins installed".
- `unknown` — not probed (`state` is `disabled`/`unreachable`/…).

Probe outcomes are data, not command failure: `probe` exits 0 even when
individual machines report `unreachable`/`unsupported_remote`. Only
usage errors (bad selector, `--all` mixed with a selector) and
`machine list` failure exit non-zero.

## State

`<HERDR_PLUGIN_STATE_DIR>/state.json` (platform state dir fallback):

```json
{ "version": 1, "probes": { "<machine_id>": { "…MachineProbe…": "…" } } }
```

Last-known metadata only — timestamps, versions, reachability, plugin
surface. No credentials, no PTY content, no payloads. Writes use an
exclusive lock file + tmp/rename; concurrent invocations cannot
corrupt state. Consumers MUST NOT depend on this file's format.

## Versioning

`herdr-plugins.machines/v1` draft at plugin v0.1.0. Additive optional
fields may be added without a version bump; removals/renames or
semantic changes require `v2`.
