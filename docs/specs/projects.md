# Projects plugin (`rebuildup.projects`) — specification

v0.1.0 scope: read-only project registry — list/show registered
projects and discover git repositories from herdr pane cwds. Contract:
`herdr-plugins.projects/v1` (`docs/contracts/projects-v1.md`). Design:
ADR-0009.

## Purpose

Provide the project entity upstream T3 Code centers its UX on — a
logical grouping of one or more git repositories with settings and
scripts — as plugin-owned state, without touching herdr core state.
Foundation for #49 (CRUD/overrides), #50 (t3.json/scripts), #51 (repo
membership), and #3 (script execution).

## Identity and resolution

- Registry entries are host-global plugin state
  (`HERDR_PLUGIN_STATE_DIR/state.json`); not per-session.
- Repo roots resolve via `git rev-parse --show-toplevel` (shared
  `packages/git-core` spawn path: argv only, `GIT_TERMINAL_PROMPT=0`,
  hard timeout).
- Cross-checkout identity = normalized remote URL
  (`host/path`, scp/https/case/`.git` unified); repos without remotes
  key by root path only.

## Commands (contract `herdr-plugins.projects/v1`)

| Command | Description |
| --- | --- |
| `capability` | Contract/plugin/command discovery; `read_only: true`. |
| `list [--all]` | Registered projects, pinned-first then title; archived hidden unless `--all`. |
| `show <id>` | Single project; `project_not_found` structured error otherwise. |
| `discover` | Git repos reachable from session pane cwds + skip reasons + registry linkage. |

All commands accept `--session`/`--socket`/`--timeout`; only `discover`
needs a live herdr session.

## Non-goals (v0.1.0)

- No registry mutation (register/update/pin/archive) — #49.
- No t3.json parsing or script definitions — #50.
- No script execution — #52/#53.
- No worktree/workspace creation — herdr/Worktrunk own lifecycle.
- No per-session namespacing of the registry.
