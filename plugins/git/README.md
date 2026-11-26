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
bun run src/cli.ts pr list|status|create|view|reviews|comments|checks|logs
    <pane_id> [--repo owner/name]
    pr create: --title T [--body B | --body-file PATH|-] [--draft]
        [--base B] [--head B]
    pr reviews|comments|checks <pane> <number>
    pr logs <pane> <number> [--run ID | --job ID [--lines N]]
bun run src/cli.ts pr review|comment|reply|reviewers|merge <pane_id> [args]
    [--repo owner/name] --expect-head <full-sha>   (required)
    pr review <pane> <number> --approve|--request-changes|--comment
        [--body B | --body-file PATH|-]
        [--comments-file PATH|-]
    pr comment <pane> <number> --body B|--body-file PATH|-
    pr reply <pane> <number> <comment-id> --body B|--body-file PATH|-
    pr reviewers <pane> <number>
        [--add-reviewer LOGIN[,LOGIN]...] [--remove-reviewer LOGIN...]
    pr merge <pane> <number> [--squash|--merge|--rebase]
        [--auto | --disable-auto]
bun run src/cli.ts issue list|view|create|edit|comment|close
    <pane_id> [args] [--repo owner/name]
    issue list: [--limit N] [--state open|closed|all]
        [--label L]... [--assignee U]... [--author U]
    issue view <pane> <number>
    issue edit <pane> <number> [--title T] [--body B | --body-file P|-]
        [--add-label L]... [--remove-label L]... [--add-assignee U]...
        [--remove-assignee U]... [--state open|closed]
    issue comment <pane> <number> --body B|--body-file PATH|-
    issue close <pane> <number> [--reason completed|"not planned"]
bun run src/cli.ts issue link|unlink|links <pane_id> [args]
    issue link <pane> <owner>/<repo>#<n> [--verify]
    issue unlink <pane> <owner>/<repo>#<n>
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
`gh auth login`; see ADR-0007/0008) — `list`/`status`/`create`/`view`
plus read-only `reviews` (submitted reviews + review requests),
`comments` (issue + line comments), `checks` (per-check CI detail), and
`logs` (workflow runs / job list / bounded job-log tail). `pr review`
submits APPROVE/REQUEST_CHANGES/COMMENT reviews — with optional line
comments via `--comments-file` — `pr comment` posts conversation
comments, `pr reply` answers review threads, and `pr reviewers`
requests/dismisses reviewers (`gh pr edit`). `pr merge` performs an
immediate merge (`--squash|--merge|--rebase`), arms GitHub auto-merge
(`--auto`, method flag required), or disarms it (`--disable-auto`).
Every forge mutation requires `--expect-head <full sha>` (the
`head.sha`/`headRefOid` from a prior read); the plugin re-fetches the
PR head and refuses with `stale_head` when it moved. `pr merge`
additionally re-verifies `mergeStateStatus`/`reviewDecision`/`isDraft`
immediately before writing — non-mergeable states fail with
`merge_blocked`, and PRs whose head branch is a release train
(`release-x-y-z`) are refused with `release_boundary` so release
approval stays a maintainer decision (ADR-0030).
`issue` exposes GitHub issues through the same `gh` path —
`list`/`view`/`create`/`edit`/`comment`/`close` with the same repo
resolution, bounded reads, and never-in-argv body discipline. Issues
have no head sha, so there is no `--expect-head` analog: forge
mutations are gated by the mutation target-resolution rule and always
echo the re-fetched post-mutation state. `issue link`/`unlink`/`links`
delegate to `rebuildup.inbox` (ADR-0013 sibling-plugin resolution,
`inboxPluginRoot` config override) — the git plugin keeps no link state;
staleness follows inbox-v1 rules verbatim.
`project` additionally reports `git_branch`, `git_changes`, and
`git_ahead_behind` pane metadata tokens.

Full contract: `docs/contracts/git-v1.md`. Spec: `docs/specs/git.md`.
Design: ADR-0006/0007/0008/0030.

## Interactive TUI

`rebuildup.git` also ships an interactive terminal surface per
`docs/contracts/tui-v1.md` (issue #238): manifest pane entrypoint `main`
(`placement = "tab"`) plus the `open` action, which opens the UI for the
focused pane's repository via `herdr plugin pane open`. The UI covers
status, changed files with per-file stage/unstage/diff, a paged
diff viewer, commit history + per-commit show, branch comparison,
branch operations, fetch/push, and remote listing. The target repo/HEAD
is pinned at launch and revalidated before every mutation; commit, push,
bulk stage/unstage, and branch switches require in-TUI confirmation.
Forge (PR/Issue) workflows stay CLI-only for now (#239).

```toml
# opt-in keybind (user-owned; plugins never write herdr config)
[[keys.command]]
key = "prefix+g"
type = "plugin_action"
command = "rebuildup.git.open"
description = "open git TUI"
```

For a repo checkout without herdr: `bun run src/tui.ts --cwd <path>`.
Non-interactive use is unchanged — `src/cli.ts` remains the CLI/MCP/GUI
contract surface.

## Notes

- v0.2.0 adds local mutations (stage/commit/branch/upstream), remote
  operations (fetch/push/remote list), and the GitHub PR foundation
  (`pr` via `gh`). v0.3.0 adds read-only PR review/check/log access
  (`pr reviews|comments|checks|logs`). v0.4.0 adds forge review/comment
  mutations (`pr review|comment|reply|reviewers`) behind the mandatory
  `--expect-head` stale-head guard — explicit invocations only; the
  plugin never approves its own release PR or merges release branches.
  v0.5.0 adds `pr merge`
  (immediate merge / auto-merge enable / disable) with merge-state
  re-verification and a hard refusal on release-train head branches —
  release approval stays a maintainer decision. Merge-queue
  manipulation, GitHub stack merges, and non-GitHub forges are later
  tickets. No destructive git operations are exposed (ADR-0007);
  force push requires the explicit `--force-with-lease` flag.
  v0.6.0 adds the GitHub issue surface (`issue list|view|create|edit|
  comment|close` via `gh`) and pane↔issue links (`issue link|unlink|
  links`) delegated to `rebuildup.inbox` — inbox owns the link store
  and its staleness/retention rules; this plugin stores no link state.
- Remote herdr hosts: run the CLI on the target host (same rule as
  `rebuildup.inbox`).
- Optional `config.json` in the plugin config dir:
  `{"timeoutMs": 10000, "remoteTimeoutMs": 60000, "diffMaxBytes": 262144,
  "inboxPluginRoot": "/path/to/plugins/inbox"}` — `inboxPluginRoot`
  overrides sibling-plugin resolution for `issue link|unlink|links`
  (default: `../inbox`, then `herdr plugin list --json`).
