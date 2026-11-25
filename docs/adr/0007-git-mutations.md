# ADR-0007: Git plugin mutations — allow-listed argv writes, no destructive ops

## Status

Accepted (v0.2.0, `rebuildup.git` stage 2, Issue #24 / ticket #37)

## Context

Issue #24 requires local Git operations (stage/unstage/commit/branch/
upstream) on the pane's repository without weakening the stage-1 read
contract or the project invariants: no shell interpolation, no ambient
secret inheritance, no fabricated state, herdr remains the execution
authority.

## Decision

1. **Same spawn path as reads.** Mutations reuse `runGit`/`gitOk` —
   argv spawn, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
   `LC_ALL=C`, hard timeout. Non-zero exits (including hook failures)
   surface as `git_error` carrying stderr; there is no partial-success
   reporting.
2. **Explicit allow-list only.** Commands map to a fixed set of git
   argv shapes: `add`, `reset -q`, `restore --staged`, `commit -m`,
   `switch`/`branch`, `branch --set-upstream-to`. Destructive or
   history-rewriting operations (`reset --hard`, `clean`, `checkout --`,
   force push, branch delete) are not exposed at all.
3. **Input validation before spawn.** Pathspecs, branch names, and
   upstream refs that are empty or `-`-prefixed are rejected; pathspecs
   go after `--`. Commit messages are `-m` argv values (repeatable for
   paragraphs) — never shell text.
4. **Identity is never fabricated.** Commit author/committer come from
   the repository/global git config on the herdr host; the plugin does
   not inject `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
5. **No manifest actions for mutations.** They require explicit
   arguments (paths, messages, names), so they are CLI/agent-invoked
   only; `capability` advertises `read_only: false` and a
   `mutation_commands` list so clients can feature-detect.
6. **Contract stays `herdr-plugins.git/v1`.** Mutations are additive
   commands; every read command's output is unchanged. `read_only`
   flips to `false`, which is itself the feature-detection signal.

## Consequences

- A misused mutation fails loudly with git's own error rather than
  producing ambiguous state; callers can retry or inspect `status`.
- Hooks (pre-commit etc.) run inside the same timeout budget; clients
  needing longer passes can raise `--timeout`.
- Worktree lifecycle stays with herdr/Worktrunk — `branch switch`
  operates on the pane's checkout only and never creates worktrees.
- If a future stage needs force-push or history edits, that is a new
  ADR and likely a contract bump, not a flag on these commands.
