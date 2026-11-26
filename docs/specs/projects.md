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
| `scripts tick` | Explicit lazy drain of pending `worktree.created` trigger marks (also runs implicitly atop `scripts run|stop|results|logs`). |
| `repos list <project>` | Member repos with live `branch`/`dirty`/`has_submodules`, `worktree_submodules` advisory, and the `worktrees[]` herdr association (path/branch/dirty + pane-addressed git pointers); unreachable members reported in `skipped`, association failures in per-entry `worktrees_error` + top-level `worktrees_skipped`. |
| `repos add <project> --path DIR` | Add a repo/checkout to a project; same code path and errors as `update --repo-add`. |
| `repos remove <project> --path DIR` | Drop membership (live or stale path); same code path as `update --repo-remove`. |

All commands accept `--session`/`--socket`/`--timeout`; `discover` and
the `scripts run|stop|results|logs` family need a reachable herdr
session socket. `repos list` uses the socket opportunistically for
the worktree association — unreachable degrades to `worktrees: null`
+ `worktrees_error`, never a failure. Mutations are explicit-argument
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
  point — parsed but not consumed: neither herdr `worktree create`
  nor Worktrunk has a submodule-init path today (upstream gap,
  ADR-0029). Unreachable members keep stored fields with null live
  values plus a `skipped` entry; nothing is fabricated.
- #26 acceptance: same-name repos (distinct roots → distinct
  identities), non-git roots (`not_a_repo`), and external folders are
  never absorbed into a project — covered by contract tests.

## Repo ↔ worktree/diff association (#184, ADR-0029 §2)

`repos list` additionally reports, per member repo, the worktrees herdr
knows for that repository — a read-only reference surface. Worktree
creation/removal stays with herdr/`wt` (Worktrunk); the plugin never
opens panes or workspaces itself.

- Source: socket method `worktree.list` with `cwd` = member root and
  `trust_repository: false` (an untrusted-repo RPC error is reported in
  `worktrees_error`, never retried with a trust grant). The response's
  `source.repo_root` is canonicalized and cross-checked against the
  member root — a mismatch yields `worktrees_error.reason =
  "repo_mismatch"`.
- Same-repo proof: each candidate checkout's
  `git rev-parse --git-common-dir` must equal the member repo's common
  dir (the same primitive #180 triggers use in reverse). Non-matching
  checkouts land in `worktrees_skipped` (`not_member_repo`), gone paths
  in `worktree_gone`, non-git/bare in the git kinds — nothing is
  attributed by guesswork.
- Liveness reuses `inspectRepo` (`branch`/`dirty`/`has_submodules`).
- Diff surface is pane-addressed only (`herdr-plugins.git/v1`):
  `open_workspace_id` resolves to `session.snapshot` panes; each pane
  gets `commands` pointers (`status`/`diff`/`files`/`compare`) plus a
  compact live `status` summary fetched via the sibling git plugin's
  public CLI (ADR-0013 env-pin spawn, ambient `HERDR_*` scrubbed,
  ≤8 calls per member repo). A worktree with no open workspace — or a
  stale `open_workspace_id` (`panes_unavailable: true`) — reports
  path/branch/dirty only; no diff data is fabricated.
- `worktrees_error` covers association-level failure
  (`session_unreachable`, RPC codes, `repo_mismatch`); per-checkout
  failures go to `worktrees_skipped`. Offline `repos list` still
  returns stored/live git fields with `worktrees: null`.
- `worktree_submodules` is the advisory `t3.json` value (ADR-0029 §3
  MAY) — display data only; no consumer enforces submodule init today.

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
- `mutation_commands` += `scripts run`, `scripts stop`, `scripts tick`.

## Auto trigger: runOnWorktreeCreate (#180)

- Manifest `[[events]] on="worktree.created"` → `src/hook.ts` appends a
  `PendingTriggerMark` to `state.json.pending_triggers` (cap 200,
  oldest-dropped counted; identical event+session+path marks collapse).
  The hook does no socket/git/script work — ADR-0002, same shape as
  automations #146 / checkpoints auto-capture.
- Lazy drain on the next `scripts tick|run|stop|results|logs` call
  (`list`/`capability`/`help` never drain): worktree path →
  `resolveRepo` → `git-common-dir` → non-archived `repos[]` membership
  → #50 layered script resolution on the EVENT worktree root →
  `runOnWorktreeCreate` scripts only → unchanged ADR-0010 `startRun`
  against the mark's recorded session socket.
- Skips are reported in the payload's `triggers` block
  (`repo_not_registered`, `ambiguous_project`, `worktree_gone`, git
  kinds, `t3json_invalid`/`invalid_script_list`/`unknown_script`,
  `no_run_on_worktree_create_scripts`, `session_unreachable`,
  `run_start_failed`) — never silent, never guessed. Unreachable
  session sockets keep marks pending; consumed marks cannot double-fire
  across concurrent drains.
- `ScriptRun.trigger` records `{kind:"manual"|"worktree.created",
  worktree_path?, event_received_at?}` (additive; manual runs get
  `kind:"manual"`).
- `runOnSettle`/`stopOnSettle` design is settled by ADR-0029 (#181):
  inbox-v1 gains an additive per-session organize-transition log +
  `transitions` read command; projects lazy-drains it via the
  ADR-0013 public-CLI pattern and fires/stops through the unchanged
  ADR-0010 runner. Implementation: #182.

## Non-goals

- No project clone/init/publish operations — `git`/`gh` own transport
  and credentials; the plugin records registry membership only
  (ADR-0029, #185 closed unimplemented).
- Repo↔worktree/diff association is read-only (#184): `worktree.list`
  + git-common-dir identity + pane-addressed git-v1 pointers; no
  worktree/workspace creation (herdr/Worktrunk own lifecycle; script
  runs do create dedicated execution workspaces per ADR-0010).
- `runOnSettle`/`stopOnSettle` ship via the inbox organize-transition
  surface + lazy drain per ADR-0029 (#182); `runOnWorktreeCreate`
  shipped via the `worktree.created` hook + lazy drain (#180).
- No per-session namespacing of the registry.
