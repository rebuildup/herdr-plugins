# rebuildup.checkpoints

Worktree checkpoints for herdr panes, implemented as hidden git refs.
Contract: `herdr-plugins.checkpoints/v1` — see
[`docs/contracts/checkpoints-v1.md`](../../docs/contracts/checkpoints-v1.md)
and the design note
[`docs/adr/0011-checkpoints-hidden-refs.md`](../../docs/adr/0011-checkpoints-hidden-refs.md).

## What it does

`create` snapshots the repository worktree — tracked modifications,
staged content, and untracked files (`.gitignore` respected) — into a
synthetic commit stored under
`refs/herdr-plugins/checkpoints/<repo-key>/<id>`. Capture runs entirely
through a temporary `GIT_INDEX_FILE`; the user's real index, staging
area, and worktree are never modified. `list` / `show` / `diff` /
`plan` / `restore` / `delete` read and manage those refs plus a small
state index under `HERDR_PLUGIN_STATE_DIR`. `restore` rewrites the
worktree+index to a checkpoint's tree (deleting post-checkpoint
untracked files) only after capturing a mandatory `pre-restore`
checkpoint and passing shared-worktree isolation checks.

Auto-capture (#74): the `pane.agent_status_changed` event hook records
a capture-pending mark on `working → idle|done` transitions (no git in
the hook); the next CLI invocation lazily captures it as a `kind:"auto"`
work-unit checkpoint — see `docs/specs/checkpoints.md`.

Multi-repo groups (#75): `save` captures one checkpoint per repo under
a shared `group_id` — explicit `--repo` list, a pane's repo, or live
discovery across session pane cwds — and `restore-group` restores them
with honest per-repo status. `gc` enforces per-repo retention
(count/age, `pre_restore` protection window) and `prune` deletes
state-unreferenced hidden refs; both support `--dry-run`.

## Interactive TUI

`[[panes]] id="main"` + the `open` action (`bun run src/tui.ts open|main`,
contract `docs/contracts/tui-v1.md`, ADR-0031/0032/0033) open a tab-placed
checkpoint browser: searchable list with kind badges (`manual`/`auto`/
`pre_restore`, group ids), per-checkpoint detail (`show` summary), diff
viewer (checkpoint↔HEAD or checkpoint↔checkpoint), read-only `plan`
preview, guarded `create`/`save`/`restore`/`restore-group`/`delete`
(confirm dialogs; restore is destructive and always captures a
`pre-restore` evacuation checkpoint first), group browser, and
`gc`/`prune` retention views that are **dry-run first** — apply is a
second, confirm-gated step.

Safety properties:

- Opening the TUI is read-only: every view calls the CLI with
  `--no-drain`, so the lazy pending-capture drain never fires
  implicitly. Pending marks drain only via the explicit `a` key or
  inside mutation commands — same semantics as the CLI.
- The launch target (workspace/pane/repo/session) is pinned once via
  `HERDR_PLUGIN_CONTEXT_JSON`/`HERDR_TUI_*`; `create`/`save` name the
  pinned pane id or an explicit repo path — the UI pane's own
  `HERDR_PANE_ID` is never a target.
- Mutations are gated on `capability`/`mutation_commands` (fail closed)
  and revalidate the checkpoint (`show`) before restore/delete; the
  CLI's own shared-worktree isolation and `checkpoint_ref_missing`
  checks remain the final authority.

## Commands

```bash
cd "$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id=="rebuildup.checkpoints") | .plugin_root')"
bun run src/cli.ts capability
bun run src/cli.ts create [--repo PATH | <pane_id>] [--label TEXT] [--auto]
bun run src/cli.ts save [--repo PATH ...] [--pane ID | <pane_id>] [--label TEXT]
bun run src/cli.ts list [--repo PATH] [--group ID] [--limit N]
bun run src/cli.ts show <checkpoint-id> [--max-bytes N]
bun run src/cli.ts diff <checkpoint-id|HEAD> <checkpoint-id|HEAD> [--max-bytes N]
bun run src/cli.ts plan <checkpoint-id> [--repo PATH]
bun run src/cli.ts restore <checkpoint-id> [--repo PATH] [--force]
bun run src/cli.ts restore-group <group-id> [--force]
bun run src/cli.ts delete <checkpoint-id>
bun run src/cli.ts gc [--repo PATH] [--dry-run] [--max-count N] [--max-age-days N] [--protect-days N]
bun run src/cli.ts prune [--repo PATH] [--dry-run]
```

`restore` always captures a `pre-restore` checkpoint first, refuses
shared worktrees (≥2 live panes under the repo root) and unreachable
herdr sessions unless `--force`, then restores tracked+staged content
and deletes untracked files — files created after the checkpoint are
removed. `plan` previews the same counts without mutating.

- Repo target: `--repo PATH`, or a pane id (argument, `HERDR_PANE_ID`,
  or the manifest action context) resolved through the herdr session
  snapshot — the same path `rebuildup.git` uses.
- All commands print one JSON document on stdout; errors go to stderr
  (`{contract, ok:false, error:{code,message,kind?}}`), exit 1 handled /
  2 usage. `--no-drain` on any command skips the lazy pending-capture
  drain (used by the TUI's read-only views).

## Runtime prerequisite

[Bun](https://bun.sh) on `PATH` plus `git`. No build step, no
dependencies beyond the repo's shared `packages/git-core` and
`packages/herdr-client` sources.

## v1 limits (see spec for details)

- Requires at least one commit (unborn HEAD → `empty_repo` error).
- Sparse checkout → `sparse_checkout` error (scratch index cannot
  represent skip-worktree bits safely yet).
- Submodules: gitlinks are recorded; submodule *worktree* contents are
  not captured (record-and-warn).
- Shared object store: checkpoint objects live in the repo's own object
  database; `git log --all` shows the hidden refs. `gc` bounds ref
  retention and `prune` removes state-unreferenced refs, but neither
  runs `git gc` — object reclamation stays git's job.
- Restore covers the root repo only: submodule worktrees recorded as
  gitlinks are not restored (warned).
- Auto-capture is work-unit granularity (`agent_status` transitions),
  not upstream's per-turn boundary; it is best-effort and drops marks
  on capture failure.
- `save` discovery covers only repos reachable from pane cwds in the
  current session; repos no pane touches need explicit `--repo`.
