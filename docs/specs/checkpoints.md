# Checkpoints plugin (`rebuildup.checkpoints`) — specification

Scope: T1 foundation (#72) — hidden-ref capture/list/show/diff/delete.
Contract: `herdr-plugins.checkpoints/v1`
(`docs/contracts/checkpoints-v1.md`). Design: ADR-0011. Upstream
semantics reference: T3 Code `GitVcsDriver.captureCheckpoint` +
`CheckpointService` ref naming (pinned revision in
`docs/program/feature-ledger.json`).

## Purpose

Give agents and users a safe way to snapshot "the worktree as it is
now" — tracked modifications, staged content, and untracked files —
without committing, without touching the user's index/staging, and
without a daemon. Later tickets add restore (#73), turn-boundary
auto-capture (#74), and multi-repo/GC (#75).

## Capture procedure

For a resolved non-bare repo with at least one commit:

1. Resolve repo via shared `packages/git-core` (`rev-parse
   --show-toplevel`, `--absolute-git-dir`, `--git-common-dir`); canonical
   root = `realpath(toplevel)`.
2. Refuse `core.sparseCheckout=true` (`sparse_checkout`) — a fresh
   scratch index cannot represent skip-worktree bits, so `add -A`
   would stage phantom deletions.
3. Scratch index at `<git-common-dir>/herdr-checkpoint-index-<uuid>`
   via `GIT_INDEX_FILE`; `INDEX_CONFIG` disables fsmonitor/split-index
   side effects (mirrors upstream's capture preamble).
4. `git read-tree HEAD` → `git -c core.safecrlf=false add -A -- .` →
   `git write-tree`. `.gitignore` is respected; the user's real index
   is never opened for write.
5. Gitlink paths are collected from the scratch index (`ls-files -s -z`,
   mode `160000`) for the record-and-warn `submodules` field.
6. `git commit-tree <tree> -p <head> -m "herdr checkpoint <id>"` with
   fixed identity `herdr checkpoints <checkpoints@herdr-plugins.invalid>`
   (upstream uses the same approach — the host's `user.*` config may be
   absent and must not be required).
7. `git update-ref refs/herdr-plugins/checkpoints/<repo-key>/<id>
   <commit>`; scratch index + `.lock` removed in `finally`.
8. Bounded `git diff --name-status <head> <commit>` (32 KiB cap) stored
   as `files_summary`.

Objects are written to the repository's **shared object store** — the
simplified v1 choice; upstream's private `GIT_OBJECT_DIRECTORY` +
`GIT_QUARANTINE_PATH` isolation is deferred hardening (ADR-0011).

## Ref namespace

`refs/herdr-plugins/checkpoints/<repo-key>/<id>`

- `repo-key` = `sha256(realpath(repo_root))[:16]` — deterministic,
  filesystem-safe, collision-resistant enough for a per-user namespace.
- These refs are visible to `git log --all`, `git for-each-ref`, and
  ref-aware UIs. They do **not** match default push refspecs
  (`+refs/heads/*:refs/heads/*`), so `git push` never leaks them;
  explicit `push <remote> 'refs/herdr-plugins/*'` would, which is
  accepted for v1 (documented, not blocked).
- Worktrees of one repository share the object store but get distinct
  `repo-key`s (roots differ), so checkpoint namespaces never collide.

## State

`HERDR_PLUGIN_STATE_DIR/state.json` —
`{version:1, checkpoints:{id:entry}}`, single-writer lock file +
tmp+rename, identical discipline to `rebuildup.projects`. The file is
only an index (id → ref/commit/repo metadata); payloads live in each
repo's object store.

Entry: `id, repo_root, repo_key, ref, commit, head_sha, branch,
created_at, label?, files_summary?, files_summary_truncated?,
submodules?`.

## Commands

See contract doc. Highlights:

- `create [--repo PATH | <pane>] [--label]` — pane resolution is the
  `rebuildup.git` path (snapshot → pane cwd → `resolveRepo`).
- `list [--repo] [--limit]` — state index only; no git calls.
- `show <id>` — state entry + live bounded `git show --stat`;
  `ref.exists:false` reports out-of-band deletion honestly.
- `diff <id|HEAD> <id|HEAD>` — bounded `git diff` between resolved
  refs; `cross_repo` when checkpoint sides differ.
- `delete <id>` — `update-ref -d` when the ref exists + state removal;
  already-gone ref or unreachable repo still removes the state entry
  (`ref_existed:false` + warning) — idempotent cleanup.

## Error taxonomy

`not_a_repo`, `bare_repo`, `empty_repo` (unborn HEAD),
`sparse_checkout`, `unknown_checkpoint`, `cross_repo`,
`pane_not_found`, `no_pane_cwd`, plus shared `git_missing` / `timeout` /
`git_error`. Unsupported conditions are structured errors, never
success-shaped output.

## v1 limits (explicit)

- Unborn HEAD → `empty_repo` (no root commit to parent to).
- Sparse checkout → `sparse_checkout` error.
- Submodules: only the gitlink (recorded submodule HEAD) is captured;
  submodule *worktree* contents are not. `submodules[]` + CLI warning
  make this visible. Nested-repo capture semantics deferred.
- `git add -A` rehashes the full worktree through the scratch index —
  O(repo size); upstream's user-index stat-cache reuse is deferred.
- No restore (#73), no auto-capture on turn boundaries (#74), no
  multi-repo session grouping or GC (#75).
- Checkpoint commits/objects are unreachable from branches; `git gc`
  may eventually prune them — GC policy is #75's problem.
