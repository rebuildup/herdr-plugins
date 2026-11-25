# Git plugin (`rebuildup.git`) — specification

Stage 1 scope: read-only Git status/diff for herdr panes. Mutation
operations (staging, commit, push, PR) and Checkpoint integration are later
stages tracked by Issue #2 / #4.

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
| `diff` | Patch or `--stat` for worktree, index (`--staged`), or revisions. |
| `project` | Compute `status` for a pane and project pane metadata tokens. |

`status`/`diff`/`project` accept `--session`, `--socket`, `--timeout`
(overrides `config.json` `timeoutMs`, default 10000) and `--max-bytes`
for `diff` (default 262144). All output is a single JSON document; errors
are `{ok:false,error:{code,message}}` on stderr with exit 1 (2 for usage).

## Change accounting

`git status --porcelain=v1` is parsed into counts:

- `staged` — index differs from HEAD (X column set, not `?`/`!`)
- `unstaged` — worktree differs from index (Y column set)
- `untracked` — `??` entries
- `conflicted` — unmerged entries (`U*`/`AA`/`DD`)

Counts are file-level, matching `git status` semantics. Renames count as
one entry.

## Diff bounds

`diff` is bounded: default 256 KiB of patch output, configurable via
`--max-bytes` or `config.json` `diffMaxBytes`. Output that exceeds the cap
is truncated with `"truncated": true` in the result — the client must not
treat truncated output as complete. `GIT_TERMINAL_PROMPT=0` and a hard
timeout prevent credential prompts or hung remotes from blocking; a
`timeout` error is returned instead.

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
{ "timeoutMs": 10000, "diffMaxBytes": 262144 }
```

Unknown keys are ignored; invalid values fall back to defaults.

## Non-goals (stage 1)

- No mutation commands, no hooks that write state, no daemon.
- No parsing of GitHub remotes, PR state, or provider integrations.
- No fabricated status for bare repositories or missing `git` binary —
  both produce structured errors.
