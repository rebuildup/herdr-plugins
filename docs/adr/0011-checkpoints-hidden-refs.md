# ADR-0011: Checkpoints as hidden refs with temp-index capture

Status: Accepted (release-0-4-0 candidate, Issue #72 / parent #4 T1)

## Context

Upstream T3 Code checkpoints (`apps/server/src/vcs/GitVcsDriver.ts`
`captureCheckpoint`, ~lines 1113–1700;
`apps/server/src/orchestration-v2/CheckpointService.ts` ref naming)
snapshot a worktree — tracked changes, staged content, untracked files —
into a synthetic commit under `refs/t3/orchestration-v2/checkpoints/…`
so turns can diff and restore later. Issue #4 decomposes this into
plugin tickets; #72 is the T1 foundation: capture / list / show / diff
/ delete only (restore #73, auto-capture #74, multi-repo+GC #75).

The upstream capture is heavily hardened: private
`GIT_OBJECT_DIRECTORY` + `GIT_QUARANTINE_PATH`, user-index stat-cache
reuse with racy-timestamp handling, sparse-checkout index rebuilds,
fsmonitor/split-index guards, submodule fan-out, and HEAD-move
reflog tracking for turn boundaries. Most of that exists to serve
turn-boundary correctness and hostile-worktree edge cases that T1 does
not yet have.

## Decision

**New plugin `rebuildup.checkpoints`** (install/disable independence —
ADR invariants forbid growing `rebuildup.git` additively) implementing
the minimal correct capture:

- **Ref namespace** `refs/herdr-plugins/checkpoints/<repo-key>/<id>`
  where `repo-key = sha256(realpath(repo_root))[:16]` and `id` is a
  base36-time + random suffix. Mirrors upstream's
  `<prefix>/<scope-key>/<ordinal>` shape without needing scope
  allocation in v1. Visible to `git log --all`; never matched by
  default push refspecs.
- **Temp-index capture**: `GIT_INDEX_FILE` under the repo's git common
  dir, seeded `read-tree HEAD` → `add -A` → `write-tree` →
  `commit-tree -p HEAD` → `update-ref`. The user's real index,
  staging, and worktree are never written — verified by contract test
  (`git status --porcelain` + `diff --cached` identical before/after).
- **Shared object store (v1)**: objects go directly into the repo's
  object database. Upstream's private object dir + quarantine exists
  to isolate bulk-checkin packs and prevent refs depending on a
  disposable store; for single-writer CLI captures the simpler model
  is acceptable and is recorded here as a deliberate deferral, not an
  oversight. Hardening (private objects, quarantine, index reuse,
  sparse rebuild) is follow-up work if T2+ needs it.
- **Fixed committer identity** `herdr checkpoints
  <checkpoints@herdr-plugins.invalid>` via `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` env — host `user.*` config must not be required
  (same approach as upstream's `T3 Code` identity).
- **State index** under `HERDR_PLUGIN_STATE_DIR/state.json` with the
  projects-plugin lock + tmp+rename discipline; the file stores only
  id → ref/commit/repo metadata.
- **Structured refusals**: unborn HEAD (`empty_repo`), bare/non-repo
  (shared git-core kinds), sparse checkout (`sparse_checkout` — a
  fresh index cannot carry skip-worktree bits, so capture would
  publish phantom deletions).

## Consequences

- `git log --all` / ref-aware tools see checkpoint commits; documented
  in spec + contract.
- Orphaned objects after `delete` rely on normal `git gc`; dedicated
  GC is #75.
- Submodules are **record-and-warn**: gitlinks capture the recorded
  submodule HEAD only; submodule worktree contents are not captured in
  v1 (`submodules[]` field + CLI warning). Upstream's per-submodule
  checkpoint fan-out is deferred.
- No turn-boundary machinery: every `create` is an explicit manual
  checkpoint; `#74` adds triggers once herdr exposes settle/turn
  signals worth keying on.
- Restore (#73) must treat the checkpoint commit as a tree snapshot:
  apply via a scratch index + worktree checkout semantics, never by
  moving HEAD or rewriting the user's index.

## Amendment (T2 / Issue #73): restore semantics

The T2 restore does **not** use a scratch index. It mirrors upstream
`GitVcsDriver.restoreCheckpoint` exactly: `git restore --source <oid>
--worktree --staged -- .` syncs the real index and worktree to the
checkpoint tree (deleting tracked paths absent from it), followed by
bounded `git clean -fd` passes and a post-verify (`git diff` vs the
commit for worktree+index, `git clean -dn` for leftovers). Rationale:
the scratch-index approach cannot express "index equals checkpoint"
semantics and would leave staged state inconsistent with the restored
worktree; upstream chose the same trade-off. Safety instead comes from
the surrounding contract: a mandatory persisted `pre-restore`
checkpoint before any mutation, shared-worktree/session isolation
gates, and structured failure kinds carrying the pre-restore ref.
