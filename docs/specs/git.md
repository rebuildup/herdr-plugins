# Git plugin (`rebuildup.git`) — specification

Stage 1 scope: read-only Git status/diff for herdr panes, extended in
v0.2.0 with a structured per-file change list (`files`),
pathspec-limited and machine-readable diffs, commit history (`log`),
and merge-base branch comparison (`compare`). Local mutation commands
(`stage`, `unstage`, `commit`, `branch`, `upstream`), remote
operations (`fetch`, `push`, `remote` list), and the GitHub PR surface
(`pr list|status|create|view` via the host `gh` CLI) landed in v0.2.0.
v0.3.0 extends the PR surface with read-only review/check/log access
(`pr reviews|comments|checks|logs`). v0.4.0 adds forge review/comment
mutations (`pr review|comment|reply|reviewers`) behind a mandatory
`--expect-head` stale-head guard. Merge/auto-merge and non-GitHub
forges are later tickets. Checkpoint integration is Issue #4.

## Purpose

Expose the Git state of the repository a pane is working in, so the TUI,
CLI, agents, and external clients (herdr-t3) can answer "what branch is
this pane on, and is the worktree dirty?" without leaving herdr.

herdr remains the authority for panes and workspaces. This plugin never
creates, moves, or deletes worktrees; local git mutations and forge
writes are limited to the explicit allow-listed commands below and are
invoked only on user/agent request.

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
- **Target isolation (issue #83):** socket targeting and ambient pane
  identity follow the same `resolveTarget` rules as `rebuildup.inbox`
  (explicit flags beat ambient `HERDR_*`; contradictions fail closed;
  mutating commands require an explicit/ambient target; ambient
  workspace/tab ids are verified against the target session's snapshot).
- **Child env hygiene (issue #96):** every `git`/`gh` spawn runs with a
  sanitized environment (`src/git-env.ts`) that strips ambient
  repo/index/object/config-redirecting `GIT_*` variables
  (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/
  `GIT_CONFIG_VALUE_*`, etc.) and `gh` targeting vars (`GH_REPO`,
  `GH_DEBUG`, `GH_FORCE_TTY`, `GH_PAGER`), while preserving user-level
  config selection, commit identity, and auth/transport variables. The
  plugin's own pins (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
  `LC_ALL=C`, `GH_PROMPT_DISABLED=1`) are applied after stripping.

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
| `pr` | GitHub PR surface via host `gh`: `list` / `status` / `create` / `view` / `reviews` / `comments` / `checks` / `logs`. |
| `project` | Compute `status` for a pane and project pane metadata tokens. |

All commands accept `--session`, `--socket`, `--timeout` (overrides
`config.json` `timeoutMs`, default 10000); `fetch`/`push` additionally
honor `--timeout` but default to `remoteTimeoutMs` (60000) because they
are network-bound; `diff`/`compare` accept
`--max-bytes` (default 262144, `config.json` `diffMaxBytes`).
`files`/`diff`/`log` accept repeatable `--path <pathspec>` values, passed
to git after `--`; values starting with `-` are rejected. All output is a
single JSON document; errors are `{ok:false,error:{code,message}}` on
stderr.

**Exit-code contract:** `0` success, `1` handled runtime/environment
failure (git missing/error/timeout, not-a-repo, pane lookup, gh
auth/transport failures, `target_conflict`/`target_required`/
`ambient_identity_mismatch`), `2` usage error (`error.code == "usage"`
or `invalid_session`).
Argument problems — unknown options, missing required arguments,
conflicting flags, invalid flag values, extra positionals — are always
exit 2 and are validated before any socket/git/gh access. Option
parsing is strict: each command whitelists its flags (per-action for
`pr`), rejects `--flag=value` on boolean flags, supports `--name=value`
for value flags, honors a `--` end-of-options separator, and validates
the global `--session`/`--socket`/`--timeout` flags the same way.

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

## Forge: GitHub PR via `gh` (ADR-0008)

`pr <action> <pane_id>` exposes GitHub pull requests through the host's
`gh` CLI — the plugin never handles tokens and never implements a forge
client. Repo resolution is `gh repo view` inside the pane's repo root
(user remotes, `GH_HOST`/GHES, and `gh auth` accounts apply);
`--repo owner/name` overrides and is validated before any call.

- Preflight: `gh --version` must be ≥ 2.81.0 and `gh auth status` must
  succeed; failures are structured `gh_missing`/`gh_error`, never empty
  success payloads.
- `pr list` — fixed `--json` field set with `--limit` (1–1000),
  `--state open|closed|merged|all` (default `open`), `--head`.
- `pr status` — open PR for the pane's current branch (detached HEAD →
  `detached:true, pr:null`; no PR → `pr:null`).
- `pr view <number>` — bounded projection: body ≤ 8000 chars
  (`body_truncated`), last 10 reviews only, ≤ 50 check entries
  (`checks_truncated`).
- `pr create` — requires `--title`; body via `--body` or
  `--body-file PATH`/`-` (stdin) so long bodies stay out of argv.
  `--draft`/`--base`/`--head` pass through. The branch must already be
  pushed; gh's interactive push/prompt flow is never driven
  (`GH_PROMPT_DISABLED=1`, stdin closed immediately).
- `pr reviews <n>` — submitted reviews (state/author/body ≤4000 chars/
  submitted_at/commit_id) newest-50 capped, plus `review_requests`
  (requested reviewer logins, team names) from `GET pulls/{n}` and
  `GET pulls/{n}/reviews`.
- `pr comments <n>` — issue comments (`issues/{n}/comments`) and line
  review comments (`pulls/{n}/comments`: path/line/side/`in_reply_to_id`/
  bounded `diff_hunk`), each newest-50 capped with independent
  `*_truncated` flags.
- `pr checks <n>` — `gh pr checks --json` per-check detail (name,
  bucket/state, workflow, link, description, event, timings), capped at
  100. Pending/failed checks are data; "no checks reported" maps to an
  empty list.
- `pr logs <n>` — Actions reads: default lists workflow runs for the
  PR head sha (`gh run list --commit`, ≤20); `--run ID` lists that
  run's jobs (≤50); `--job ID [--lines N]` returns a bounded log tail
  (default 200 lines / 2000 max / 256 KiB hard cap) with `truncated`.
- All `gh` calls are argv spawn under `remoteTimeoutMs` (default 60s);
  error messages echo subcommand words only, never argv content.
- Every review/check/log payload echoes `head`/`base` `{ref, sha}` (and
  `head_sha` for logs) so callers can pin mutations to a known head.
- Forge mutations (v0.4.0, Issue #172): `pr review` submits
  APPROVE/REQUEST_CHANGES/COMMENT via `POST pulls/{n}/reviews` —
  including optional line comments from `--comments-file` (JSON array
  of `{path, line, side?, body}`) since `gh pr review` cannot express
  them; `pr comment` posts a conversation comment via
  `POST issues/{n}/comments`; `pr reply` answers a review thread via
  `POST pulls/{n}/comments/{id}/replies`; `pr reviewers` maps to
  `gh pr edit --add-reviewer/--remove-reviewer`. All mutation payloads
  go through `gh api --input -` (stdin) or plain argv flags — bodies
  never appear in gh argv.
- **Stale-head guard (mandatory):** every forge mutation requires
  `--expect-head <full sha>`; the plugin re-fetches the PR head
  immediately before writing and refuses with `kind: "stale_head"` on
  mismatch. Reviews additionally pin `commit_id` to that sha.
- **Release boundary:** mutations are explicit invocations only — no
  automation path submits reviews, posts comments, requests reviewers,
  merges, or auto-merges. The plugin never approves its own release PR
  or merges `release-* -> main`; that stays a maintainer decision
  (github-delivery skill).
- The plugin exposes PR state but never acts on merge/review gates;
  merge/auto-merge, editing or deleting existing reviews/comments,
  `pr checkout`/worktree creation (herdr/Worktrunk lifecycle
  responsibility — reference only), and non-GitHub forges are out of
  scope.

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
- No PR merge/auto-merge operations, no editing/deleting existing
  reviews or comments, and no non-GitHub forge integrations (the
  `gh`-CLI PR surface covers list/status/create/view plus read-only
  reviews/comments/checks/logs and explicit review/comment/reviewer
  mutations behind `--expect-head`; upstream `source-control.md`'s
  wider surface — auto-merge, GitLab/Forgejo/Gitea/Bitbucket/Azure
  DevOps/GitCafe/Cursor Origin — is tracked in the feature ledger for
  later trains).
- No destructive git operations (see Local mutations).
- No parsing of GitHub remotes beyond what `gh`/git provide, no provider
  integrations.
- No fabricated status for bare repositories or missing `git` binary —
  both produce structured errors.
