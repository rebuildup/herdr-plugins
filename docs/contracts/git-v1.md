# Contract `herdr-plugins.git/v1`

Structured JSON CLI contract for the `rebuildup.git` herdr plugin.
Read commands (`status`, `files`, `diff`, `log`, `compare`, `remote`,
`pr list`, `pr status`, `pr view`, `project`) are side-effect free;
mutation commands (`stage`, `unstage`, `commit`, `branch`, `upstream`,
`fetch`, `push`, `pr create`) change the pane repository's index/refs/
remotes or the forge on the herdr host. Follows the same conventions as `herdr-plugins.inbox/v1`
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
bun run src/cli.ts log <pane_id> [--limit N] [--skip N] [--all]
    [--first-parent] [--author X] [--grep X] [--since X] [--until X]
    [--path PATH]...
bun run src/cli.ts compare <pane_id> [base [head]] [--max-bytes N]
bun run src/cli.ts stage <pane_id> [--all | --path PATH]...
bun run src/cli.ts unstage <pane_id> [--all | --path PATH]...
bun run src/cli.ts commit <pane_id> -m MSG [-m MSG]... [--allow-empty]
bun run src/cli.ts branch create <pane_id> <name> [--switch]
bun run src/cli.ts branch switch <pane_id> <name>
bun run src/cli.ts upstream <pane_id> <upstream-ref>
bun run src/cli.ts fetch <pane_id> [remote] [--prune]
bun run src/cli.ts push <pane_id> [--set-upstream] [--force-with-lease]
    [remote] [refspec]
bun run src/cli.ts remote <pane_id>
bun run src/cli.ts pr list|status|create|view <pane_id> [args]
    [--repo owner/name]
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

## `log`

```json
{
  "contract": "herdr-plugins.git/v1",
  "command": "log",
  "pane_id": "w1:p1",
  "repo_root": "/path/to/worktree",
  "limit": 50,
  "skip": 0,
  "commits": [
    {
      "sha": "abc123…",
      "parents": ["def456…"],
      "author": { "name": "…", "email": "…", "date": "2026-01-01T00:00:00+00:00" },
      "committer": { "name": "…", "email": "…", "date": "2026-01-01T00:00:01+00:00" },
      "subject": "commit subject"
    }
  ],
  "has_more": false,
  "generated_at": "…"
}
```

Options: `--limit N` (default 50, max 1000), `--skip N`, `--all`,
`--first-parent`, `--author`, `--grep`, `--since`, `--until`, and
`--path` pathspecs (repeatable). `has_more` is computed by fetching one
extra commit. There is no arbitrary revision-range positional in v1.

## `compare`

```json
{
  "contract": "herdr-plugins.git/v1",
  "command": "compare",
  "pane_id": "w1:p1",
  "repo_root": "/path/to/worktree",
  "base": "origin/main",
  "head": "HEAD",
  "merge_base": "abc123…",
  "ahead": 3,
  "behind": 1,
  "files": [ { "status": "M", "path": "src/a.ts", "old_path": null } ],
  "stat": " src/a.ts | 2 +-",
  "patch": "…bounded unified diff…",
  "patch_truncated": false,
  "patch_bytes": 1234,
  "generated_at": "…"
}
```

`compare [base [head]]` diffs `head` against the merge-base of `base` and
`head`. With no revisions, `base` is the current branch's upstream
(`@{upstream}`); a missing upstream is a `git_error`, never an empty
diff. `files` entries carry raw name-status letters (`M`, `A`, `D`,
`R100`, …); renames/copies populate `old_path` (source) and `path`
(destination). `ahead` counts head-only commits, `behind` base-only
commits. `patch` is byte-capped (`--max-bytes`, default 262144).

## Mutations: `stage` / `unstage` / `commit` / `branch` / `upstream` / `fetch` / `push`

These commands mutate the index, refs, or remote-tracking refs of the
pane's repository on the herdr host. Success payloads share the shape
`{contract, command, pane_id, repo_root, ok:true, …, generated_at}`:

- `stage`/`unstage` — `{all, paths, output}` (`output` is git's trimmed
  stdout, usually empty).
- `commit` — `{sha, summary}`; `sha` is `HEAD` after the commit.
- `branch` — `{action: "create"|"switch", name, output}`; `create
  --switch` maps to `git switch -c`.
- `upstream` — `{upstream, output}` (`git branch --set-upstream-to`).
- `fetch` — `{remote, prune, output}`; `remote` defaults to the
  configured default remote when omitted.
- `push` — `{remote, refspec, set_upstream, force_with_lease, output}`.
  Both positional args are optional; with none, `git push` uses the
  branch's configured upstream and fails structurally when none exists.
- `remote` (read-only) — `{remotes: [{name, url, pushUrl}]}`; URLs have
  any embedded userinfo credentials stripped before reporting.

Rules:

- `stage`/`unstage` require `--all` or ≥1 `--path`; other combinations
  are usage errors.
- `commit` requires ≥1 `-m`; `--allow-empty` is explicit-only. Identity
  comes from git config, never fabricated.
- Branch/upstream/remote/refspec values and pathspecs are argv elements;
  empty or `-`-prefixed values are rejected (usage error, exit 2).
- Force push exists only as `--force-with-lease` (lease-checked); plain
  `--force` is never exposed. No other destructive operations (no
  `reset --hard`, `clean`, branch delete).
- `fetch`/`push` use `remoteTimeoutMs` (default 60000) instead of
  `timeoutMs` because they are network-bound; `GIT_TERMINAL_PROMPT=0`
  still prevents credential prompts.
- Git failures — including hook failures, "nothing to commit", missing
  upstream, non-fast-forward rejections — return `{ok:false,
  error:{code:"error",kind:"git_error",message}}` on stderr with exit 1;
  message includes git stderr.
- Mutations are not manifest actions; they are invoked via CLI or agents
  with explicit arguments.

For `branch`/`upstream`, the target value may be given as the sole
positional when a pane is resolvable from `HERDR_PANE_ID` or plugin
context; otherwise the first positional is the pane and the second is
the value (`branch create <pane> <name>`). `fetch`/`push` take the pane
as the first positional followed by at most one (`fetch`) or two
(`push`) extra positionals.

## Forge: `pr list` / `pr status` / `pr create` / `pr view`

Pull-request surface backed by the host's `gh` CLI (ADR-0008). All
subcommands share `pr <action> <pane_id>`; the pane resolves the repo
exactly like other commands, and the forge repo (`owner/name`) comes
from `gh repo view` inside the repo root — honoring the user's remotes,
`GH_HOST`, and `gh auth` configuration (github.com and GHES). An
explicit `--repo owner/name` overrides detection; malformed values are
rejected before any `gh` call.

- Every `pr` invocation first runs `gh --version` (minimum 2.81.0) and
  `gh auth status`; a missing binary, old version, or missing
  authentication is a structured error (`kind: "gh_missing"` or
  `"gh_error"`), never a fabricated empty result.
- All `gh` calls are argv spawn with `GH_PROMPT_DISABLED=1`, a hard
  timeout (`remoteTimeoutMs`, default 60s), and stdin closed
  immediately — gh can never block on an interactive prompt.
- `pr list` — `gh pr list --json <fixed fields>` with `--limit`
  (1–1000), `--state open|closed|merged|all` (default `open`), and
  `--head <branch>` filters. Result: `{action:"list", repo, prs[]}`.
- `pr status` — resolves the pane's current branch (`HEAD` detached →
  `{branch:"HEAD", detached:true, pr:null}`), finds its open PR, and
  returns the same bounded view as `pr view`. No open PR is
  `{pr:null}`, not an error.
- `pr view <number>` — bounded `gh pr view --json` projection: body is
  truncated at 8000 chars (`body_truncated`), reviews capped at the
  last 10 (author/state/submittedAt only), `statusCheckRollup` capped
  at 50 entries (`checks_truncated` when cut).
- `pr create` — the only forge mutation. Requires `--title`; body via
  `--body` (inline argv) or `--body-file PATH` / `--body-file -`
  (stdin) — long bodies never appear in argv. `--draft`, `--base`,
  `--head` map to the same gh flags. The branch must already be pushed;
  gh's own push/prompt flow is not driven by the plugin. Success returns
  `{action:"create", repo, ok:true, url, number}` parsed from gh's
  output.
- `pr` appears in `mutation_commands` because `pr create` mutates the
  forge; `list`/`status`/`view` are read-only. PR state is never used
  to bypass merge/review gates — the plugin exposes state, it does not
  act on it. Merge, review comments, CI logs, and non-GitHub forges are
  out of scope (later tickets).
- gh error messages echo only the subcommand words, never argv content
  (titles/bodies may be sensitive).

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
  "commands": [
    "capability", "status", "files", "diff", "log", "compare",
    "stage", "unstage", "commit", "branch", "upstream", "fetch",
    "push", "remote", "pr", "project"
  ],
  "read_only": false,
  "mutation_commands": [
    "stage", "unstage", "commit", "branch", "upstream", "fetch",
    "push", "pr"
  ],
  "requires": { "git": true, "bun": true },
  "defaults": {
    "timeoutMs": 10000,
    "remoteTimeoutMs": 60000,
    "diffMaxBytes": 262144
  }
}
```

## Versioning

`herdr-plugins.git/v1` is stable within v0.x. Additive fields may appear;
clients must ignore unknown fields. Breaking changes bump the contract
suffix. Mutation and forge (`pr`) commands extend v1 only while every
read command's output stays intact (ADR-0007, ADR-0008); otherwise a
`v2` contract will be introduced.
