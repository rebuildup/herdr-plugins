# Projects plugin (`rebuildup.projects`) — specification

Scope: project registry — read model (list/show/discover) plus
mutations (register/update/pin/archive) and per-project settings
overrides. Contract: `herdr-plugins.projects/v1`
(`docs/contracts/projects-v1.md`). Design: ADR-0009.

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
| `capability` | Contract/plugin/command discovery; `read_only: false`. |
| `list [--all]` | Registered projects, pinned-first then title; archived hidden unless `--all`. |
| `show <id>` | Single project; `project_not_found` structured error otherwise. |
| `discover` | Git repos reachable from session pane cwds + skip reasons + registry linkage. |
| `register <path>` | Create a project from a repo path; derived or explicit id/title; duplicate repo roots conflict. |
| `update <id>` | Title/pin/archive plus `--repo-add`/`--repo-remove` membership in one locked write. |
| `archive`/`unarchive`/`pin`/`unpin <id>` | Non-destructive flag setters; no delete. |
| `settings get/set/unset` | Per-project override keys under `<stateDir>/settings/`; allow-listed keys only. |

All commands accept `--session`/`--socket`/`--timeout`; only `discover`
needs a live herdr session. Mutations are explicit-argument CLI
invocations — no manifest actions.

## Mutation rules

- Repo roots are canonicalized (`realpath`) before comparison; a root
  owned by any project rejects re-registration (`repo_already_registered`).
- All membership/flag checks run inside the single-writer lock, so
  concurrent CLI invocations cannot interleave or lose updates.
- `archive` retains state (repos + settings); `list` hides archived
  entries unless `--all`.
- Settings keys are allow-listed (`SETTINGS_ALLOW_LIST`): upstream
  project-scoped keys relevant to scripts/display. Values are verbatim
  strings; #50 owns typed resolution.

## Non-goals

- No t3.json parsing or script definitions — #50.
- No script execution — #52/#53.
- No worktree/workspace creation — herdr/Worktrunk own lifecycle.
- No per-session namespacing of the registry.
