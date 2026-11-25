# Projects plugin (`rebuildup.projects`) — specification

Scope: project registry — read model (list/show/discover) plus
mutations (register/update/pin/archive) and per-project settings
overrides. Contract: `herdr-plugins.projects/v1`
(`docs/contracts/projects-v1.md`). Design: ADR-0009.

## Purpose

Provide the project entity upstream T3 Code centers its UX on — a
logical grouping of one or more git repositories with settings and
scripts — as plugin-owned state, without touching herdr core state.
Foundation delivered by #49 (CRUD/overrides), #50 (t3.json/scripts),
#51 (repo membership/grouping); #52/#53 own script execution.

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
| `scripts run <project> <name> [--repo PATH]` | Execute a script in a dedicated herdr pane; waits for the completion marker up to `runTimeoutMs`. |
| `scripts stop <run-id\|project>` | ctrl+c + close the recorded pane of running run(s); only plugin-owned pane ids. |
| `scripts results [project]` | Run records newest-first; `running` records lazily reconciled via `pane.get`. |
| `scripts logs <run-id>` | Bounded stored/captured log tail for one run. |
| `repos list <project>` | Member repos with live `branch`/`dirty`/`has_submodules`; unreachable members reported in `skipped`. |
| `repos add <project> --path DIR` | Add a repo/checkout to a project; same code path and errors as `update --repo-add`. |
| `repos remove <project> --path DIR` | Drop membership (live or stale path); same code path as `update --repo-remove`. |

All commands accept `--session`/`--socket`/`--timeout`; `discover` and
the `scripts run|stop|results|logs` family need a reachable herdr
session socket (the rest work offline). Mutations are explicit-argument
CLI invocations — no manifest actions.

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

## Repo membership and grouping (#51)

- `repos[].remote` is the `repositoryIdentity` equivalent: normalized
  `origin` URL (`host/path`, scp/https/case/`.git` unified via
  `normalizeRemoteUrl`), `null` → identity falls back to root path.
  Distinct checkouts/clones of the same remote share the identity and
  can be grouped under one project via `repos add`.
- `repos add`/`repos remove` are thin aliases over the same locked
  helpers as `update --repo-add`/`--repo-remove`
  (`addReposToProject`/`removeReposFromProject` in `cli.ts`) — no
  duplicated logic, identical `repo_already_registered` /
  `repo_not_found` semantics.
- `repos list` enriches each member live via `inspectRepo`
  (`model.ts`): `rev-parse --abbrev-ref HEAD`, `status --porcelain`,
  `submodule status` — one timeout-bounded call set per repo.
  `has_submodules` feeds the upstream `worktreeSubmodules` connection
  point. Unreachable members keep stored fields with null live values
  plus a `skipped` entry; nothing is fabricated.
- #26 acceptance: same-name repos (distinct roots → distinct
  identities), non-git roots (`not_a_repo`), and external folders are
  never absorbed into a project — covered by contract tests.

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

## Script execution (#53, ADR-0010)

- Execution surface: `workspace.create {cwd: repoRoot, label,
  focus:false}` per run → `root_pane` receives
  `<command>; echo "__HERDR_DONE_<run-id>__=$?"` via a single
  `pane.send_input {text, keys:["Enter"]}`. Newline/>4000-char commands
  go through an executable `/bin/sh` file under
  `<stateDir>/runs/<run-id>.sh` (POSIX-sh limitation, documented).
- Completion: `pane.wait_for_output` (`recent_unwrapped`, regex
  `__HERDR_DONE_<run-id>__=(-?\d+)`, `timeout_ms = runTimeoutMs`,
  config default 600000). Exit code comes ONLY from marker digits —
  the echoed input line cannot match (`$?` literal), the run-id nonce
  prevents cross-run collisions, and pane text/process state is never
  used to infer success.
- Result enum: `running | success | failed | stopped | unknown`.
  Wait timeout leaves `running` (pane untouched, never auto-killed);
  pane vanished before marker → `unknown`. `running` asserts only
  "marker not yet observed" — liveness is re-checked lazily by
  `scripts results`/`logs` via `pane.get` (one call per running run).
- Stop: `pane.send_keys ["ctrl+c"]` → `stopGraceMs` (config default
  2000) → bounded `pane.read` log capture → `pane.close`, all against
  the `pane_id` recorded in `runs.json`. Target = exact/unique-prefix
  run_id or project id (`ambiguous_run`/`run_not_found`/
  `no_running_runs` structured errors).
- Run records: `<stateDir>/runs.json` under a dedicated
  `runs.json.lock` + tmp+rename (same discipline as `state.ts`);
  corrupt file reads as empty. Persisted BEFORE injection.
- Logs: bounded tail (`runLogMaxBytes`, config default 65536) stored
  at `<stateDir>/runs/<run-id>.log`; on-demand `pane.read` (500 lines)
  when no stored log and the pane is alive. No rotation — one file per
  run, overwritten only by re-capture of the same run.
- Metadata: display-only `script_<name>` token (≤32 chars, herdr token
  alphabet) projected via `pane.report_metadata` (source
  `rebuildup.projects`) on state transitions; failures ignored.
- Repo selection: `--repo` must match a member root; multi-repo project
  without `--repo` fails `repo_ambiguous` — never silently first.
- Concurrency: unlimited runs; `run_id = run-<ts36>-<rand6>`; stop and
  results address only recorded pane ids (herdr socket panes carry no
  ownership token — client-side discipline per ADR-0010).
- **Auto triggers gap:** `runOnWorktreeCreate`/`runOnSettle`/
  `stopOnSettle` are listed but not executed — no faithful herdr event
  mapping exists (upstream gap, follow-up Issue). Scheduled/event
  execution belongs to #32 automations.
- `mutation_commands` += `scripts run`, `scripts stop`.

## Non-goals

- No worktree/workspace creation for projects themselves — herdr/
  Worktrunk own lifecycle (script runs do create dedicated execution
  workspaces per ADR-0010).
- No auto triggers (`runOnWorktreeCreate`/`runOnSettle`/`stopOnSettle`)
  — upstream gap, manual run/stop only this release.
- No per-session namespacing of the registry.
