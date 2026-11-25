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
`delete` read and manage those refs plus a small state index under
`HERDR_PLUGIN_STATE_DIR`.

## Commands

```bash
cd "$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id=="rebuildup.checkpoints") | .plugin_root')"
bun run src/cli.ts capability
bun run src/cli.ts create [--repo PATH | <pane_id>] [--label TEXT]
bun run src/cli.ts list [--repo PATH] [--limit N]
bun run src/cli.ts show <checkpoint-id> [--max-bytes N]
bun run src/cli.ts diff <checkpoint-id|HEAD> <checkpoint-id|HEAD> [--max-bytes N]
bun run src/cli.ts delete <checkpoint-id>
```

- Repo target: `--repo PATH`, or a pane id (argument, `HERDR_PANE_ID`,
  or the manifest action context) resolved through the herdr session
  snapshot — the same path `rebuildup.git` uses.
- All commands print one JSON document on stdout; errors go to stderr
  (`{contract, ok:false, error:{code,message,kind?}}`), exit 1 handled /
  2 usage.

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
  database; `git log --all` shows the hidden refs. GC of deleted
  checkpoint objects is a later ticket.
- Restore / auto-capture / multi-repo orchestration are later tickets
  (#73–#75).
