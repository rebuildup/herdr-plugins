# Contract `herdr-plugins.checkpoints/v1`

Structured JSON CLI contract for the `rebuildup.checkpoints` herdr
plugin — worktree checkpoints stored as hidden git refs
(`refs/herdr-plugins/checkpoints/<repo-key>/<id>`). Read commands
(`list`, `show`, `diff`, `plan`) are side-effect free against the
user's index/worktree; `create`, `delete`, and `restore` write hidden
refs, plugin state, and — for `restore` only — the worktree/index.
Follows the same conventions as `herdr-plugins.git/v1`
(`docs/contracts/git-v1.md`).

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.checkpoints"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.checkpoints/v1"` and the commands you
   need exist.
3. Run `create` / `list` / `show` / `diff` / `plan` / `restore` /
   `delete` as needed.

## Invocation

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts create [--repo PATH | <pane_id>] [--label TEXT]
    [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts list [--repo PATH] [--limit N]
bun run src/cli.ts show <checkpoint-id> [--max-bytes N]
bun run src/cli.ts diff <checkpoint-id|HEAD> <checkpoint-id|HEAD>
    [--max-bytes N]
bun run src/cli.ts plan <checkpoint-id> [--repo PATH]
bun run src/cli.ts restore <checkpoint-id> [--repo PATH] [--force]
    [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts delete <checkpoint-id>
```

- Repo target for `create`: `--repo PATH` (any path inside the work
  tree), or a pane id — positional argument, `HERDR_PANE_ID`, or
  `HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id` — resolved through the
  herdr session snapshot (same path as `rebuildup.git`). `--repo` and a
  pane id are mutually exclusive. `list --repo` filters by repo.
- Repo target for `plan`/`restore`: the checkpoint's recorded
  `repo_root` by default. `--repo PATH` may select **another worktree
  of the same repository** (same git common dir / object store — the
  only cross-checkout case a checkpoint commit can restore into);
  anything else is `repo_mismatch`.
- All commands print exactly one JSON document on stdout. Handled
  errors print `{contract, ok:false, error:{code,message,kind?}}` on
  **stderr** and exit 1; usage errors exit 2.
- Requires `git` on `PATH` and `bun` (plugin runtime prerequisite).

## Checkpoint identity

- `id`: `<base36-ms>-<8 hex>`; unique per capture, ref-path safe.
- `repo_key`: first 16 hex chars of `sha256(canonical repo root)`
  (realpath). Deterministic; different worktrees of one repository get
  distinct keys.
- `ref`: `refs/herdr-plugins/checkpoints/<repo_key>/<id>`.
- `commit`: synthetic commit oid; first parent is the captured `HEAD`.

## Payloads

### `capability`

`{contract, plugin, version, commands, read_only:false,
mutation_commands:["create","delete","restore"], requires:{git,bun}, defaults}`.

### `create`

```json
{
  "contract": "herdr-plugins.checkpoints/v1",
  "command": "create",
  "ok": true,
  "pane_id": "w1:p1 | null",
  "repo_root": "/abs/canonical/root",
  "checkpoint": { "...entry fields..." },
  "warnings": ["submodule gitlinks recorded (n); ..."],
  "generated_at": "ISO-8601"
}
```

`checkpoint` entry fields: `id`, `repo_root`, `repo_key`, `ref`,
`commit`, `head_sha`, `branch` (null when detached), `created_at`,
optional `label`, `files_summary` (bounded `git diff --name-status
head commit`), `files_summary_truncated`, `submodules` (gitlink paths).

### `list`

`{contract, command:"list", repo_root|null, count, total, truncated,
checkpoints:[entry...], generated_at}` — newest `created_at` first,
default limit 100 (`--limit`, max 1000).

### `show <id>`

`{contract, command:"show", checkpoint, repo_root,
ref:{name, exists, oid}, summary:{output,truncated,bytes}|null,
summary_error:string|null, generated_at}` — `summary` is a bounded
`git show --stat <commit>`; `ref.exists:false` means the hidden ref was
deleted or moved out-of-band (the state entry is still shown, never
silently dropped).

### `diff <a> <b>`

Each side is a checkpoint `id` or the literal `HEAD` (resolved in the
checkpoint side's repo). At least one side must be a checkpoint; both
checkpoint sides must share `repo_root` (`cross_repo` error
otherwise). Output:

`{contract, command:"diff", repo_root, a:{kind,rev,...},
b:{kind,rev,...}, patch, truncated, bytes, generated_at}` — `patch` is
bounded `git diff --no-color <revA> <revB>` (`--max-bytes`, default
256 KiB, `truncated:true` when capped).

### `plan <id>`

Read-only preview of what `restore` would do — never mutates, never
touches the herdr session:

`{contract, command:"plan", checkpoint, repo_root, commit,
ref:{name, exists, oid}, plan:{files_to_change, untracked_to_delete,
already_matches}, warnings, generated_at}`

- `files_to_change`: union of `git diff --name-only <commit>` and
  `git diff --cached --name-only <commit>` — tracked paths whose
  worktree or index content differs from the checkpoint.
- `untracked_to_delete`: count of `git ls-files --others
  --exclude-standard` entries absent from the checkpoint's tree —
  exactly the files the post-restore `git clean -fd` passes delete.
  (A raw `git clean -dn` count would overcount: a file untracked now
  but present in the checkpoint becomes tracked via `--staged` and
  survives.) Ignored files are excluded, matching `clean` without
  `-x`. **These files will be permanently deleted by restore.**
- `commit` is the live ref target when the ref exists, else the
  recorded `commit` (with a `warnings` entry); `ref.exists:false`
  reports out-of-band ref deletion honestly.

### `restore <id> [--repo PATH] [--force]`

Safely restores the checkpoint's tree into the target worktree.
Sequence (any failure before the mutation phase mutates nothing):

1. Resolve target repo (see above), verify the hidden ref still exists
   (`checkpoint_ref_missing` otherwise; a moved ref restores its
   current target with a warning).
2. **Shared-worktree isolation** (skipped by `--force`): fetch the
   herdr `session.snapshot`; every pane cwd at or under the repo root
   counts as sharing. **≥2 sharing panes → `shared_worktree` error**
   (pane ids in `error.panes`). **Session unreachable →
   `session_unreachable` error** — the safer default, since isolation
   cannot be proven. `--force` bypasses both and reports
   `isolation:"forced"` plus a warning.
3. **Mandatory pre-restore checkpoint**: `create` semantics with
   label `pre-restore:<id>`, persisted to state **before** any
   mutation. If capture fails the restore is refused. This ref is the
   recovery path for every later failure.
4. `git restore --source <ref-oid> --worktree --staged
   --ignore-skip-worktree-bits -- .` — index and worktree are synced
   to the checkpoint tree; tracked paths absent from the checkpoint
   are deleted. Then up to 4 `git clean -fd -- .` passes, repeating
   while a pass still prints `Removing ` (a removed `.gitignore` can
   expose newly-untracked files); exhausting the cap is
   `clean_incomplete`.
5. **Post-verify**: `git diff --quiet <oid>` (worktree),
   `git diff --cached --quiet <oid>` (index), and `git clean -dn` must
   all be clean → `restore_verify_failed` otherwise.

Success payload:

`{contract, command:"restore", ok:true, checkpoint, repo_root,
restored_commit, pre_restore:{id, ref, commit, label},
isolation:"isolated"|"single_pane"|"no_panes"|"forced",
sharing_panes:[ids], clean_passes, warnings, generated_at}`

On any mutation-phase failure the error carries
`pre_restore_checkpoint_id` / `pre_restore_ref` /
`pre_restore_commit` so callers can recover via
`restore <pre-restore-id>`. `warnings` notes submodule gitlinks:
**v1 restores the root repo only** — submodule worktrees recorded in
the checkpoint are not restored.

### `delete <id>`

`{contract, command:"delete", ok:true, id, ref, ref_existed,
warnings, generated_at}` — removes the state entry always; deletes the
hidden ref when it still exists (`ref_existed:false` when already gone
or the repo is unreachable — idempotent cleanup, reported via
`warnings`). Deleting an unknown id is `unknown_checkpoint`.

## Error kinds

| kind | meaning |
| --- | --- |
| `not_a_repo` | target path is inside no git work tree |
| `bare_repo` | target is a bare repository |
| `empty_repo` | repository has no commits (unborn HEAD) |
| `sparse_checkout` | `core.sparseCheckout=true`; v1 refuses rather than publish a false tree |
| `unknown_checkpoint` | id not present in plugin state |
| `cross_repo` | diff sides belong to different repositories |
| `pane_not_found` / `no_pane_cwd` | pane resolution failures (create via pane) |
| `repo_mismatch` | `--repo` is not a worktree of the checkpoint's repository |
| `checkpoint_ref_missing` | state entry exists but the hidden ref is gone |
| `shared_worktree` | ≥2 live panes share the target worktree (restore; `error.panes`) |
| `session_unreachable` | herdr session snapshot failed during restore isolation check |
| `restore_failed` / `clean_failed` / `clean_incomplete` / `restore_verify_failed` | restore mutation/verify failures; error carries `pre_restore_*` fields |
| `git_missing` / `timeout` / `git_error` | shared git-core spawn failures |

## Explicit non-goals (v1)

No turn-boundary auto-capture, no multi-repo orchestration, no
checkpoint GC, no private object store/quarantine, no submodule
worktree capture/restore (record-and-warn only). Those are tickets
#74–#75 and later hardening.
