# rebuildup.machines

Read-only inventory and probe over herdr **saved machines** (issue
#161, parent #34; boundary ADR-0028). Answers "which remote machines
exist, are they reachable, what herdr version/protocol do they run, and
do they expose a plugin surface" through one versioned contract —
consumable by herdr-t3, the #30 MCP server, and automations without
each re-implementing probe logic.

Scope is deliberately narrow: **no machine lifecycle** (add/remove/
enable/disable stays with `herdr machine …`), **no credentials** (SSH
auth is OpenSSH-owned; target strings go to argv only). Probe metadata
(last reachability, versions, plugin surface) is cached under
`HERDR_PLUGIN_STATE_DIR`.

## Contract

`herdr-plugins.machines/v1` (draft) — see
`docs/contracts/machines-v1.md`. Internal docs: `docs/specs/machines.md`,
ADR-0020 (remote execution path), ADR-0028 (inventory boundary).

## Commands

```bash
bun run src/cli.ts capability
bun run src/cli.ts list
bun run src/cli.ts probe <machine-id|label>
bun run src/cli.ts probe --all
```

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
ambient `HERDR_*` env stripped — the ADR-0020 `SavedSshApiBridge` path,
same as handoff's `remote-probe`. Probe logic is duplicated minimally
from `plugins/handoff/src/remote.ts` per ADR-0028 §2 (no `packages/`
extraction until a second consumer justifies it).

## Runtime prerequisite

[Bun](https://bun.sh) — the plugin is dependency-free TypeScript run
directly by `bun run src/cli.ts`.
