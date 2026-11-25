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
bun run src/cli.ts log <pane_id> [--limit N] [--skip N] [--all]
    [--first-parent] [--author X] [--grep X] [--since X] [--until X]
    [--path PATH]...
bun run src/cli.ts compare <pane_id> [base [head]] [--max-bytes N]
bun run src/cli.ts stage <pane_id> [--all | --path PATH]...
bun run src/cli.ts unstage <pane_id> [--all | --path PATH]...
bun run src/cli.ts commit <pane_id> -m MSG [-m MSG]... [--allow-empty]
bun run src/cli.ts branch create <pane_id> <name> [--switch]
bun run src/cli.ts branch switch <pane_id> <name>
bun run src/cli.ts upstream <pane_id> <upstream-ref>
bun run src/cli.ts fetch <pane_id> [remote] [--prune]
bun run src/cli.ts push <pane_id> [--set-upstream] [--force-with-lease]
    [remote] [refspec]
bun run src/cli.ts remote <pane_id>
bun run src/cli.ts pr list|status|create|view <pane_id> [--repo owner/name]
    pr create: --title T [--body B | --body-file PATH|-] [--draft]
        [--base B] [--head B]
bun run src/cli.ts project <pane_id>
```

`status` returns repo identity, branch/upstream/ahead-behind, and
file-level change counts. `files` returns the structured per-file change
list (staged/unstaged/untracked/conflicted, renames, binary flags).
`diff` returns a byte-capped patch or machine-readable `--stat`,
`--name-status`, or `--numstat` output (`truncated` flag when cut),
optionally limited by `--path` pathspecs and revisions. `log` returns
structured commit history (sha/parents/author/committer/subject) with
`--limit`/`--skip` paging and `has_more`. `compare` diffs a revision range
against its merge-base — defaulting to the branch's upstream — returning
changed files, stat, ahead/behind, and a bounded patch. Mutation
commands (`stage`, `unstage`, `commit`, `branch`, `upstream`, `fetch`,
`push`) apply allow-listed local git operations; `remote` lists
remotes with credentials stripped from URLs; `pr` exposes GitHub pull
requests through the host's `gh` CLI (requires `gh` ≥ 2.81.0 and
`gh auth login`; see ADR-0007/0008). `project`
additionally reports `git_branch`, `git_changes`, and `git_ahead_behind`
pane metadata tokens.

Full contract: `docs/contracts/git-v1.md`. Spec: `docs/specs/git.md`.
Design: ADR-0006/0007/0008.

## Notes

- v0.2.0 adds local mutations (stage/commit/branch/upstream), remote
  operations (fetch/push/remote list), and the GitHub PR foundation
  (`pr` via `gh`). Merge/review/CI-log and non-GitHub forges are later
  tickets. No destructive git operations are exposed (ADR-0007); force
  push requires the explicit `--force-with-lease` flag.
- Remote herdr hosts: run the CLI on the target host (same rule as
  `rebuildup.inbox`).
- Optional `config.json` in the plugin config dir:
  `{"timeoutMs": 10000, "remoteTimeoutMs": 60000, "diffMaxBytes": 262144}`.
