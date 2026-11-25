# Git plugin (`rebuildup.git`) — specification

Stage 1 scope: read-only Git status/diff for herdr panes, extended in
v0.2.0 with a structured per-file change list (`files`),
pathspec-limited and machine-readable diffs, commit history (`log`),
and merge-base branch comparison (`compare`). Local mutation commands
(`stage`, `unstage`, `commit`, `branch`, `upstream`) and remote
operations (`fetch`, `push`, `remote` list) landed in v0.2.0; PR
integration is #39. Checkpoint integration is Issue #4.

## Purpose

Expose the Git state of the repository a pane is working in, so the TUI,
CLI, agents, and external clients (herdr-t3) can answer "what branch is
this pane on, and is the worktree dirty?" without leaving herdr.

herdr remains the authority for panes and workspaces. This plugin never
creates, moves, or deletes worktrees and never mutates the repository; it
only runs read-only `git` commands and projects display metadata.

## Identity and resolution

- Target is a **pane** (`pane_id` argument, `HERDR_PANE_ID`, or plugin
  action context `focused_pane_id`), same convention as `rebuildup.inbox`.
- The pane's `cwd` comes from `session.snapshot` (herdr is the source of
  truth for where the pane lives).
- Repo resolution runs `git -C <cwd> rev-parse` inside the pane's
  directory. Panes inside a linked worktree resolve to that worktree's
  root (`--show-toplevel`), which is the correct unit for status/diff.
- A pane whose cwd is not inside a work tree is a structured
  `not_a_repo` result, never a fabricated empty status.

## Commands (contract `herdr-plugins.git/v1`)

| Command | Description |
| --- | --- |
| `capability` | Contract/plugin/command discovery. |
| `status` | Repo identity + branch/upstream/ahead-behind + change counts. |
| `files` | Structured per-file change list (porcelain `-z`). |
| `diff` | Patch, `--stat`, `--name-status`, or `--numstat` for worktree, index (`--staged`), or revisions; `--path` pathspec filter. |
| `log` | Structured commit history with filters and paging. |
| `compare` | Merge-base diff between two revisions (default: HEAD vs upstream). |
| `stage` | `git add` for `--all` or `--path` pathspecs. |
| `unstage` | Unstage `--all` or `--path` pathspecs (`git reset`/`restore --staged`). |
| `commit` | `git commit -m` (repeatable), `--allow-empty` opt-in. |
| `branch` | `create <name> [--switch]` / `switch <name>`. |
| `upstream` | `git branch --set-upstream-to <ref>`. |
| `fetch` | `git fetch [remote] [--prune]`; longer `remoteTimeoutMs` budget. |
| `push` | `git push [--set-upstream] [--force-with-lease] [remote] [refspec]`; plain `--force` is never exposed. |
| `remote` | Read-only remote list; URLs are reported with embedded credentials stripped. |
| `project` | Compute `status` for a pane and project pane metadata tokens. |

All commands accept `--session`, `--socket`, `--timeout` (overrides
`config.json` `timeoutMs`, default 10000); `fetch`/`push` additionally
honor `--timeout` but default to `remoteTimeoutMs` (60000) because they
are network-bound; `diff`/`compare` accept
`--max-bytes` (default 262144, `config.json` `diffMaxBytes`).
`files`/`diff`/`log` accept repeatable `--path <pathspec>` values, passed
to git after `--`; values starting with `-` are rejected. All output is a
single JSON document; errors are `{ok:false,error:{code,message}}` on
stderr with exit 1 (2 for usage).

## Change accounting

`git status --porcelain=v1` is parsed into counts:

- `staged` — index differs from HEAD (X column set, not `?`/`!`)
- `unstaged` — worktree differs from index (Y column set)
- `untracked` — `??` entries
- `conflicted` — unmerged entries (`U*`/`AA`/`DD`)

Counts are file-level, matching `git status` semantics. Renames count as
one entry.

## File-level changes (`files`)

`files` runs `git status --porcelain=v1 -z` so paths are unquoted and
NUL-delimited — special characters (spaces, quotes, non-ASCII, newlines)
survive verbatim. Each entry carries:

| Field | Meaning |
| --- | --- |
| `path` | Repo-relative path (destination side for renames/copies). |
| `old_path` | Source path for `R`/`C` entries, else `null`. |
| `index` / `worktree` | Raw porcelain X/Y status columns. |
| `kind` | `added`/`modified`/`deleted`/`renamed`/`copied`/`typechange`/`untracked`/`conflicted`/`ignored`. |
| `staged` / `unstaged` | Whether the index/worktree side differs from its base. |
| `binary` | From `git diff --numstat` on both sides; `null` for untracked/conflicted/ignored where binary detection is not meaningful. |

`--path` pathspecs filter the status output (`git status -- <path>...`).
Binary detection is repo-wide (numstat is not pathspec-scoped) but only
annotates listed files.

## Diff bounds

`diff` is bounded: default 256 KiB of output, configurable via
`--max-bytes` or `config.json` `diffMaxBytes`. Output that exceeds the cap
is truncated with `"truncated": true` in the result — the client must not
treat truncated output as complete. `GIT_TERMINAL_PROMPT=0` and a hard
timeout prevent credential prompts or hung remotes from blocking; a
`timeout` error is returned instead.

Output formats (exactly one per invocation):

- patch (default) — `git diff` unified patch.
- `--stat` — `git diff --stat` summary.
- `--name-status` — `git diff --name-status -z`; status letter and paths
  are NUL-separated so unusual paths are unquoted.
- `--numstat` — `git diff --numstat -z`; added/deleted counts per path,
  `-` for binary, NUL-delimited.

`--path <pathspec>` (repeatable) appends `-- <path>...` to the git
invocation, combining freely with `--staged` and revisions. Revisions
remain positional argv elements; option-like values are rejected.

## Commit history (`log`)

`log` runs `git log` with a NUL/record-separated custom format and returns
structured commits: `sha`, `parents[]`, `author`/`committer`
(`name`/`email`/ISO-8601 `date`), and `subject`. Filters map to git
options: `--all`, `--first-parent`, `--author`, `--grep`, `--since`,
`--until`, and `--path` pathspecs. Paging is `--limit` (default 50, max
1000) plus `--skip`; the result reports `has_more` by fetching one extra
commit. There is no arbitrary revision-range argument in v1 — use
`compare` for branch diffs.

## Branch comparison (`compare`)

`compare [base [head]]` diffs `head` against the **merge-base** of `base`
and `head` (three-dot semantics, matching "what did this branch change").
With no arguments, `base` is the current branch's upstream and `head` is
`HEAD`; a missing upstream is a structured `git_error`, not an empty
diff. The result carries `merge_base`, `ahead`/`behind` (head-only vs
base-only commit counts), the changed-file list (`--name-status -z`
parsed: `status`/`path`/`old_path`), `stat`, and a byte-capped `patch`
with `patch_truncated`/`patch_bytes`.

## Local and remote mutations

`stage`, `unstage`, `commit`, `branch`, `upstream`, `fetch`, and `push`
mutate the index, refs, remote-tracking refs, or the configured remote
of the pane's repository on the herdr host. They share the same
target resolution, timeout policy, and env hygiene as reads; there is
still no daemon and no shell interpolation — every git invocation is
argv spawn.

Rules:

- Pathspecs and names are argv elements after `--` where applicable;
  empty or `-`-prefixed values are rejected before spawn.
- `stage`/`unstage` require `--all` or at least one `--path`; bare
  invocation is a usage error, never an accidental whole-repo write.
- `commit` requires at least one `-m`; `--allow-empty` is explicit-only.
  Author/committer identity comes from the repo/global git config — the
  plugin never fabricates one.
- `fetch` accepts at most one remote positional plus `--prune`;
  `push` accepts at most remote + refspec positionals plus
  `--set-upstream`/`--force-with-lease`. With no positionals, `push`
  defers to the branch's configured upstream and fails structurally
  when none exists.
- Force push exists only as `--force-with-lease` (lease-checked against
  the remote-tracking ref); plain `--force` is never exposed.
- `remote` is read-only: it reports `name`, `url`, and `pushUrl` with
  any URL userinfo (embedded credentials/tokens) stripped.
- No destructive operations exist: no `reset --hard`, `checkout -- .`,
  `clean`, plain force push, or branch delete.
- Failures (hooks, conflicts, missing upstream, nothing to commit,
  non-fast-forward rejections) are structured `git_error` results
  carrying git's stderr; partial success is reported as failure.
- `GIT_TERMINAL_PROMPT=0` prevents credential prompts; `fetch`/`push`
  use the longer `remoteTimeoutMs` budget (default 60s).
- Mutations are not exposed as manifest actions — they require explicit
  arguments and are invoked via CLI/agents. `capability` reports
  `read_only: false` plus a `mutation_commands` list.

## Metadata projection

`project` reports pane metadata tokens (display-only, herdr-owned
transport):

| Token | Value |
| --- | --- |
| `git_branch` | short branch name, `HEAD` when detached, cleared when not a repo |
| `git_changes` | total changed-file count as a string, `0` when clean, cleared when not a repo |
| `git_ahead_behind` | `+A/-B` vs upstream when known, else cleared |

Projection is on-demand: `project` is invoked by clients (TUI keybind,
herdr-t3, agents). There is no event hook in stage 1 because Git state
does not correlate with herdr agent-status events, and polling would
violate the no-daemon/no-high-frequency-polling constraint. Stage 2 may
add opt-in `watch`-style refresh.

## Config

`config.json` in the plugin config dir (optional):

```json
{ "timeoutMs": 10000, "remoteTimeoutMs": 60000, "diffMaxBytes": 262144 }
```

Unknown keys are ignored; invalid values fall back to defaults.

## Non-goals

- No daemon, no hooks that write plugin state, no polling.
- No PR writes or forge integrations (ticket #39 covers GitHub PR
  read/create via `gh`).
- No destructive git operations (see Local mutations).
- No parsing of GitHub remotes beyond what `gh`/git provide, no provider
  integrations.
- No fabricated status for bare repositories or missing `git` binary —
  both produce structured errors.
