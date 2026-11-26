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

## Interactive TUI (#247)

```toml
# herdr-plugin.toml (already declared)
[[panes]] id = "main"  placement = "tab"  command = ["bun","run","src/tui.ts","main"]
[[actions]] id = "open" contexts = ["pane","workspace"]  command = ["bun","run","src/tui.ts","open"]
```

- `open` pins the origin context once and calls `plugin.pane.open`
  with `placement = "tab"`, forwarding the pins as `HERDR_TUI_*` env
  vars. `HERDR_PANE_ID` inside the UI is the UI pane's own surface
  identity — never a mutation target.
- The UI consumes this plugin's own CLI (`src/cli.ts`) for every read
  and mutation. Opening performs reads only (`config`/`capability`).
- Surfaces: declared-binding list (invalid bindings shown
  disabled-with-reason), per-binding detail, multi-binding selection,
  `r`esolve metadata-only preview (name/env/ref/status — values are
  never part of the payload), `n` run a command with injected env
  (confirm; the TUI restores the terminal, runs `cli.ts run` with
  inherited stdio, then reopens), `i`nject into a new herdr surface
  (confirm; env names only), `c`apability/provider info, `w` init
  starter config (confirm).
- SECRET NON-DISPLAY (ADR-0027): only binding names cross argv; the
  view model whitelists metadata fields so value-shaped payload keys
  cannot reach the screen. `run` hands values to the child env only.
- Every mutation is confirm-gated (exact bindings + env names +
  target + consequence, Esc cancels) and checked against
  `capability`/`mutation_commands` (fail closed when unavailable).
- Non-TTY stdin degrades to a plain-text binding-metadata list; the
  non-interactive CLI is unchanged.

Opt-in keybind (user-owned; plugins never write herdr config):

```toml
[[keys.command]]
key = "prefix+S"
type = "plugin_action"
command = "rebuildup.secrets.open"
description = "open secrets TUI"
```
