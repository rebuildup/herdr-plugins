# rebuildup.git

Git status/diff for herdr panes (`herdr-plugins.git/v1`).

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
bun run src/cli.ts files <pane_id> [--path PATH]...
bun run src/cli.ts diff <pane_id> [--staged] [--stat|--name-status|--numstat]
    [--path PATH]... [--max-bytes N] [rev [rev]]
bun run src/cli.ts project <pane_id>
```

`status` returns repo identity, branch/upstream/ahead-behind, and
file-level change counts. `files` returns the structured per-file change
list (staged/unstaged/untracked/conflicted, renames, binary flags).
`diff` returns a byte-capped patch or machine-readable `--stat`,
`--name-status`, or `--numstat` output (`truncated` flag when cut),
optionally limited by `--path` pathspecs and revisions. `project`
additionally reports `git_branch`, `git_changes`, and `git_ahead_behind`
pane metadata tokens.

Full contract: `docs/contracts/git-v1.md`. Spec: `docs/specs/git.md`.
Design: ADR-0006.

## Notes

- Read-only in v0.2.0: no staging/commit/push (later stages, Issue #2).
- Remote herdr hosts: run the CLI on the target host (same rule as
  `rebuildup.inbox`).
- Optional `config.json` in the plugin config dir:
  `{"timeoutMs": 10000, "diffMaxBytes": 262144}`.
