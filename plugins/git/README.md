# rebuildup.git

Read-only Git status/diff for herdr panes (`herdr-plugins.git/v1`).

## Install

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/git
```

Prerequisites: herdr ≥ 0.9.0, Bun on `PATH`, `git` on `PATH`.

## Usage

```bash
# from the plugin root (see `herdr plugin list --json` → plugin_root)
bun run src/cli.ts capability
bun run src/cli.ts status <pane_id>
bun run src/cli.ts diff <pane_id> [--staged] [--stat] [rev [rev]]
bun run src/cli.ts project <pane_id>
```

`status` returns repo identity, branch/upstream/ahead-behind, and
file-level change counts. `diff` returns a byte-capped patch (`truncated`
flag when cut). `project` additionally reports `git_branch`,
`git_changes`, and `git_ahead_behind` pane metadata tokens.

Full contract: `docs/contracts/git-v1.md`. Spec: `docs/specs/git.md`.
Design: ADR-0006.

## Notes

- Read-only in v0.1.0: no staging/commit/push (stage 2, Issue #2).
- Remote herdr hosts: run the CLI on the target host (same rule as
  `rebuildup.inbox`).
- Optional `config.json` in the plugin config dir:
  `{"timeoutMs": 10000, "diffMaxBytes": 262144}`.
