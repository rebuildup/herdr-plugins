# rebuildup.projects

Project registry for herdr panes (`herdr-plugins.projects/v1`).

## Install

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/projects
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
bun run src/cli.ts scripts run <project> <name> [--repo PATH]
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
run records. Multi-repo projects require `--repo` for `run`. Script
commands are trusted repo content executed with user privileges.
`t3.json` scripts flagged `runOnWorktreeCreate` auto-run via the
`worktree.created` hook event: the hook records a pending mark and the
next `scripts tick` (or `scripts run|stop|results|logs`) drains it —
repo membership is verified by `git-common-dir`, skips are reported in
the payload's `triggers` block, and runs carry
`trigger:{kind:"worktree.created", worktree_path}`. `runOnSettle`/
`stopOnSettle` are not implemented — see docs/specs/projects.md.

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
