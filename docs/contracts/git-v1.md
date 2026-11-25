# Contract `herdr-plugins.git/v1`

Structured JSON CLI contract for the `rebuildup.git` herdr plugin.
Currently read-only: no command mutates the repository or herdr state.
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
bun run src/cli.ts files <pane_id> [--path PATH]... [--session NAME]
bun run src/cli.ts diff <pane_id> [--staged] [--stat|--name-status|--numstat]
    [--path PATH]... [--max-bytes N] [rev [rev]]
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

## `files`

```json
{
  "contract": "herdr-plugins.git/v1",
  "command": "files",
  "pane_id": "w1:p1",
  "repo_root": "/path/to/worktree",
  "pathspec": ["src/"],
  "files": [
    {
      "path": "src/new name.ts",
      "old_path": "src/old.ts",
      "index": "R",
      "worktree": " ",
      "kind": "renamed",
      "staged": true,
      "unstaged": false,
      "binary": false
    }
  ],
  "generated_at": "2026-11-25T00:00:00.000Z"
}
```

`files` lists every changed path in the pane's repository, parsed from
`git status --porcelain=v1 -z` (paths are verbatim, never C-quoted).
`kind` is one of `added`, `modified`, `deleted`, `renamed`, `copied`,
`typechange`, `untracked`, `conflicted`, `ignored`. `old_path` is set only
for renames/copies. `binary` is `true`/`false` for tracked changes
(derived from `git diff --numstat`) and `null` for
untracked/conflicted/ignored entries.

`--path <pathspec>` (repeatable) limits the listing via
`git status -- <path>...`. Option-like pathspec values (`-`-prefixed)
are rejected with a usage error.

## `diff`

Returns the patch (or a machine-readable summary) for the pane's
repository.

Options:

- `--staged` — diff index vs HEAD instead of worktree vs index.
- `--stat` / `--name-status` / `--numstat` — output format (exactly one;
  default is the unified patch). `--name-status` and `--numstat` use `-z`
  NUL-delimited output so unusual paths are unquoted.
- `--path PATH` — repeatable pathspec filter, passed to git after `--`.
  Option-like values are rejected.
- `--max-bytes N` — output cap (default 262144).
- positional revisions — `diff [--staged] [rev]` or `[revA revB]`; passed
  to `git diff` verbatim after `--` safety is not needed because they are
  argv elements, not shell text. Revisions are validated to reject
  option-like values (`-`-prefixed); use `--` pathspecs via `--path`
  instead of revision/path ambiguity.

Result fields:

```json
{
  "format": "patch",
  "output": "…patch text…",
  "stat_output": null,
  "name_status_output": null,
  "numstat_output": null,
  "paths": ["src/a.ts"],
  "truncated": false,
  "bytes": 1234
}
```

Exactly one of `output` (patch), `stat_output`, `name_status_output`, or
`numstat_output` carries the git output; the others are `null`.
`truncated: true` means the output was cut at the byte cap — clients must
not treat it as complete.

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
  "version": "0.2.0",
  "commands": ["capability", "status", "files", "diff", "project"],
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
