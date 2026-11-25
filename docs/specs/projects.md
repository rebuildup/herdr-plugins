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
| `scripts list <project\|repo>` | Resolved script definitions with per-script `source`; read-only. |

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

## t3.json and script resolution (#50)

- `plugins/projects/src/t3json.ts` loads `<repoRoot>/t3.json`,
  mirroring upstream `t3ProjectFile.ts`: `$schema`, `iconPath`,
  `defaultThreadEnvMode`, `worktreeSubmodules`,
  `worktreeSparsePatternsPath`, `scripts[]` (max 50). Unknown keys are
  ignored; malformed JSON/schema violations raise `T3JsonError`
  (`invalid_json`/`invalid_schema`).
- `plugins/projects/src/scripts.ts` resolves the effective script list
  by layer priority: project settings `defaultProjectScripts` override →
  plugin config `defaultScripts` (env default) → repo `t3.json` →
  builtin (empty — upstream defines no builtin scripts). The first
  active layer wins wholesale; explicit empty override/env lists are
  authoritative while an empty `t3.json` `scripts` falls through
  (upstream parity). List entries may be definition objects or bare
  name strings referencing lower-layer definitions; unresolved names
  fail `unknown_script`.
- For multi-repo projects `scripts list` reads `t3.json` from the
  first registered repo by default; `--repo PATH` selects another
  member (must canonicalize to a member root). A bare repo path not in
  any project still resolves (env/t3.json layers only, `project_id`
  null); a path owned by a project picks up that project's override.
- Trust boundary: repo `t3.json` is trusted because the user
  registered/operates that repo; commands execute with user privileges.
  `scripts list` only reads definitions — execution gating is #53's
  runner concern.

## Non-goals

- No script execution — #52/#53.
- No worktree/workspace creation — herdr/Worktrunk own lifecycle.
- No per-session namespacing of the registry.
