# Checkpoints plugin (`rebuildup.checkpoints`) — specification

Scope: T1 foundation (#72) — hidden-ref capture/list/show/diff/delete;
T2 (#73) — safe restore (`plan` + `restore`); T3 (#74) — work-unit
auto-capture via the agent-status event hook + lazy drain; T4 (#75) —
multi-repo save/restore groups + retention GC. Contract:
`herdr-plugins.checkpoints/v1`
(`docs/contracts/checkpoints-v1.md`). Design: ADR-0011. Upstream
semantics reference: T3 Code `GitVcsDriver.captureCheckpoint` /
`restoreCheckpoint` (~lines 1843–2069) +
`orchestration-v2/CheckpointRestoreSafety.ts` (pinned revision in
`docs/program/feature-ledger.json`).

## Purpose

Give agents and users a safe way to snapshot "the worktree as it is
now" — tracked modifications, staged content, and untracked files —
without committing, without touching the user's index/staging (on
capture), and without a daemon. `restore` is the one command that
mutates the worktree — it does so only behind a mandatory pre-restore
checkpoint and shared-worktree isolation checks. #74 adds work-unit
auto-capture (below); #75 adds multi-repo save/restore groups and
retention GC/prune.

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
   fixed identity `herdr checkpoints <checkpoints@hoxay-plugins.invalid>`
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
created_at, label?, kind?, files_summary?, files_summary_truncated?,
submodules?`.

Auto-capture bookkeeping lives in the same file under
`auto[sessionKey][paneId]` = `{last_status?, pending?}` — session
namespaced by `hostname + canonical socket path` (same convention as
`rebuildup.inbox`), since pane ids repeat across sessions.

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
- `plan <id> [--repo PATH]` — read-only restore preview:
  `files_to_change` = union of `git diff --name-only <commit>` and
  `git diff --cached --name-only <commit>` (worktree ∪ index deltas);
  `untracked_to_delete` = `ls-files --others --exclude-standard`
  entries absent from the commit tree — precisely what the post-restore
  `clean -fd` passes remove (a plain `clean -dn` count would wrongly
  include currently-untracked files that `--staged` makes tracked).
  Plans against the live ref target, or the recorded `commit` with a
  warning when the ref is gone.
- `restore <id> [--repo PATH] [--force]` — safe restore, below.
- `save` / `restore-group` / `gc` / `prune` — multi-repo groups and
  retention, below (#75).

## Restore procedure (#73)

Target resolution: default is the entry's `repo_root`; `--repo PATH`
may name **another worktree of the same repository** — verified by
comparing canonical `git rev-parse --git-common-dir` of both
(`repo_mismatch` otherwise). The hidden ref resolves through the
shared object store in any linked worktree.

Pre-mutation gates, in order:

1. Ref liveness: `verify-ref` on the entry's ref; missing →
   `checkpoint_ref_missing`. A moved ref restores its current target
   with a warning.
2. **Shared-worktree isolation** (mirrors upstream
   `CheckpointRestoreSafety` / `SHARED_WORKSPACE_RESTORE_MESSAGE`,
   simplified to pane cwds): `session.snapshot` → every pane cwd
   canonicalized (realpath, `path.resolve` fallback) → counted when at
   or under the repo root via `path.relative` containment. **≥2
   sharing panes → `shared_worktree`** (ids in `error.panes`).
   **Session unreachable → `session_unreachable`** — refusing is the
   deliberate safe default: isolation cannot be proven, so restore is
   denied unless `--force`. `--force` skips the check entirely and is
   reported as `isolation:"forced"` + warning. Panes without a cwd are
   ignored (documented limit).
3. **Mandatory pre-restore checkpoint** via `captureCheckpoint`
   (label `pre-restore:<id>`), persisted to state *before* any
   mutation. Capture failure refuses the restore; this is the recovery
   anchor for every later failure.

Mutation (`plugins/checkpoints/src/restore.ts`, upstream
`GitVcsDriver.restoreCheckpoint` semantics):

4. `git restore --source <oid> --worktree --staged
   --ignore-skip-worktree-bits -- .` — syncs index+worktree to the
   checkpoint tree; paths absent from the checkpoint are deleted
   (verified empirically: restore removes index/worktree entries not
   in the source). `--ignore-skip-worktree-bits` matches upstream —
   v1 refuses sparse checkouts, so every skip-worktree bit is manual.
5. Bounded `git clean -fd -- .` passes (max 4) repeated while stdout
   still matches `^Removing ` — a removed untracked `.gitignore`
   exposes newly-untracked files. `-x` is never passed: ignored files
   survive (they were never captured). Exhausting the cap →
   `clean_incomplete`; non-zero exit → `clean_failed`.
6. Post-verify: `git diff --quiet <oid>` (worktree), `git diff
   --cached --quiet <oid>` (index), `git clean -dn` empty — any
   mismatch → `restore_verify_failed`.

Failure contract: mutation-phase errors (`restore_failed`,
`clean_failed`, `clean_incomplete`, `restore_verify_failed`,
`git_error`, `timeout`) return `error.pre_restore_checkpoint_id` /
`pre_restore_ref` / `pre_restore_commit`; the pre-restore ref always
exists and can itself be restored. Success reports
`pre_restore:{id,ref,commit,label}`, `isolation`, `sharing_panes`,
`clean_passes`, and submodule warnings (v1 restores the root repo
only — recorded gitlinks' submodule worktrees are untouched).

## Work-unit auto-capture (#74)

herdr exposes no per-message turn boundary — `agent_status` is the
coarsest work-unit signal available (`idle`/`working`/`blocked`/
`done`/`unknown`, bumped `state_change_seq` per transition; verified
herdr 0.9.5). Auto-capture therefore produces **work-unit
checkpoints**, explicitly *not* upstream T3 Code's turn-confirmed
checkpoints: one capture per observed `working → idle|done` edge,
labelled `kind:"auto"`. Per-message turn boundaries remain an upstream
request candidate (see "Upstream gaps").

Two halves, no daemon (ADR-0002):

- **Hook** (`src/hook.ts`, manifest `[[events]]`): on
  `pane.agent_status_changed` it re-reads `session.snapshot` (the hook
  payload carries only `pane_id` + `agent_status` — no seq) and folds
  the transition into `state.auto[sessionKey][paneId]`:
  - `working → idle|done` records a capture-pending mark
    `{status, seq, agent_session, recorded_at}`.
  - A return to `working` clears the mark — new activity supersedes
    the unfinished work unit; the next settle re-pends.
  - The first status ever observed for a pane never pends (no
    fabricated work unit without a proven working edge).
  - `pane.closed` drops the pane's marks.
  The hook performs no git work — one snapshot request + one locked
  state write; it exits 0 even when the session is unreachable.
- **Lazy drain** (`drainPendingCaptures`, run at the top of every CLI
  command except `capability`/`help`): resolves each pending mark
  against a fresh snapshot and captures only when the generation still
  matches — `state_change_seq` equal (when both sides report one) and
  the `agent_session` fingerprint equal, the same convention as
  `rebuildup.inbox`. Stale marks (`stale_generation`), vanished
  panes/agents (`pane_or_agent_gone`), and missing cwds
  (`no_pane_cwd`) are dropped, never captured under a wrong
  generation; repo/capture failures are dropped and reported as
  `skipped` reasons (auto-capture is best-effort — `create` remains
  the explicit path). An unreachable session leaves all marks pending
  (`auto_captures.session_unreachable: true`).

`kind` distinguishes provenance: `manual` (explicit `create`,
including `--repo`), `auto` (hook-drained work-unit captures and
`create --auto`), `pre_restore` (mandatory pre-restore safety capture).
Entries written before #74 carry no `kind` and read as `manual`.

An explicit `create`/`create --auto` for a pane clears that pane's
pending mark first — the manual capture supersedes the pending
work-unit capture of the same state.

Drain outcomes surface in every command payload as `auto_captures`
(`{captured: [ids], skipped: [{pane_id, reason}],
session_unreachable?}`), omitted when empty.

### Metadata projection

After any successful capture targeting a pane (auto drain or
pane-resolved `create`), the plugin reports display-only tokens via
`pane.report_metadata` (source `rebuildup.checkpoints`):
`checkpoint_latest` = checkpoint id, `checkpoint_count` = number of
state entries for that repo root. Tokens merge per source; other
plugins' tokens are untouched. Projection failures never fail the
capture.

## Multi-repo groups and retention (#75)

A **checkpoint group** is the set of entries captured by one `save`
call across a project's repos — the multi-repo counterpart of a single
`create`. `group_id` (`grp-<base36>-<hex>`) is stamped on every member
entry; `create`, auto-capture, and pre-#75 entries carry none.

### `save`

Repo-set resolution, in priority order:

1. repeated `--repo PATH` — explicit enumeration; each path resolves
   independently and a resolution/capture failure becomes a per-repo
   `ok:false` result, never aborts the others;
2. a pane id (`--pane`, positional, `HERDR_PANE_ID`, plugin context)
   — that pane's repo only, identical resolution to `create` (and
   identical fail-hard errors);
3. neither — **live discovery**: the session snapshot's pane cwds are
   resolved to repos, deduped by canonical root. Non-repo cwds and
   cwd-less panes land in `skipped_panes` with a reason. Discovery
   needs a reachable session (`session_unreachable` otherwise) and
   deliberately avoids the projects registry — no cross-plugin state
   dependency.

Every member is captured with the same `group_id` and persisted in
one locked state write. `ok`/exit code are honest: any repo failure
prints the full per-repo report on stdout, a `partial_save` error on
stderr, exit 1.

### `restore-group <group-id>`

Finds all state entries with the matching `group_id` (unknown →
`unknown_group`) and runs each through the *same* pipeline as
`restore`: recorded `repo_root` only (`--repo` rejected — group
members always restore into their own repo), ref liveness,
per-repo shared-worktree isolation (each repo counts its own sharing
panes; `--force` bypasses all), mandatory `pre_restore` capture per
repo, worktree restore + post-verify. Repos are attempted
independently — one failure never aborts the rest, and each member's
result carries the full single-restore field set or a structured
`error`. Partial success is reported as `ok:false` + exit 1
(`partial_restore` on stderr); it is never dressed up as success.

### `gc` — bounded retention

Per canonical repo root (entries are per-worktree; linked worktrees of
one repository are evaluated independently since their `repo_key`s
and entry sets differ):

- evict entries beyond `--max-count` newest-first
  (default 50 / config `gcMaxCount`);
- evict entries older than `--max-age-days`
  (default 30 / config `gcMaxAgeDays`);
- **exempt** `kind:"pre_restore"` entries younger than
  `--protect-days` (default 7 / config `preRestoreProtectDays`) — the
  safety anchor for a recent restore;
- eviction = `update-ref -d` + state removal together; a ref that
  fails to delete keeps its state entry (reported, retried next run);
- unreachable repos are listed under `unreachable` and skipped —
  their state is never touched;
- `--dry-run` reports `would_delete` with zero mutations;
- `ok` is false only when *no* repo could be evaluated (every wanted
  repo unreachable) — that case also exits 1 with an
  `unreachable_repos` stderr error, matching the save/restore-group
  honesty rule. Partial unreachable keeps `ok:true` + exit 0.

### `prune` — orphan refs (deleteStaleRefs equivalent)

Upstream T3 Code's `CheckpointService.deleteStaleRefs` removes refs
whose checkpoints left the store; here the equivalent is explicit:
`prune` lists `refs/herdr-plugins/checkpoints/` in each scanned repo
(`--repo PATH`, else every repo root known to state — linked
worktrees sharing a git common dir are scanned once) and deletes any
ref **not named by a state entry**. Protection is by full ref name
globally, so a state-referenced ref can never be pruned from any
repo. Deletion uses `update-ref --no-deref -d` like upstream;
`--dry-run` lists orphans only. Same `ok`/exit rule as `gc`: false +
exit 1 (`unreachable_repos`) only when no repo could be scanned.

## Error taxonomy

`not_a_repo`, `bare_repo`, `empty_repo` (unborn HEAD),
`sparse_checkout`, `unknown_checkpoint`, `unknown_group`,
`cross_repo`, `pane_not_found`, `no_pane_cwd`, `repo_mismatch`,
`checkpoint_ref_missing`, `shared_worktree`, `session_unreachable`,
`restore_failed`, `clean_failed`, `clean_incomplete`,
`restore_verify_failed`, `partial_save`, `partial_restore`,
`unreachable_repos` (gc/prune: no repo could be evaluated at all),
plus shared `git_missing` / `timeout` / `git_error`. Unsupported
conditions are structured errors, never success-shaped output.

## v1 limits (explicit)

- Unborn HEAD → `empty_repo` (no root commit to parent to).
- Sparse checkout → `sparse_checkout` error.
- Submodules: only the gitlink (recorded submodule HEAD) is captured;
  submodule *worktree* contents are not. `submodules[]` + CLI warning
  make this visible. Nested-repo capture semantics deferred.
- `git add -A` rehashes the full worktree through the scratch index —
  O(repo size); upstream's user-index stat-cache reuse is deferred.
- Restore mutates the real index+worktree (upstream semantics), unlike
  capture which never does; the pre-restore checkpoint + post-verify
  bound the blast radius. No scratch-index restore variant.
- Restore is root-repo only: submodule worktrees are not restored
  (record-and-warn). Nested *untracked* repos are skipped by
  `git clean -fd` (needs `-ff`), so they survive restore.
- Session-unreachable restore requires `--force` (safe default);
  panes lacking a cwd are not counted toward the shared-worktree
  threshold.
- `save` discovery covers repos reachable from *pane cwds* in the
  current session only — repos no pane touches are not discovered
  (explicit `--repo` covers that case).
- Auto-capture granularity is `agent_status` transitions — a
  **work-unit** checkpoint, coarser than upstream's per-turn boundary.
  `blocked`/`unknown` never pend; `done` and `idle` both do. Multiple
  messages inside one work unit collapse into a single capture.
- Auto-capture is best-effort: marks are dropped on capture failure
  (recorded in `auto_captures.skipped`), and an explicit `create`
  supersedes a pending mark for the same pane.
- Checkpoint commits/objects are unreachable from branches; refs are
  the reachability anchor — `gc` enforces count/age retention and
  `prune` removes state-unreferenced refs, but neither runs `git gc`
  itself (object reclamation stays git's job).

## Upstream gaps (recorded, not worked around)

- **Per-message turn boundary**: herdr `agent_status` has no
  turn/message granularity; upstream T3 Code captures at turn
  completion. Faithful turn checkpoints need a structured
  turn-boundary event from herdr — upstream request candidate.
- **Worktree/session lifecycle hooks**: hook-eligible `[[events]]`
  cover pane/workspace/worktree/tab lifecycle plus
  `pane.agent_detected`/`pane.agent_status_changed` (verified live on
  0.9.5 — `pane.updated`, `pane.output_changed`, `pane.output_matched`,
  `pane.scroll_changed`, `layout.updated`, `workspace.metadata_updated`,
  and all `session.*` names are rejected as unknown events). No
  session-level events exist at all. Checkpoints does not need them:
  work-unit capture keys on agent status only; a `worktree.created`
  capture would snapshot an empty worktree and is deliberately unused.
- **`events.subscribe` alternatives**: the socket subscription surface
  is broader (incl. `pane.output_changed`, `layout.updated`) but needs
  a persistent connection — a daemon, forbidden by ADR-0002.
