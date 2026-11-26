# Contract `herdr-plugins.checkpoints/v1`

Structured JSON CLI contract for the `rebuildup.checkpoints` herdr
plugin — worktree checkpoints stored as hidden git refs
(`refs/herdr-plugins/checkpoints/<repo-key>/<id>`). Read commands
(`list`, `show`, `diff`, `plan`) are side-effect free against the
user's index/worktree; `create`, `save`, `delete`, `restore`,
`restore-group`, `gc`, and `prune` write hidden refs, plugin state,
and — for the restore commands only — the worktree/index.
Every command (except `capability`/`help`) first drains pending
work-unit auto-captures recorded by the plugin's event hooks — see
"Auto-capture" below. A caller that must not mutate on a read-only
open (the interactive TUI, `docs/contracts/tui-v1.md` §5.1 /
ADR-0033 §3.1) passes the additive `--no-drain` flag to skip the
drain; pending marks are left untouched for a later invocation.
Follows the same conventions as
`herdr-plugins.git/v1` (`docs/contracts/git-v1.md`).

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.checkpoints"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.checkpoints/v1"` and the commands you
   need exist.
3. Run `create` / `save` / `list` / `show` / `diff` / `plan` /
   `restore` / `restore-group` / `delete` / `gc` / `prune` as needed.

## Invocation

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts create [--repo PATH | <pane_id>] [--label TEXT]
    [--auto] [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts save [--repo PATH ...] [--pane ID | <pane_id>]
    [--label TEXT] [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts list [--repo PATH] [--group ID] [--limit N]
bun run src/cli.ts show <checkpoint-id> [--max-bytes N]
bun run src/cli.ts diff <checkpoint-id|HEAD> <checkpoint-id|HEAD>
    [--max-bytes N]
bun run src/cli.ts plan <checkpoint-id> [--repo PATH]
bun run src/cli.ts restore <checkpoint-id> [--repo PATH] [--force]
    [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts restore-group <group-id> [--force]
    [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts delete <checkpoint-id>
bun run src/cli.ts gc [--repo PATH] [--dry-run]
    [--max-count N] [--max-age-days N] [--protect-days N]
bun run src/cli.ts prune [--repo PATH] [--dry-run]
```

- `--no-drain` (accepted by every command): skips the lazy
  pending-capture drain described under "Auto-capture". Additive;
  default behavior is unchanged. The interactive TUI passes it on all
  read-only views so opening never mutates plugin state.
- Repo target for `create`: `--repo PATH` (any path inside the work
  tree), or a pane id — positional argument, `HERDR_PANE_ID`, or
  `HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id` — resolved through the
  herdr session snapshot (same path as `rebuildup.git`). `--repo` and a
  pane id are mutually exclusive. `list --repo` filters by repo;
  `list --group` filters by save-group id.
- Repo set for `save`: repeated `--repo PATH` flags (explicit
  enumeration), a pane id (`--pane`, positional, `HERDR_PANE_ID`, or
  plugin context — that pane's repo only), or — with neither — **live
  discovery**: every distinct repo resolved from the session
  snapshot's pane cwds (non-repo cwds are reported in
  `skipped_panes`, never silently captured). Discovery requires a
  reachable session (`session_unreachable` otherwise); it deliberately
  does not consult the projects registry.
- `create --auto` records the entry with `kind:"auto"` instead of
  `"manual"` — for agents that detect their own work-unit boundary.
  An explicit `create` for a pane clears that pane's pending
  auto-capture mark (the manual capture supersedes it).
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
optional `label`, `kind`, `group_id`, `files_summary` (bounded `git
diff --name-status head commit`), `files_summary_truncated`,
`submodules` (gitlink paths). `group_id` is present only on entries
captured by `save` — the shared id `restore-group` operates on.

`kind` records capture provenance: `"manual"` (explicit `create`),
`"auto"` (lazy work-unit capture drained from the agent-status hook,
or `create --auto`), `"pre_restore"` (mandatory pre-restore safety
capture). Entries written before auto-capture existed carry no `kind`
and are treated as `"manual"`.

### `list`

`{contract, command:"list", repo_root|null, group:string|null, count,
total, truncated, checkpoints:[entry...], generated_at}` — newest
`created_at` first, default limit 100 (`--limit`, max 1000).

### `save`

Multi-repo checkpoint group (#75). One checkpoint per resolved repo,
all stamped with the same `group_id` (`grp-…`):

`{contract, command:"save", ok, group, total, succeeded, failed,
results:[{repo_root, ok:true, checkpoint}|{repo_root, ok:false,
error:{kind,message}}], skipped_panes?:[{pane_id, reason}],
generated_at}`

Per-repo capture failures never hide: `ok` is true only when every
repo captured. On any failure the full report is still printed on
stdout, a `{kind:"partial_save"}` error goes to stderr, and the exit
code is 1 — partial success is never reported as success. Explicit
`--repo` resolution failures are per-repo `ok:false` results; a
pane-targeted save fails hard like `create`.

### `restore-group <group-id>`

Restores every state entry whose `group_id` matches — one repo at a
time, each through the full `restore` pipeline (ref liveness, per-repo
shared-worktree isolation unless `--force`, mandatory `pre_restore`
capture, worktree restore + post-verify). `--repo` is rejected: members
always restore into their recorded repo.

`{contract, command:"restore-group", ok, group, total, succeeded,
failed, results:[...], generated_at}` — each result carries the same
fields as a single `restore` payload (`checkpoint`, `repo_root`,
`restored_commit`, `pre_restore`, `isolation`, `sharing_panes`,
`clean_passes`, `warnings`) on success, or `{ok:false, error:{kind,
message,...}, pre_restore?}` on failure. Repos are attempted
independently: one failure never aborts the rest. `ok` is true only
when every member restored; otherwise stdout still carries the full
per-repo report, stderr gets `{kind:"partial_restore"}`, exit 1.
Unknown group id → `unknown_group`.

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

### `gc`

Bounded retention (#75). Per canonical repo root, evicts entries
beyond `--max-count` (default 50, config `gcMaxCount`) counting from
newest `created_at`, and every entry older than `--max-age-days`
(default 30, config `gcMaxAgeDays`). `kind:"pre_restore"` entries
younger than `--protect-days` (default 7, config
`preRestoreProtectDays`) are exempt — they are the recovery anchor
for a recent restore. Eviction deletes the hidden ref AND the state
entry together; an entry whose ref deletion fails keeps its state
entry (reported under the repo's `errors`, retried next run). Repos
that no longer resolve are listed under `unreachable` and skipped —
their state is never touched. `--repo PATH` scopes to one repo;
`--dry-run` reports `would_delete` without mutating. `ok` is false
only when no repo could be evaluated at all; that case also exits 1
with a `{kind:"unreachable_repos"}` stderr error (partial unreachable
stays `ok:true`, exit 0).

`{contract, command:"gc", ok, dry_run, policy:{max_count,
max_age_days, pre_restore_protect_days}, repos:[{repo_root,
evaluated, deleted|would_delete:[ids], protected:[ids], kept,
errors?}], unreachable:[...], totals:{evaluated, deleted|
would_delete, protected, kept, errors}, generated_at}`

### `prune`

`deleteStaleRefs` equivalent (#75): deletes hidden refs under
`refs/herdr-plugins/checkpoints/` that **no state entry references**
— protection is by full ref name across the whole state index, so a
referenced ref is never deleted in any scanned repo. Repos scanned:
`--repo PATH`, else every repo root known to state (linked worktrees
sharing one git common dir are scanned once). Orphan deletion uses
`update-ref --no-deref -d`, mirroring upstream. `--dry-run` lists
orphans without deleting. Same `ok`/exit rule as `gc`: `ok:false` +
exit 1 (`unreachable_repos`) only when no repo could be scanned.

`{contract, command:"prune", ok, dry_run, repos:[{repo_root, scanned,
orphans:[refs], deleted?, errors?}], unreachable:[...],
totals:{scanned, orphans, deleted|would_delete, errors},
generated_at}`

## Auto-capture (work-unit checkpoints)

The manifest registers two event hooks (`src/hook.ts`):

- `pane.agent_status_changed` — folds the transition into per-session
  auto-capture state. Only an observed `working → idle|done` edge
  records a capture-pending mark (guarded by `state_change_seq` +
  `agent_session`); a return to `working` clears it; the first status
  ever seen never pends. The hook runs no git — it is a fast,
  non-blocking state write.
- `pane.closed` — drops the pane's marks.

Every CLI command then **lazily drains** pending marks before doing
its own work (unless invoked with `--no-drain`): each mark whose
generation still matches the live
snapshot becomes an `auto` checkpoint of the pane's repo; stale or
unresolvable marks are dropped. Drain outcomes appear in the payload
as `auto_captures` (omitted when empty):

```json
"auto_captures": {
  "captured": ["<checkpoint-id>"],
  "skipped": [{"pane_id": "w1:p1", "reason": "stale_generation"}],
  "session_unreachable": true
}
```

`skipped[].reason` is one of `stale_generation`, `pane_or_agent_gone`,
`no_pane_cwd`, or a git/checkpoint error `kind`. An unreachable herdr
session sets `session_unreachable: true` and leaves all marks pending
for a later invocation — auto-capture never fails the command.

Auto-capture granularity is herdr `agent_status` — a **work-unit**
checkpoint, deliberately coarser than upstream T3 Code's per-turn
boundary (no per-message turn signal exists upstream of the plugin;
recorded as an upstream gap in `docs/specs/checkpoints.md`).

After a pane-targeted capture (auto drain or `create` via pane id),
the plugin projects display-only metadata tokens via
`pane.report_metadata` (source `rebuildup.checkpoints`):
`checkpoint_latest` (checkpoint id) and `checkpoint_count` (entries
for that repo root). Projection is best-effort and never fails the
command.

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
| `unknown_group` | `restore-group` id matches no state entries |
| `partial_save` / `partial_restore` | group command: some repos failed; full per-repo report is on stdout, this kind marks the stderr summary |
| `git_missing` / `timeout` / `git_error` | shared git-core spawn failures |

## Explicit non-goals (v1)

No turn-confirmed (per-message) auto-capture — work-unit captures key
on `agent_status` transitions only — no private object
store/quarantine, no submodule worktree capture/restore
(record-and-warn only). Those are upstream requests / later
hardening.
