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
  suffix and casing removed, scp/https unified); `null` when the repo
  has no remote. This is the cross-checkout grouping key.
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
  (`git submodule status` non-empty; non-zero exit or empty output =
  false) are fetched live per repo under the command timeout.
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
(overrides are non-authoritative).

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
- The command is injected as ONE `pane.send_input` line:
  `<command>; echo "__HERDR_DONE_<run-id>__=$?"`. Commands containing
  newlines or longer than 4000 chars are first written to an
  executable `/bin/sh` script file under the plugin state dir
  (`runs/<run-id>.sh`) and invoked by path — a documented POSIX-sh
  limitation for that edge case.
- **Completion:** `pane.wait_for_output` (`source:"recent_unwrapped"`,
  regex `__HERDR_DONE_<run-id>__=(-?\d+)`) blocks up to `runTimeoutMs`
  (plugin config `config.json`, default 600000 ms = 10 min). The echoed
  input line cannot match (it contains literal `$?`), and the run-id
  nonce prevents cross-run collisions. The exit code is parsed from the
  marker digits ONLY — never inferred from pane text, process liveness,
  or pane close events.
- **Results:** marker exit 0 → `success`; non-zero → `failed` (with
  `exit_code`). Wait timeout → the run stays `running`, the pane is left
  alone (never killed implicitly), and `scripts results`/`logs`
  re-check liveness lazily. Pane vanished before the marker →
  `unknown` — never fabricated success.
- A run record is persisted BEFORE the command is injected, so a crash
  mid-run still leaves an honest trail.
- `pane.report_metadata` projects a display-only `script_<name>` token
  (`running`/`success`/`failed`/`stopped`/`unknown`) on the execution
  pane; projection failures never fail the run.

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
  "command_line": "bun run dev; echo \"__HERDR_DONE_run-…__=$?\"",
  "script_path": null,
  "started_at": "…",
  "finished_at": "…",
  "exit_code": 0,
  "result": "success",
  "log_path": "runs/run-mj3k2x-9f3ab1.log",
  "error": null,
  "trigger": { "kind": "inbox.settled", "pane_id": "w1:p2", "transition_seq": 41, "transition_at": "…" }
}
```

`result` ∈ `running | success | failed | stopped | unknown`.
`running` means the marker was not observed within the wait — it does
NOT assert the process is alive. `log_path`/`script_path` are relative
to the plugin state dir (`null` when absent). `trigger` (#180, #182,
additive, absent on records predating it) records the run origin:
`{kind:"manual"}` for `scripts run`,
`{kind:"worktree.created", worktree_path, event_received_at}` for
worktree-create auto-triggers, and `{kind:"inbox.settled", pane_id,
transition_seq, transition_at}` for settle auto-triggers.

## `scripts stop <run-id|project>`

Stops runs owned by this plugin. The target resolves to run records: an
exact `run_id`, a unique `run_id` prefix (`ambiguous_run` on collision),
or a project id (all its `running` runs; `run_not_found` when nothing
matches). For each `running` run the plugin sends `pane.send_keys
["ctrl+c"]` to the RECORDED `pane_id` only, waits `stopGraceMs` (config,
default 2000), captures a bounded log tail, then `pane.close`. The run
is recorded `stopped`. Already-finished runs are reported
`already_finished`; a vanished pane is recorded `unknown`. There is no
way to address any pane the plugin did not create and record.

Response: `{contract, command:"scripts stop", outcomes:[{run, action}],
generated_at}` where `action` ∈ `stopped | already_finished |
pane_gone`. Fails `no_running_runs` when nothing was actually stopped.

## `scripts results [project]`

Lists run records newest-first, optionally filtered by project id
(`project_not_found` for unknown ids). `running` records are reconciled
lazily: `pane.get` is re-checked per running run and a vanished pane
flips the record to `unknown` (persisted). Socket failures leave the
record `running` — liveness is unknown, not fabricated. One socket call
per running run; bounded by the small number of concurrent runs.

Response: `{contract, command:"scripts results", project_id?, runs:
ScriptRun[], generated_at}`.

## `scripts logs <run-id>`

Returns the bounded log for one run (`run_id` exact or unique prefix,
`run_not_found`/`ambiguous_run` otherwise). On completion the runner
stores the pane read tail — capped at `runLogMaxBytes` (config, default
65536 bytes, tail kept with a truncation marker) at
`<stateDir>/runs/<run-id>.log`. When no log exists yet and the pane is
still alive, a bounded `pane.read` (last 500 lines) is captured on
demand. A `running` run whose pane is gone is marked `unknown`.

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
  fabricated success.

## Auto triggers — `runOnSettle` / `stopOnSettle` (#182, ADR-0029)

Settle is plugin-owned organize state (`rebuildup.inbox`), not a herdr
event, so there is no `[[events]]` manifest hook. Instead, inbox records
its own organize transitions in a per-session seq log and exposes them
read-only via `inbox transitions --after <seq>`
(`herdr-plugins.inbox/v1`, inbox 0.4.0+). Projects drains that log lazily
— same no-daemon discipline as the worktree drain — and consumes only
`kind:"settled"` transitions (`snoozed`/`restored`/`cleared` are recorded
by inbox but ignored by projects).

- **Inbox resolution (ADR-0013 public-CLI pattern):** the drain locates
  the installed inbox plugin the same way other plugins do — explicit
  override first (`--inbox-root` flag on draining commands, then
  `inboxRoot` in the plugin config dir's `config.json`), then the
  `../inbox` sibling checkout, then `herdr plugin list` — and invokes
  `<plugin_root>/src/cli.ts transitions` with `bun run`. The child
  environment is pinned (`HERDR_PLUGIN_STATE_DIR`/`_CONFIG_DIR` pointed
  at the resolved inbox dirs, all other `HERDR_*` stripped) so the inbox
  CLI reads its own state, never projects'. `--socket`/`--session` are
  forwarded so the drain always reads the session the invoking command
  resolved. An absent/unrunnable inbox never fails the calling command:
  the drain reports `inbox_unavailable` and consumes nothing.
- **Cursor:** the response's `session_key` is stored verbatim as the
  cursor key in `state.settle_cursors` (projects never recomputes
  inbox's `hostname + canonical socket` key). The cursor advances to the
  response `head_seq` only after the batch is processed; a mid-batch
  crash replays the un-acked tail, absorbed by `transition_seq`
  dedupe (below). A stored cursor below the log's retained window
  (`oldest_seq`/`dropped`) sets `cursor_expired` in the report — the
  consumer is told transitions were lost rather than silently skipped.
- **Collapse:** within a drained batch, a later `cleared` or `restored`
  transition for the same `pane_id` supersedes an earlier `settled`
  (reported `settle_superseded`) — settle→restore is not a net settle.
  Only transitions that survived collapse reach script resolution.
- **Repo + script resolution:** the settled pane's `cwd` (captured on
  the transition by inbox) resolves via `resolveRepo` → canonical
  worktree root → `git-common-dir` project match (the #180 path) →
  layered `resolveScripts` on that worktree root. Only scripts with
  `runOnSettle === true` fire, through the unchanged ADR-0010 runner;
  `ScriptRun.trigger` records `{kind:"inbox.settled", pane_id,
  transition_seq, transition_at}`.
- **stopOnSettle:** for each settled transition, `running` runs whose
  recorded `repo.root` canonicalizes to the SAME worktree root AND whose
  script — re-resolved through the same layers — has
  `stopOnSettle === true` are stopped via the existing `stopRuns` path
  (recorded `pane_id` only). Sibling worktrees of the same repo group
  are never touched, and runs started by this very drain are excluded
  (the pre-drain run snapshot is taken before any fire). Stopped runs
  are reported in `triggers.stopped[]` with `{run_id, project_id,
  script, pane_id, action, transition_seq}`.
- **Idempotency:** a run record whose `trigger.transition_seq` equals
  the drained transition's `seq` means that transition already fired —
  reported `already_fired`, never re-fired.
- **Drain report:** merged into the invoking command's payload as
  `triggers: {fired[], skipped[], stopped?, duplicates,
  pending_remaining, inbox_unavailable?, settle?, session_unreachable?}`
  when non-empty. Settle `fired[]`/`skipped[]` entries carry
  `source:"inbox.settled"` plus `pane_id`/`transition_seq`
  (skipped also `cwd?`). `settle` reports `{session_key, cursor_before,
  cursor_after, cursor_expired}`. Skip reasons include
  `settle_superseded`, `already_fired`, `cwd_unavailable`, `cwd_gone`,
  `repo_not_registered`, `ambiguous_project`, `no_run_on_settle_scripts`,
  `stop_script_resolution_failed`, `stop_failed`,
  `session_unreachable`, `run_start_failed`, plus git-contract kinds.

## `scripts tick`

`{contract, command:"scripts tick", triggers?, generated_at}` —
drains pending `worktree.created` marks AND new inbox organize
transitions (see above). `--inbox-root <path>` overrides inbox plugin
resolution for this invocation. Exit 0 on success; the drain itself
never fails the command (per-item outcomes are reported in
`triggers.skipped`).

## Remaining auto-trigger gaps

`runOnSettle`/`stopOnSettle` cover the settle transition only —
`snoozed`/`restored`/`cleared` transitions are recorded by inbox but
have no projects-side semantics (by design, ADR-0029). #32 automations
own scheduled/event-driven execution generally.

## Errors

`kind` values mirror the git contract: `git_missing`, `timeout`,
`git_error`, `not_a_repo`, `bare_repo`, plus `project_not_found`,
`project_exists`, `repo_already_registered`, `repo_not_found`,
`invalid_project_id`, `settings_key_not_allowed`, `t3json_invalid`,
`invalid_script_list`, `unknown_script`, `no_repos`, plus the script
runner kinds `repo_ambiguous`, `ambiguous_script`, `ambiguous_run`,
`run_not_found`, `no_running_runs`, `script_run_error`. Errors may
carry extra fields (`project_id`, `key`, `root`, `repos`, `name`,
`matches`, `run_id`, `target`, `path`, `reason`, `layer`).
