# Contract `herdr-plugins.git/v1`

Structured JSON CLI contract for the `rebuildup.git` herdr plugin.
Stage 1 is read-only: no command mutates the repository or herdr state.
Follows the same conventions as `herdr-plugins.inbox/v1`
(`docs/contracts/inbox-v1.md`).

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.git"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.git/v1"` and the commands you need exist.
3. Run `status` / `diff` / `project` with the target pane.

## Invocation

```bash
cd "$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id=="rebuildup.git") | .plugin_root')"
bun run src/cli.ts status <pane_id> [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts diff <pane_id> [--staged] [--stat] [--max-bytes N] [rev [rev]]
bun run src/cli.ts project <pane_id> [--session NAME]
bun run src/cli.ts capability
```

- Pane id may be omitted when `HERDR_PANE_ID` or the plugin action context
  supplies it.
- Requires `git` on `PATH` and `bun` (plugin runtime prerequisite).
- All commands print exactly one JSON document on stdout. Handled errors
  print `{contract, ok:false, error:{code,message}}` on **stderr** and exit
  1; usage errors exit 2.

## Target selection

Same resolution order as inbox: `--socket` → `HERDR_SOCKET_PATH` →
`--session`/`HERDR_SESSION` → default session socket. Remote hosts follow
the inbox rule: run the CLI **on the herdr host**; socket forwarding is not
a supported path.

## `status`

```json
{
  "contract": "herdr-plugins.git/v1",
  "command": "status",
  "pane_id": "w1:p1",
  "generated_at": "2026-11-25T00:00:00.000Z",
  "repo": {
    "root": "/path/to/worktree",
    "git_dir": "/path/to/.git",
    "git_common_dir": "/path/to/repo/.git",
    "bare": false,
    "inside_work_tree": true
  },
  "branch": {
    "name": "feature/x",
    "detached": false,
    "upstream": "origin/feature/x",
    "ahead": 2,
    "behind": 0
  },
  "changes": { "staged": 1, "unstaged": 2, "untracked": 3, "conflicted": 0 },
  "warnings": []
}
```

Fields:

- `repo.root` — `git rev-parse --show-toplevel` of the pane cwd.
- `repo.git_dir` / `git_common_dir` — distinguish linked worktrees.
- `branch.name` — `HEAD` when detached; `upstream`/`ahead`/`behind` are
  `null` when no upstream is configured.
- `changes` — file counts from `git status --porcelain=v1` (see spec).

Error codes (in `error.code` or a structured `error.kind`): `not_a_repo`
(pane cwd outside any work tree), `bare_repo`, `git_missing`,
`timeout`, `git_error` (non-zero git exit, message includes stderr),
`pane_not_found`, `usage`.

## `diff`

Returns the patch (or stat summary) for the pane's repository.

Options:

- `--staged` — diff index vs HEAD instead of worktree vs index.
- `--stat` — `git diff --stat` summary instead of the patch.
- `--max-bytes N` — output cap (default 262144).
- positional revisions — `diff [--staged] [rev]` or `[revA revB]`; passed
  to `git diff` verbatim after `--` safety is not needed because they are
  argv elements, not shell text. Revisions are validated to reject
  option-like values (`-`-prefixed) unless after `--`.

Result adds:

```json
{ "diff": "...", "stat": null, "truncated": false, "bytes": 1234 }
```

`truncated: true` means the patch was cut at the byte cap — clients must
not treat it as complete. `--stat` output is never truncated in practice
but the flag still applies.

## `project`

Computes `status` for the pane and reports metadata tokens via
`pane.report_metadata` (source `rebuildup.git`):

| Token | Meaning |
| --- | --- |
| `git_branch` | branch short name or `HEAD` (detached); cleared when not a repo |
| `git_changes` | total changed files as decimal string; `"0"` when clean |
| `git_ahead_behind` | `+A/-B` vs upstream; cleared when unknown |

Result echoes the `status` payload plus `metadata: {applied: bool,
warnings: []}`. Projection failure is a warning, not a command failure —
the status data remains authoritative.

## `capability`

```json
{
  "contract": "herdr-plugins.git/v1",
  "plugin": "rebuildup.git",
  "version": "0.1.0",
  "commands": ["capability", "status", "diff", "project"],
  "read_only": true,
  "requires": { "git": true, "bun": true },
  "defaults": { "timeoutMs": 10000, "diffMaxBytes": 262144 }
}
```

## Versioning

`herdr-plugins.git/v1` is stable within v0.x. Additive fields may appear;
clients must ignore unknown fields. Breaking changes bump the contract
suffix. Stage-2 mutation commands will extend v1 only if they keep the
read contract intact; otherwise a `v2` contract will be introduced.
