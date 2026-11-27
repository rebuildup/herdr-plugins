# rebuildup.projects

Project registry for herdr panes (`herdr-plugins.projects/v1`).

## Install

```bash
herdr plugin install rebuildup/hoxay-plugins/plugins/projects
```

Prerequisites: herdr ≥ 0.9.0, Bun on `PATH`, `git` on `PATH`.
`discover` additionally needs a reachable herdr session.

## Usage

```bash
# from the plugin root (see `herdr plugin list --json` → plugin_root)
bun run src/cli.ts capability
bun run src/cli.ts list [--all]
bun run src/cli.ts show <id>
bun run src/cli.ts discover [--session NAME]
bun run src/cli.ts register <repo-path> [--title T] [--id ID]
bun run src/cli.ts update <id> [--title T] [--pinned|--unpinned]
    [--archived|--unarchived] [--repo-add PATH]... [--repo-remove PATH]...
bun run src/cli.ts archive|unarchive|pin|unpin <id>
bun run src/cli.ts settings get|set|unset <id> [key] [value]
bun run src/cli.ts scripts list <project|repo> [--repo PATH]
bun run src/cli.ts scripts run <project> <name> [--repo PATH] [--shell auto|sh|cmd|powershell]
bun run src/cli.ts scripts stop <run-id|project>
bun run src/cli.ts scripts results [project]
bun run src/cli.ts scripts logs <run-id>
bun run src/cli.ts scripts tick
bun run src/cli.ts repos list <project>
bun run src/cli.ts repos add|remove <project> --path DIR [--path DIR]...
```

Registry mutations are explicit-argument CLI invocations (never pane
actions). `scripts list` resolves project script definitions from
`t3.json` plus settings/env/builtin layers; `scripts run` executes them
in a dedicated herdr pane with a structured completion marker
(exit 0/1/timeout/stopped/unknown — never fabricated), `scripts stop`
interrupts the recorded pane, and `scripts results`/`logs` expose the
run records. The pane's shell family (POSIX sh / cmd.exe / PowerShell)
is auto-detected via `pane.process_info` with a host-OS fallback, or
forced with `--shell`; each family gets its own exit-code marker
(`#67`). Multi-repo projects require `--repo` for `run`. Script
commands are trusted repo content executed with user privileges.
`t3.json` scripts flagged `runOnWorktreeCreate` auto-run via the
`worktree.created` hook event: the hook records a pending mark and the
next `scripts tick` (or `scripts run|stop|results|logs`) drains it —
repo membership is verified by `git-common-dir`, skips are reported in
the payload's `triggers` block, and runs carry
`trigger:{kind:"worktree.created", worktree_path}`. `t3.json` scripts
flagged `runOnSettle`/`stopOnSettle` drain the installed inbox plugin's
`transitions` log lazily (ADR-0029): settled panes fire
`runOnSettle` scripts on their worktree root, and `stopOnSettle` stops
only same-worktree running runs whose script carries the flag — runs
carry `trigger:{kind:"inbox.settled", pane_id, transition_seq}`.

`repos list` also reports the repo↔worktree association (#184): per
member repo it calls herdr `worktree.list` (read-only,
`trust_repository: false`), verifies each checkout by
`git rev-parse --git-common-dir`, and returns `worktrees[]` with
path/branch/dirty plus, for worktrees open in a herdr workspace,
pane-addressed `herdr-plugins.git/v1` pointers and a compact `status`
summary fetched via the sibling git plugin's CLI. Pane-less worktrees
report path/branch/dirty only — no diff data is fabricated, and the
plugin never creates worktrees or panes (herdr/Worktrunk own
lifecycle). Unreachable herdr degrades to `worktrees: null` +
`worktrees_error`; foreign checkouts land in `worktrees_skipped`.

Full contract: `docs/contracts/projects-v1.md`. Spec: `docs/specs/projects.md`.
Design: ADR-0009 (registry), ADR-0010 (script execution).

## Interactive TUI (#240)

The plugin ships a tab-placed pane entrypoint plus an `open` action
(`herdr-plugins.tui/v1`; ADR-0031/0032/0033):

```toml
# herdr-plugin.toml (already declared)
[[panes]] id = "main"     placement = "tab"  command = ["bun","run","src/tui.ts","main"]
[[panes]] id = "scripts"  placement = "tab"  command = ["bun","run","src/tui-scripts.ts","main"]
[[actions]] id = "open"         contexts = ["pane","workspace"]  command = ["bun","run","src/tui.ts","open"]
[[actions]] id = "open-scripts" contexts = ["pane","workspace"]  command = ["bun","run","src/tui-scripts.ts","open"]
```

- `open` pins the origin context (workspace/tab/focused pane/cwd) once
  and calls `plugin.pane.open` with `placement = "tab"`, forwarding the
  pins as `HERDR_TUI_*` env vars. `HERDR_PANE_ID` inside the UI is the
  UI pane's own surface identity — never a mutation target.
- The UI consumes this plugin's own CLI (`src/cli.ts`) for every read
  and mutation, so the public contract stays the single source of
  truth and CLI/MCP/GUI behavior cannot drift. Opening performs reads
  only — no lazy trigger drain runs implicitly.
- Surfaces: project list/search (`/` filter), register (path + optional
  title) and discover-from-session flows, per-project detail with live
  `repos list` (branch/dirty/worktrees incl. pane-addressed git
  pointers), repo membership add/remove, settings get/set/unset over
  the allow-listed keys, and scripts list/run/results/stop.
- Every mutation is confirm-gated (exact target + consequence, Esc
  cancels), checked against `capability`/`mutation_commands` (fail
  closed when unavailable), and re-validates the project via `show`
  immediately before writing — a vanished project aborts `stale`, a
  changed `updated_at` asks before applying.
- Non-TTY stdin degrades to a plain-text project list; the non-
  interactive CLI is unchanged.

### Scripts surface (#241)

A second tab-placed entrypoint (`[[panes]] id = "scripts"`, action
`rebuildup.projects.open-scripts`) opens a script-first browser:

- Target picker: any registered project (multi-repo projects get an
  explicit repo pick), a bare **repo path** (works for repos outside the
  registry — e.g. a WSL dev-server checkout), or the unfiltered runs
  list. Repo-path targets resolve `project_id` lazily from
  `scripts list`, so `run` works whenever the repo belongs to a project
  and is honestly disabled otherwise (`scripts run` requires `<project>`).
- Per-target script list (`/` filter): `x` runs the selected script —
  gated by `capability`/`mutation_commands`, confirm dialog shows
  project/script/command/repo, and `--repo` is always passed explicitly.
- `R` opens results (`scripts results [project]`, narrowed client-side
  to the pinned repo); selecting a run shows its record with `s` stop
  (active runs only, danger-confirm, CLI re-validates pane ownership)
  and `l` logs (`scripts logs <run-id>`, bounded tail, paged).
- Active runs render `running`/`stopping`/`stop_unconfirmed` verbatim
  with a note that the durable scrollback marker may finalize the
  result on the next read; `unknown` is shown honestly — never guessed.
- Reads never mutate implicitly: `results`/`logs` (which lazily
  reconcile run records) run only on explicit keys.
- Non-TTY: `bun run src/tui-scripts.ts main [project|repo]` prints a
  plain `scripts list` for the target (or a registry overview without
  one) — the GUI-less path for dev-server operation.

Opt-in keybind (user-owned; plugins never write herdr config):

```toml
[[keys.command]]
key = "prefix+P"
type = "plugin_action"
command = "rebuildup.projects.open"
description = "open projects TUI"
```

```toml
[[keys.command]]
key = "prefix+S"
type = "plugin_action"
command = "rebuildup.projects.open-scripts"
description = "open projects scripts TUI"
```
