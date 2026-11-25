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
```

- All commands print exactly one JSON document on stdout. Handled errors
  print `{contract, ok:false, error:{code,message}}` on **stderr** and
  exit 1; usage errors exit 2.
- v0.1.0 is **read-only**: `read_only: true`, `mutation_commands: []`.
  Registry writes (`register`/`update`/`pin`/`archive`, settings
  overrides, script execution) arrive in later tickets and will extend
  v1 additively while read outputs stay unchanged.

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

## Errors

`kind` values mirror the git contract: `git_missing`, `timeout`,
`git_error`, `not_a_repo`, `bare_repo`, plus `project_not_found`.
