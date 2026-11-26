# Contract `herdr-plugins.projects/v1`

Structured JSON CLI contract for the `rebuildup.projects` herdr plugin —
a session/host-scoped project registry (multi-repo grouping, settings
overrides, project-defined scripts). Follows the same conventions as
`herdr-plugins.git/v1` / `herdr-plugins.inbox/v1`.

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.projects"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.projects/v1"` and the commands you need
   exist.

## Invocation

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts list [--all] [--session NAME] [--timeout MS]
bun run src/cli.ts show <id>
bun run src/cli.ts discover [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts register <repo-path> [--title T] [--id ID]
bun run src/cli.ts update <id> [--title T] [--pinned|--unpinned]
    [--archived|--unarchived] [--repo-add PATH]... [--repo-remove PATH]...
bun run src/cli.ts archive <id> | unarchive <id> | pin <id> | unpin <id>
bun run src/cli.ts settings get <id> [key]
bun run src/cli.ts settings set <id> <key> <value>
bun run src/cli.ts settings unset <id> <key>
bun run src/cli.ts scripts list <project|repo> [--repo PATH]
bun run src/cli.ts scripts run <project> <name> [--repo PATH]
    [--shell auto|sh|cmd|powershell]
bun run src/cli.ts scripts stop <run-id|project>
bun run src/cli.ts scripts results [project]
bun run src/cli.ts scripts logs <run-id>
bun run src/cli.ts scripts tick
bun run src/cli.ts repos list <project>
bun run src/cli.ts repos add <project> --path DIR [--path DIR]...
bun run src/cli.ts repos remove <project> --path DIR [--path DIR]...
```

- All commands print exactly one JSON document on stdout. Handled errors
  print `{contract, ok:false, error:{code,message}}` on **stderr** and
  exit 1; usage errors exit 2.
- Mutations are explicit-argument CLI invocations only — never manifest
  actions. `capability` reports `read_only: false` and
  `mutation_commands: ["register","update","repos add","repos remove",
  "archive","unarchive","pin","unpin","settings set","settings unset",
  "scripts run","scripts stop","scripts tick"].
  Read outputs are unchanged; script commands (#50–#53) extend v1
  additively.

## Model

A **project** groups one or more git repositories (repos/checkouts)
under a stable id:

```json
{
  "id": "my-app",
  "title": "My App",
  "repos": [
    { "root": "/abs/path", "remote": "github.com/org/repo", "added_at": "…" }
  ],
  "pinned": false,
  "archived": false,
  "created_at": "…",
  "updated_at": "…"
}
```

- `repos[].root` — absolute worktree root (`git rev-parse
  --show-toplevel`); linked worktrees resolve to their own root.
- `repos[].remote` — normalized remote identity (`host/path`, `.git`
  suffix and trailing slashes removed, scp/https/`ssh://` unified, host
  lowercased with non-default port kept, **path case preserved
  verbatim** — case-sensitive forges exist and consumers compare the
  identity exactly); `null` when the repo has no remote. This is the
  cross-checkout grouping key.
- Registry state lives only under the plugin state dir
  (`HERDR_PLUGIN_STATE_DIR`), host-global (not per-session), single
  writer lock + atomic rename. The plugin never mutates herdr state.

## `list`

`{contract, command:"list", projects: Project[], generated_at}`.
Non-archived projects only unless `--all`. Sorted pinned-first, then
title.

## `show <id>`

`{contract, command:"show", project: Project, generated_at}`.
Unknown id → `{ok:false,error:{kind:"project_not_found"}}` exit 1.

## `discover`

Enumerates git repositories reachable from the session snapshot's pane
cwds — the "what could become projects" view:

```json
{
  "contract": "herdr-plugins.projects/v1",
  "command": "discover",
  "repos": [
    {
      "cwd": "/pane/cwd",
      "root": "/repo/root",
      "remote": "github.com/org/repo",
      "registered_project_id": null
    }
  ],
  "skipped": [{ "cwd": "/not/git", "reason": "not_a_repo" }],
  "generated_at": "…"
}
```

- `repos` dedupes by canonical repo root; `registered_project_id` links
  repos already in the registry.
- `skipped` reports non-git cwds (`not_a_repo`, `bare_repo`,
  `git_missing`, `timeout`) — never silently dropped, never fabricated.
- Requires a reachable herdr session (socket resolution identical to
  the git plugin); `list`/`show`/`capability` work without herdr.

## `register <repo-path>`

Creates a project from an explicit repo path (positional or `--path`).
`--title` defaults to the repo root basename; `--id` defaults to a
slug of the basename (`my-app`), suffixed `-2`, `-3`, … on collision.
An explicit `--id` that already exists fails `project_exists`.

The path must resolve to a non-bare git work tree (`resolveRepo`); the
stored `repos[0].root` is the canonical worktree root and
`repos[0].remote` the normalized remote identity (`null` without a
remote). Re-registering a repo root already owned by any project fails
`repo_already_registered` (with `project_id`). Non-git paths surface the
git contract kinds (`not_a_repo`, `bare_repo`, `git_missing`, `timeout`).

Response: `{contract, command:"register", project, generated_at}`.

## `update <id>`

Mutates title/pin/archive and repo membership in one locked write:

- `--title T` — rename.
- `--pinned` / `--unpinned`, `--archived` / `--unarchived` — mutually
  exclusive pairs; unknown combos are usage errors.
- `--repo-add PATH` (repeatable) — resolves the path to a git work tree
  and appends `{root, remote, added_at}`. Adding a root owned by another
  project fails `repo_already_registered`; adding one already in this
  project is a no-op.
- `--repo-remove PATH` (repeatable) — removes membership by canonical
  root. The path may be a live repo (resolved via `resolveRepo`) or a
  stale path canonicalized lexically, so entries can be dropped after a
  checkout is deleted. Unknown roots fail `repo_not_found`.

All checks run inside the registry lock, so concurrent updates cannot
interleave. Unknown id → `project_not_found` (with `project_id`).
Response: `{contract, command:"update", project, generated_at}`.

## `repos list <project>`

Lists the repos bound to a project — the read side of multi-checkout
grouping (#51) plus the repo↔worktree/diff read association (#184,
ADR-0029 §2). Each entry carries the stored membership fields plus
cheap live git inspection:

```json
{
  "contract": "herdr-plugins.projects/v1",
  "command": "repos list",
  "project_id": "my-app",
  "repos": [
    {
      "root": "/abs/repo",
      "remote": "github.com/org/repo",
      "added_at": "…",
      "branch": "main",
      "dirty": false,
      "has_submodules": true,
      "worktree_submodules": "recursive",
      "worktrees": [
        {
          "path": "/abs/repo-wt",
          "branch": "feature",
          "dirty": false,
          "has_submodules": false,
          "is_linked_worktree": true,
          "is_bare": false,
          "is_detached": false,
          "is_prunable": false,
          "label": "feature",
          "open_workspace_id": "wKN",
          "panes": [
            {
              "pane_id": "wKN:p1",
              "workspace_id": "wKN",
              "cwd": "/abs/repo-wt",
              "commands": {
                "status": "status wKN:p1",
                "diff": "diff wKN:p1",
                "files": "files wKN:p1",
                "compare": "compare wKN:p1 <base> <head>"
              },
              "status": {
                "contract": "herdr-plugins.git/v1",
                "ok": true,
                "repo_root": "/abs/repo-wt",
                "branch": "feature",
                "detached": false,
                "changes": { "staged": 0, "unstaged": 2, "untracked": 1, "conflicted": 0 }
              },
              "status_error": null
            }
          ],
          "panes_unavailable": false
        }
      ],
      "worktrees_error": null
    }
  ],
  "skipped": [{ "root": "/abs/gone", "reason": "git_error" }],
  "worktrees_skipped": [{ "path": "/abs/foreign-wt", "reason": "not_member_repo" }],
  "generated_at": "…"
}
```

- `root`/`remote`/`added_at` are the stored `ProjectRepo` fields;
  `remote` is the normalized cross-checkout identity (`null` without a
  remote — the identity then falls back to the root path).
- `branch` (`git rev-parse --abbrev-ref HEAD`), `dirty`
  (`git status --porcelain` non-empty), and `has_submodules`
  (`git submodule status` non-empty output → `true`, empty output →
  `false`, **non-zero exit or probe failure → `null` = unknown**) are
  fetched live per repo under the command timeout. The submodule probe
  is best-effort: its failure never hides the branch/dirty fields and
  never guesses `false`.
- A repo that is unreachable or no longer a work tree keeps its stored
  fields with `branch`/`dirty`/`has_submodules` = `null` and is also
  reported in `skipped` with a git-contract `reason` — never fabricated.
- `worktree_submodules` is a read-only advisory: the repo's `t3.json`
  `worktreeSubmodules` value (`recursive`|`top-level`|`none`, `null`
  when absent/unparseable). Nothing consumes it — submodule init on
  worktree creation is a herdr/Worktrunk-side gap (ADR-0029 §3).
- `worktrees` is the herdr `worktree.list` association for the member
  repo (socket method, `cwd` = member root, `trust_repository: false`
  always — an untrusted-repo failure is reported, never retried with a
  trust grant). Each entry is verified by `git rev-parse
  --git-common-dir` equality with the member repo — the authoritative
  same-repo test covering linked worktrees — then enriched by
  `inspectRepo` (`branch`/`dirty`/`has_submodules`). Checkouts that
  fail verification or are gone are reported in `worktrees_skipped`
  (`no_path`, `worktree_gone`, `not_member_repo`, git kinds), never
  attributed by guesswork. `worktrees` is `[]` when herdr reports no
  worktrees.
- `worktrees_error` is `null` on success; otherwise
  `{reason, detail?}` — `session_unreachable` (socket connect/timeout),
  an RPC `code` (e.g. `repo_untrusted`), or `repo_mismatch` (herdr's
  `source.repo_root` canonicalizes to a different repo than the
  member). On error `worktrees` is `null` — the association is
  unavailable, not empty.
- `open_workspace_id` is herdr's `WorktreeInfo.open_workspace_id`;
  `panes` resolves it via `session.snapshot` (panes whose
  `workspace_id` matches). `panes_unavailable: true` marks a stale or
  unresolvable workspace id — `panes` is then `[]`.
- `panes[].commands` are pane-addressed `herdr-plugins.git/v1` read
  invocations (`status`/`diff`/`files`/`compare`) — pointers only. The
  git contract is pane-addressed, so a worktree with no open workspace
  has NO diff surface: `panes` is `[]` and no diff fields exist.
- `panes[].status` is a live compact `status` summary fetched through
  the sibling `rebuildup.git` plugin's public CLI (ADR-0013 env-pin
  spawn: `HERDR_PROJECTS_ROOT_GIT` override → sibling `plugins/git` →
  `herdr plugin list`; child env is scrubbed of all ambient `HERDR_*`).
  At most 8 status calls per member repo (`MAX_GIT_STATUS_CALLS`);
  beyond that `status_error.kind = "budget_exceeded"`. Failures are
  structured in `status_error` (`plugin_unavailable`, the git
  plugin's own error `kind`, `contract_mismatch`, `spawn_error`) —
  pointers are still emitted.
- Read-only; the plugin never creates/removes worktrees, workspaces,
  or panes (lifecycle stays herdr/Worktrunk). Unknown project id →
  `project_not_found`.

## `repos add` / `repos remove <project>`

Explicit repo-membership management, thin aliases over the exact same
locked code path as `update --repo-add`/`--repo-remove` (#51):

- `repos add <project> --path DIR` (repeatable) resolves each path via
  `resolveRepo` + `repoRemoteIdentity` and appends
  `{root, remote, added_at}`. Same rules as `update`: a root owned by
  another project fails `repo_already_registered`; a root already in
  this project is a no-op; non-git paths surface the git kinds
  (`not_a_repo`, `bare_repo`, …). Use it to attach another checkout or
  clone of the same `remote` identity (worktrees resolve to their own
  root and share the identity).
- `repos remove <project> --path DIR` (repeatable) drops membership by
  canonical root; the path may be live or stale (lexically
  canonicalized), so entries can be removed after a checkout is
  deleted. Unknown roots fail `repo_not_found`.
- Both are non-destructive state mutations; there is still no delete.
  Response: `{contract, command:"repos add"|"repos remove", project,
  generated_at}`.

## `archive` / `unarchive` / `pin` / `unpin <id>`

Thin flag setters over the same locked write. `archive` is non-destructive:
the project, its repos, and its settings are retained; `list` hides
archived projects unless `--all`, and `show`/`settings` still resolve.
There is no delete command. Response shape matches `update` with the
respective `command` name.

## `settings get|set|unset`

Project-scoped settings overrides, stored as one JSON document per
project at `<stateDir>/settings/<id>.json` under a dedicated lock +
atomic rename. Values are verbatim strings; typed interpretation is the
consumer's job (#50 scripts resolution).

- `settings get <id>` → `{op:"get", project, settings:{...}}`
- `settings get <id> <key>` → `{op:"get", project, key, value}` (`null` when unset)
- `settings set <id> <key> <value>` → remaining args join with spaces
- `settings unset <id> <key>` → idempotent removal

Keys are allow-listed (`SETTINGS_ALLOW_LIST` in `state.ts`): currently
`defaultProjectScripts`, `defaultThreadEnvMode`, `worktreeSubmodules`,
`worktreeCleanup`, `display.title`, `display.iconPath` — the upstream
project-scoped keys relevant to scripts and display. Any other key fails
`settings_key_not_allowed`. The list extends additively; it never
accepts arbitrary keys. A corrupt settings file reads as empty
(overrides are non-authoritative); the next `settings set`/`unset`
rewrites the file wholesale from that empty base — corrupt bytes are
never partially merged and no `settings_corrupt` error is raised,
matching the `runs.json` policy.

## `scripts list <project|repo>`

Read-only resolution of project script definitions (#50). The
positional argument is matched against registered project ids first;
otherwise it is treated as a repo path resolved via `resolveRepo`
(non-git paths surface the git contract kinds). A repo path already
owned by a project picks up that project's settings override.

`--repo PATH` (project targets only) selects which member repo's
`t3.json` to read for multi-repo projects; it must canonicalize to a
registered member root or the command fails `repo_not_found`. Default
is the project's first registered repo. A project with no repos fails
`no_repos`.

Response:

```json
{
  "contract": "herdr-plugins.projects/v1",
  "command": "scripts list",
  "project_id": "my-app",
  "repo_root": "/abs/repo",
  "scripts": [
    {
      "id": "dev",
      "name": "Dev server",
      "command": "bun run dev",
      "icon": "play",
      "runOnWorktreeCreate": true,
      "source": "t3.json"
    }
  ],
  "generated_at": "…"
}
```

(`project_id` is `null` for a repo path not owned by any project.
Optional upstream fields absent from the source layer are omitted from
the JSON, not nulled.)

Each script carries `source`: `override` | `env-default` | `t3.json` |
`builtin`. Resolution picks the first active layer wholesale:

1. **override** — the project's `defaultProjectScripts` settings key
   (a verbatim JSON array of script names or definition objects; an
   explicit `[]` resolves to zero scripts).
2. **env-default** — `defaultScripts` in the plugin config dir's
   `config.json` (same entry shapes).
3. **t3.json** — `scripts[]` at the repo root (absent or empty `[]`
   falls through).
4. **builtin** — compiled-in defaults. Upstream T3 Code defines no
   builtin project scripts, so this layer is currently empty; it exists
   so a future set needs no contract change.

String entries are name references resolved against definition entries
of lower-priority layers (in priority order), then definitions inside
the selected layer; `source` reports where the *definition* came from.
An unresolvable name fails `unknown_script`; a malformed layer fails
`invalid_script_list` (both carry `layer`). A present-but-broken
`t3.json` fails `t3json_invalid` (carries `path`, `reason`).

`t3.json` parsing mirrors upstream
`packages/contracts/src/t3ProjectFile.ts`: `$schema`, `iconPath`,
`defaultThreadEnvMode` (`local`|`worktree`), `worktreeSubmodules`
(`recursive`|`top-level`|`none`), `worktreeSparsePatternsPath`, and
`scripts[]` (name/command required; optional icon/runOnWorktreeCreate/
runOnSettle/stopOnSettle/async/previewUrl/autoOpenPreview; max 50
entries; paths capped at 512 chars). Unknown keys are ignored;
malformed JSON or schema violations are structured errors.

**Trust boundary:** a repository's `t3.json` is trusted because the
user registered or explicitly operates that repository — its script
commands run with the user's privileges. `scripts list` only *lists*
definitions; `scripts run` executes them (below) and inherits the same
trust boundary: running a script is arbitrary code execution with the
user's privileges inside a visible herdr pane.

## `scripts run <project> <name> [--repo PATH]`

Executes a resolved script definition in a **dedicated herdr execution
surface** created via the Socket API (ADR-0010): `workspace.create
{cwd: repoRoot, label}` → the workspace's `root_pane` receives the
command via `pane.send_input`, and completion is awaited with
`pane.wait_for_output` on a per-run output marker. The plugin never
injects input into panes it did not create.

- `<project>` must be a registered project id. `<name>` matches a
  resolved script's `name` or `id`; zero matches fail `unknown_script`,
  multiple fail `ambiguous_script`.
- **Repo selection is explicit.** `--repo PATH` must canonicalize to a
  registered member root (`repo_not_found` otherwise). Without `--repo`:
  a single-repo project uses that repo; a multi-repo project FAILS
  `repo_ambiguous` (carrying the member `repos` list) — the runner never
  silently picks the first repo.
- Script definitions resolve against the **selected repo's** `t3.json`
  plus the project's settings/env/builtin layers (same machinery as
  `scripts list`).
- The command is injected as **two `pane.send_input` lines** (Enter
  after each): line 1 is the user command (or a script-file
  invocation), line 2 is the shell-family marker echo. Sending them as
  separate parsed command lines is what makes cmd.exe's
  `%ERRORLEVEL%` correct (it would expand at parse time on a shared
  `cmd1 & echo ...` line) and works uniformly for sh/cmd/powershell.
- **Shell family detection (#67).** The marker line is shell-specific,
  so the family is resolved before composing it, in precedence order:
  1. `--shell sh|cmd|powershell` — explicit override (`auto` = detect);
     invalid values fail `invalid_shell`.
  2. `pane.process_info` foreground process name (`shell_pid` match
     preferred): POSIX names (sh/bash/zsh/dash/ash/ksh/…) → `sh`,
     `cmd[.exe]` → `cmd`, `powershell[.exe]`/`pwsh[.exe]` → `powershell`.
  3. Conservative host-OS default when detection is inconclusive
     (empty foreground after bounded retries, or `process_info`
     transport failure): Windows host → `cmd`, otherwise `sh`.
     Recorded as `shell_source:"host_default"` — never silent.
  A positively identified unsupported shell (fish, nu, xonsh, …) fails
  `shell_unknown`; a non-shell foreground fails `not_a_shell`. Both
  close the just-created pane and persist NO run record — a guessed
  wrapper is never injected.
- **Per-family marker line** (line 2):
  - `sh`: `echo __HERDR_DONE_<run-id>__=$?`
  - `cmd`: `echo __HERDR_DONE_<run-id>__=%ERRORLEVEL%`
  - `powershell`: `echo "__HERDR_DONE_<run-id>__=$( if ($null -ne
    $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } )"` —
    `$LASTEXITCODE` covers native commands; cmdlet-only scripts fall
    back to `$?` mapped to 0/1 (powershell caveat documented).
  The echoed input line never matches the digit regex in any family.
- Commands containing newlines or longer than 4000 chars are first
  written to a script file under the plugin state dir
  (`runs/<run-id>.sh|.cmd|.ps1`, per family; `.cmd` content is CRLF)
  and invoked by a short line: `sh '<path>'` / `call "<path>"` /
  `& '<path>'`. Script files are retained like run logs (audit trail).
  Note: `.ps1` invocation is subject to the pane's PowerShell
  execution policy; `.cmd`/`.sh` paths use host-native separators
  (a POSIX pane on a Windows host is out of scope). Trade-off of the
  two-line design: a command that reads stdin may consume the queued
  marker line — the run then times out `running` rather than reporting
  a wrong result; a command containing a bare `exit` kills the pane's
  interactive shell before the marker prints, reconciling to
  `unknown` (use a subshell/`sh -c` for exit-code probes).
- **Completion:** `pane.wait_for_output` (`source:"recent_unwrapped"`,
  regex `__HERDR_DONE_<run-id>__=(-?\d+)`) blocks up to `runTimeoutMs`
  (plugin config `config.json`, default 600000 ms = 10 min). The echoed
  input line cannot match (it contains the rc expression, never bare
  digits), and the run-id
  nonce prevents cross-run collisions. The exit code is parsed from the
  marker digits ONLY — never inferred from pane text, process liveness,
  or pane close events.
- **Results:** marker exit 0 → `success`; non-zero → `failed` (with
  `exit_code`). Wait timeout → the run stays `running`, the pane is left
  alone (never killed implicitly). Pane vanished before the marker →
  `unknown` — never fabricated success.
- **Durable completion receipt (#68):** the marker line persists in
  pane scrollback after the wait times out, so completion is
  recoverable without polling or a daemon. `scripts results`/`logs`
  lazily re-scan the owned pane's scrollback (`pane.read`,
  `recent_unwrapped`, last 2000 lines) for
  `__HERDR_DONE_<run-id>__=<code>`; a found marker finalizes the record
  exactly like the live wait path (`success`/`failed` + `exit_code` +
  `finished_at` + bounded log tail). `events.subscribe`
  `pane.output_matched` was evaluated and rejected: it requires a
  persistent subscription connection a one-shot CLI cannot hold after
  exit, events are not replayed to late subscribers, and ADR-0002
  forbids a daemon — the scrollback receipt is the durable record.
- A run record is persisted BEFORE the command is injected, so a crash
  mid-run still leaves an honest trail.
- `pane.report_metadata` projects a display-only `script_<name>` token
  (`running`/`stopping`/`success`/`failed`/`stopped`/
  `stop_unconfirmed`/`unknown`) on the execution pane; projection
  failures never fail the run.

Response: `{contract, command:"scripts run", run: ScriptRun,
generated_at}`.

### `ScriptRun` record

Persisted at `<stateDir>/runs.json` (single-writer lock + atomic
rename, dedicated `runs.json.lock`):

```json
{
  "run_id": "run-mj3k2x-9f3ab1",
  "project_id": "my-app",
  "script": { "id": "dev", "name": "Dev server", "command": "bun run dev", "source": "t3.json" },
  "repo": { "root": "/abs/repo", "remote": "github.com/org/repo" },
  "pane_id": "wKN:p1",
  "workspace_id": "wKN",
  "tab_id": "wKN:t1",
  "cwd": "/abs/repo",
  "command_line": "bun run dev\necho __HERDR_DONE_run-…__=$?",
  "script_path": null,
  "shell_family": "sh",
  "shell_source": "host_default",
  "started_at": "…",
  "finished_at": "…",
  "exit_code": 0,
  "result": "success",
  "host": "my-mac.local",
  "session_key": "my-mac.local /Users/me/.config/herdr/sessions/main/herdr.sock",
  "stop_requested_at": null,
  "log_path": "runs/run-mj3k2x-9f3ab1.log",
  "error": null,
  "trigger": { "kind": "worktree.created", "worktree_path": "/abs/wt", "event_received_at": "…" }
}
```

`result` ∈ `running | stopping | stop_unconfirmed | success | failed |
stopped | unknown`. `running` means the marker was not observed within
the wait — it does NOT assert the process is alive. `stopping` means a
stop was requested (ctrl+c accepted) but exit is not yet confirmed;
`stop_unconfirmed` means the bounded confirmation window elapsed
without evidence. `log_path`/`script_path` are relative to the plugin
state dir (`null` when absent). `shell_family` ∈ `sh | cmd |
powershell`, `shell_source` ∈ `flag | process_info | host_default`
(both `null` on pre-#67 records). `trigger` (#180, additive, absent on
records predating it) records the run origin: `{kind:"manual"}` for
`scripts run`, `{kind:"worktree.created", worktree_path,
event_received_at}` for auto-triggered runs.

**Ownership tuple (schema v2, #66).** `host` + `session_key` (the
`sessionKeyFor` discriminator: hostname + canonical socket path) +
`pane_id` (herdr never reuses pane ids) + `workspace_id`/`tab_id` +
`started_at` together identify the execution surface a record may
target. v1 records lack `host`/`session_key`/`stop_requested_at`; they
load with those fields `null` and are verified by pane context only.
Before ANY input/close/read (`scripts stop`, `results` liveness,
`logs` capture, stop confirmation) the runner re-validates ownership
via `pane.get`: a `pane_not_found`, a host/session mismatch
(`foreign` — short-circuits before any socket call), or a
workspace/tab/pane_id disagreement (`pane_mismatch`) yields a
structured `stale_pane` outcome / `unknown` record and **zero side
effects** on the pane — input and close are never sent to a pane the
record cannot prove it owns.

## `scripts stop <run-id|project>`

Stops runs owned by this plugin. The target resolves to run records: an
exact `run_id`, a unique `run_id` prefix (`ambiguous_run` on collision),
or a project id (all its active runs; `run_not_found` when nothing
matches). Active results are `running | stopping | stop_unconfirmed`.

For each active run the plugin FIRST re-validates pane ownership
(`pane.get` + recorded host/session/workspace/tab context — see the
ownership tuple above). A foreign or mismatched pane produces a
`stale_pane` outcome and no pane side effects; a vanished pane is
`pane_gone` (`running` → `unknown`, stopping states → `stopped`, since
pane absence after a stop request IS exit evidence).

For an owned `running` run: `pane.send_keys ["ctrl+c"]` to the RECORDED
`pane_id` only → record `stopping` + `stop_requested_at` → `stopGraceMs`
(config, default 2000) → bounded `pane.read` log capture →
`pane.close` → **confirmation** within `stopConfirmMs` (config, default
5000): the pane is gone (`pane.get` → not_found) OR
`pane.process_info` reports an empty foreground process list (shell
regained the tty). Only then is the run recorded `stopped`.
ctrl+c alone is NEVER treated as stopped. Without evidence inside the
window the run is recorded `stop_unconfirmed` (request accepted,
exit unproven); `scripts results`/`logs` keep re-checking and promote it
to `stopped` once evidence appears. `stopping`/`stop_unconfirmed`
records re-targeted by `scripts stop` skip the redundant ctrl+c and go
straight to close+confirm. Already-finished runs are reported
`already_finished`. There is no way to address any pane the plugin did
not create and record.

Response: `{contract, command:"scripts stop", outcomes:[{run, action}],
generated_at}` where `action` ∈ `stopped | already_finished |
pane_gone | stale_pane | stop_unconfirmed`. Fails `no_running_runs` when
no run was acted on (all `already_finished`).

## `scripts results [project]`

Lists run records newest-first, optionally filtered by project id
(`project_not_found` for unknown ids). Active records
(`running`/`stopping`/`stop_unconfirmed`) are reconciled lazily AFTER
ownership re-validation: `pane.get` plus the recorded host/session/
workspace/tab context. For an OWNED pane the scrollback is then
re-scanned once for the durable completion marker (#68): marker found
→ the run is finalized `success`/`failed` with the parsed `exit_code`,
`finished_at`, and a bounded log tail — this recovers runs whose
`pane.wait_for_output` timed out, across CLI invocations and herdr
restarts, with no polling loop. A vanished pane flips `running` →
`unknown` (persisted) and confirms `stopping`/`stop_unconfirmed` →
`stopped`;
`stopping` states with an empty foreground process list also promote to
`stopped`. A foreign host/session record is never probed through the
wrong socket — its `error` is annotated and the result preserved for
the owning session. A pane context mismatch marks the record `unknown`
(`stale_pane`). Socket failures leave the record unchanged — liveness
is unknown, not fabricated. Bounded by the small number of concurrent
runs.

Response: `{contract, command:"scripts results", project_id?, runs:
ScriptRun[], generated_at}`.

## `scripts logs <run-id>`

Returns the bounded log for one run (`run_id` exact or unique prefix,
`run_not_found`/`ambiguous_run` otherwise). On completion the runner
stores the pane read tail — capped at `runLogMaxBytes` (config, default
65536 bytes, tail kept with a truncation marker) at
`<stateDir>/runs/<run-id>.log`. When the run is active, ownership
re-validation runs first and the pane scrollback is re-scanned once
for the completion marker (#68) — a found marker finalizes the record
(`success`/`failed` + `exit_code`) and its tail becomes the log. With
no marker, a bounded `pane.read` (`recent_unwrapped`, last 2000 lines)
captures the tail on demand — only after ownership re-validation
passes; foreign/mismatched panes are never read. A `running` run whose
pane is gone is marked `unknown`; a stopping-state run whose pane is
gone is confirmed `stopped`.

Response: `{contract, command:"scripts logs", run_id, run, log_path,
log, generated_at}` (`log` may be `null`).

## Auto triggers — `runOnWorktreeCreate` (#180)

`runOnWorktreeCreate: true` script flags now execute via herdr's
`worktree.created` plugin-hook event — the same `[[events]]` manifest
mechanism `rebuildup.automations` uses (ADR-0022 addendum). No daemon,
no polling, no `events.subscribe` watch process (ADR-0002).

- **Hook** (`src/hook.ts`, manifest `[[events]] on="worktree.created"`):
  performs NO socket/git/script work. It appends a
  `PendingTriggerMark` (`event`, `received_at`, emitting session's
  resolved `socket_path`, `worktree.path`, `workspace_id`, raw `data`)
  to `state.json`'s `pending_triggers` under the single-writer lock,
  capped at 200 marks (oldest dropped, counted in
  `pending_triggers_dropped`). Identical pending marks (same
  event+session+worktree path) collapse — herdr redelivery cannot
  stack fires. Malformed payloads, missing `worktree.path`, and every
  other event name exit 0 recording nothing.
- **Drain** (lazy): the next `scripts tick`, `scripts run`,
  `scripts stop`, `scripts results`, or `scripts logs` invocation
  evaluates pending marks — `list`, `capability`, and `help` never
  drain. `scripts tick` is the explicit entrypoint an external
  scheduler/watch process can call.
- **Repo resolution (no guessing):** each mark's `worktree_path` is
  resolved via `resolveRepo`; the repo group is identified by
  `git rev-parse --git-common-dir` (all linked worktrees of a repo
  share it) and matched against every non-archived project's
  `repos[]` members' common dirs. Zero matches → skip
  `repo_not_registered`; multiple projects → skip `ambiguous_project`.
  Deleted checkouts → `worktree_gone`; non-git paths surface the git
  kinds; unreachable members simply cannot match.
- **Script resolution** reuses the #50 layered resolution
  (settings override → env `defaultScripts` → the EVENT worktree's
  `t3.json` → builtin) with structured per-mark errors (`t3json_invalid`,
  `invalid_script_list`, `unknown_script`) — one broken repo never
  kills the drain. Only `runOnWorktreeCreate === true` scripts fire;
  none → skip `no_run_on_worktree_create_scripts`.
- **Execution** is the unchanged ADR-0010 runner (`workspace.create` →
  `pane.send_input` → marker wait) against the session socket recorded
  on the mark — the session that owns the worktree, regardless of which
  session the draining CLI targets. Each fired run's `ScriptRun.trigger`
  records `{kind:"worktree.created", worktree_path,
  event_received_at}`.
- **Drain report:** merged into the invoking command's payload as
  `triggers: {fired[], skipped[], duplicates, pending_remaining,
  session_unreachable?}` when non-empty. `fired[]` entries carry
  `{run_id, project_id, script, worktree_path, result}`; `skipped[]`
  carry `{worktree_path, socket_path, reason, detail?}`. Marks for
  unreachable session sockets stay pending (transient outage never
  loses a trigger); evaluated marks are consumed under the lock before
  execution so concurrent drains cannot double-fire.
- **Honesty:** skipped marks are reported, never silent; run results
  keep the `running|success|failed|stopped|unknown` semantics — no
  fabricated success. `runOnSettle`/`stopOnSettle` remain
  unimplemented pending #181/#182.

## `scripts tick`

`{contract, command:"scripts tick", triggers?, generated_at}` —
drains pending `worktree.created` marks (see above). Exit 0 on success;
the drain itself never fails the command (per-mark outcomes are
reported in `triggers.skipped`).

## Remaining auto-trigger gap

`runOnSettle`/`stopOnSettle` have no faithful trigger source yet —
settle is plugin-owned organize state (inbox), not a herdr event.
Tracked by #181 (design) / #182 (implementation). #32 automations own
scheduled/event-driven execution generally.

## Errors

`kind` values mirror the git contract: `git_missing`, `timeout`,
`git_error`, `not_a_repo`, `bare_repo`, plus `project_not_found`,
`project_exists`, `repo_already_registered`, `repo_not_found`,
`invalid_project_id`, `settings_key_not_allowed`, `t3json_invalid`,
`invalid_script_list`, `unknown_script`, `no_repos`, plus the script
runner kinds `repo_ambiguous`, `ambiguous_script`, `ambiguous_run`,
`run_not_found`, `no_running_runs`, `script_run_error`, `stale_pane`,
`shell_unknown`, `not_a_shell`, `invalid_shell` (`shell_unknown` /
`not_a_shell` abort `scripts run` before injection; `invalid_shell` is
a `--shell` value error). Errors may
carry extra fields (`project_id`, `key`, `root`, `repos`, `name`,
`matches`, `run_id`, `target`, `path`, `reason`, `layer`).
