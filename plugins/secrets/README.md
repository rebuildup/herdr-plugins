# rebuildup.secrets

Secret reference resolution and env injection for herdr — contract
`herdr-plugins.secrets/v1` (Issue #160, boundary ADR-0027).

Infisical-only in v1 (canonical provider per the `secrets-management`
skill, self-host `https://secrets.rebuildup.dev`). Declared bindings in
`config.json` map env var names to `infisical:<env>:<path>:<secret>`
references; every CLI action names its bindings explicitly. Resolved
values have exactly two sinks: the wrapped child's environment (`run`)
and herdr surface-creation `env` params (`inject`). Values are never
persisted, logged, placed in argv, or emitted.

## Commands

```bash
bun run src/cli.ts capability [--probe]
bun run src/cli.ts resolve  --binding <name>...
bun run src/cli.ts run      --binding <name>... -- <cmd> [args...]
bun run src/cli.ts inject   --binding <name>... --surface <workspace|tab|pane> [...]
bun run src/cli.ts config   [--init]
```

See `docs/specs/secrets.md` and `docs/contracts/secrets-v1.md`.

## Prerequisites

- [Bun](https://bun.sh) runtime (same as every plugin here).
- The official `infisical` CLI on `PATH` (or `--infisical-bin`),
  authenticated via `infisical login` / `INFISICAL_TOKEN` /
  Machine Identity — the plugin stores no credentials itself.
- herdr ≥ 0.9.0 for `inject` (surface `env` params, protocol 22).

## Configuration

`config.json` lives under herdr's plugin config dir
(`HERDR_PLUGIN_CONFIG_DIR`, resolved equivalently for external clients).
`config --init` writes a starter; edit the `bindings` array:

```json
{
  "infisical": {
    "domain": "https://secrets.rebuildup.dev/api",
    "projectId": "<infisical project id>"
  },
  "bindings": [
    { "name": "deepseek", "env": "DEEPSEEK_API_KEY", "ref": "infisical:dev:/shared:DEEPSEEK_API_KEY" }
  ]
}
```

Binding `env` names colliding with `HERDR_*` are rejected. There are no
wildcards and no ambient-env harvesting.
