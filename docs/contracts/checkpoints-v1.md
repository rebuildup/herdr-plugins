# Contract `herdr-plugins.checkpoints/v1`

Structured JSON CLI contract for the `rebuildup.checkpoints` herdr
plugin — worktree checkpoints stored as hidden git refs
(`refs/herdr-plugins/checkpoints/<repo-key>/<id>`). Read commands
(`list`, `show`, `diff`) are side-effect free against the user's
index/worktree; `create` and `delete` write hidden refs and plugin
state only. Follows the same conventions as
`herdr-plugins.git/v1` (`docs/contracts/git-v1.md`).

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.checkpoints"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.checkpoints/v1"` and the commands you
   need exist.
3. Run `create` / `list` / `show` / `diff` / `delete` as needed.

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
bun run src/cli.ts delete <checkpoint-id>
```

- Repo target for `create`: `--repo PATH` (any path inside the work
  tree), or a pane id — positional argument, `HERDR_PANE_ID`, or
  `HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id` — resolved through the
  herdr session snapshot (same path as `rebuildup.git`). `--repo` and a
  pane id are mutually exclusive. `list --repo` filters by repo.
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
mutation_commands:["create","delete"], requires:{git,bun}, defaults}`.

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
| `git_missing` / `timeout` / `git_error` | shared git-core spawn failures |

## Explicit non-goals (v1)

No restore, no turn-boundary auto-capture, no multi-repo orchestration,
no checkpoint GC, no private object store/quarantine, no submodule
worktree capture. Those are tickets #73–#75 and later hardening.
