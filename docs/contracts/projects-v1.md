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
  "archive","unarchive","pin","unpin","settings set","settings unset"]`.
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
grouping (#51). Each entry carries the stored membership fields plus
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
      "has_submodules": true
    }
  ],
  "skipped": [{ "root": "/abs/gone", "reason": "git_error" }],
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
- Read-only; unknown project id → `project_not_found`.

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
commands run with the user's privileges. This command only *lists*
definitions; execution permission is the runner's concern (#53).

## Errors

`kind` values mirror the git contract: `git_missing`, `timeout`,
`git_error`, `not_a_repo`, `bare_repo`, plus `project_not_found`,
`project_exists`, `repo_already_registered`, `repo_not_found`,
`invalid_project_id`, `settings_key_not_allowed`, `t3json_invalid`,
`invalid_script_list`, `unknown_script`, `no_repos`. Errors may carry
extra fields (`project_id`, `key`, `root`, `path`, `reason`, `layer`).
