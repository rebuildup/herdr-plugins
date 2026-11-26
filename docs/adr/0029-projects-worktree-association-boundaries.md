# ADR-0029: Projects clone/init/publish, worktree association, and worktreeSubmodules — #70 residual verdicts

Status: Accepted (release-0-9-0 candidate, Issue #183 — design-decision
ticket for #70 residuals; parents #70 / #26 / #22)

## Context

#26's acceptance criteria that release-0-3-0 (#48–#53) did not land were
carried into #70 as three residuals, decomposed by #183 into:

1. **clone/init/publish** — upstream T3 Code's project-creation surface
   (`apps/server/src/project/ProjectCloneTracker.ts`,
   `ProjectService.ts`, `docs/user/source-control.md` "Start, clone, or
   publish a project" at pinned revision `9cc4018c`).
2. **repo ↔ worktree/diff association** — upstream groups projects and
   worktrees by `repositoryIdentity`
   (`packages/client-runtime/src/state/projectGrouping.ts`); the plugin
   must decide how registry repo members relate to herdr/Worktrunk
   worktrees and their diffs.
3. **`has_submodules` → `worktreeSubmodules` connection** — #50 parses
   `t3.json`'s `worktreeSubmodules`
   (`recursive`|`top-level`|`none`); `repos list` already reports live
   `has_submodules` (#51). Who consumes the pair when worktree creation
   itself stays with herdr/Worktrunk?

Measured facts (this host, herdr protocol 22, Worktrunk 0.83.0):

- `herdr worktree list --cwd <path>` (socket method `worktree.list`,
  params `{cwd, workspace_id, trust_repository}`) returns
  `source: {repo_key, repo_name, repo_root, source_checkout_path,
  source_workspace_id}` plus `worktrees[]` of `{path, branch,
  is_bare, is_detached, is_linked_worktree, is_prunable, label,
  open_workspace_id}`. Verified live against this repository: all nine
  linked worktrees listed with correct branches.
- `herdr worktree create|open|remove` own checkout lifecycle;
  `--trust-repository` is a per-request Git trust grant that must only
  be passed after user verification (herdr `--skill` guidance), never
  as a routine retry.
- Worktrunk 0.83.0 has **no submodule configuration**: `wt switch`
  creates the checkout via `git worktree add` (submodules stay
  uninitialized) and offers only generic `post-start`/`post-switch`
  hooks as the consumption path. Upstream discussion
  (max-sixty/worktrunk#2920) confirms submodule init is a manual/`wt
  hook` concern today.
- `packages/git-core` already provides `resolveRepo` /
  `repoRemoteIdentity` / `runGit`; `plugins/projects/src/triggers.ts`
  (#180) already implements the worktree→repo resolution chain:
  `worktree.created` event `worktree.path` → `resolveRepo` →
  `git rev-parse --git-common-dir` → registry `repos[]` membership.
- The git plugin contract (`docs/contracts/git-v1.md`) is
  **pane-addressed**: every command takes `<pane_id>`; there is no
  path-addressed read surface.

## Decision

### 1. clone/init/publish — NOT a plugin responsibility; #185 closes unimplemented

Verdict: **unnecessary**. Rationale:

- **Clone** is `git clone` / `gh repo clone` followed by
  `herdr worktree open` (existing checkout) or registering the clone
  root via `projects repos add` / `discover`. herdr and Worktrunk both
  assume an existing repository; neither clones, and the plugin adds no
  value by re-implementing transport/auth logic that `git`/`gh` already
  own (including SSH fallback and credential helpers).
- **Init** (new local repo) is `git init` + first commit; the registry
  side is already covered — `projects register` accepts any directory
  and `repos add` validates via `resolveRepo`.
- **Publish** (local → hosted remote) requires remote creation and
  credential use (`gh repo create --push` or `git remote add` + push).
  Delegating to `gh`/`git` keeps credentials out of the plugin entirely,
  consistent with the credential boundary family (ADR-0014/0018:
  plugins never hold or log secrets). A plugin-side publish would have
  to re-implement provider auth, visibility flags, and push
  orchestration for zero registry benefit — the post-publish state is
  just "repo member with a `remote` identity", which `repos add`
  already records.
- Upstream's clone/publish UX value (background progress, toasts,
  provider picker) is GUI-shell functionality; the plugin contract is
  a CLI/JSON surface where `gh` already provides equivalent capability
  discovery (`gh auth status`).

Consequence: #185 is closed as "not needed" per its own acceptance
criteria; this ADR is the recorded 根拠. No contract, spec, or code
change results from this verdict.

### 2. repo ↔ worktree/diff association — plugin read surface, implement in #184

Verdict: **implementable independent of clone/init/publish**; #184
proceeds as the conditional implementation ticket.

Data flow (contract-level):

1. For each registry member `repos[].root`, the plugin calls socket
   method `worktree.list` with `cwd` = member root (and
   `trust_repository: false`; an untrusted-repo failure surfaces
   honestly in `skipped`, never retried with trust). The response's
   `source.repo_root`/`source.repo_key` is cross-checked against the
   member root canonicalized via `canonicalRepoRoot`; mismatches are
   skipped, not guessed.
2. Each returned `worktrees[]` entry maps to a checkout path. The same
   repo-identity primitive used by #180 triggers applies in reverse:
   `git rev-parse --git-common-dir` on the worktree path must resolve
   to the member repo's common dir — this is the authoritative
   same-repo test (covers linked worktrees, whose `rev-parse
   --show-toplevel` differs from the member root).
3. Per-worktree liveness reuses `inspectRepo` (branch / dirty /
   `has_submodules`) from `model.ts` — the same three bounded git calls
   `repos list` already performs per member.
4. **Diff surface constraint:** `herdr-plugins.git/v1` is
   pane-addressed. A worktree with `open_workspace_id` resolves to
   panes via `session.snapshot`, yielding `pane_id`s the git plugin's
   `status`/`diff`/`compare` can be spawned against (the mcp plugin's
   env-pin cross-plugin CLI consumption pattern). A worktree with no
   open workspace has no pane; the plugin reports path/branch/dirty
   only and omits diff fields — it must not fabricate a diff surface or
   open panes/workspaces itself (creation stays herdr/Worktrunk).
5. Output: additive `worktrees[]` array on each `repos list` entry
   (preferred over a separate command — the association is meaningless
   without the member context), shape finalized in #184 against
   `docs/contracts/projects-v1.md`. All fields nullable/`skipped`-
   reported; stale `open_workspace_id` and unreachable sockets degrade
   to honest empty/error entries.

### 3. `has_submodules` → `worktreeSubmodules` — record as upstream gap; no plugin enforcement

Verdict: **no consumption path exists today**; record as an upstream
gap and keep the plugin surface advisory.

- `t3.json`'s `worktreeSubmodules` is parsed and preserved (#50,
  `t3json.ts`), and `repos list` reports live `has_submodules` (#51).
- Neither consumer can act on the pair: herdr `worktree create` has no
  submodule option in its socket schema (verified, protocol 22), and
  Worktrunk 0.83.0 has no submodule setting — its only hook points are
  generic `post-start`/`post-switch` shell commands.
- Therefore the plugin must not pretend to "resolve" submodule init:
  it cannot create worktrees, and silently advising a value nothing
  consumes would be fabricated behavior. The honest surface is: keep
  both values readable (`repos list` fields + t3.json passthrough),
  document in `docs/specs/projects.md` that submodule initialization on
  worktree creation is a **herdr/Worktrunk-side gap** (upstream Issue
  candidates: herdr worktree submodule init option; Worktrunk
  submodule-aware `wt switch`), and note the manual path users can
  already wire — a Worktrunk `post-start` hook running
  `git submodule update --init --recursive`.
- If #184's association surface lands, it MAY include the parsed
  `worktreeSubmodules` value per repo as a read-only advisory field;
  that is display data, not enforcement.

## Consequences

- #184 proceeds (association is plugin read-surface work, independent
  of the clone/init/publish verdict); #185 closes unimplemented.
- Follow-up documentation only: spec/contract updates for the
  association surface belong to #184; this ADR changes no wire
  contract.
- `docs/program/feature-ledger.json` `projects-multi-repo`
  verification field records the verdicts and the upstream gaps.
- Upstream gaps recorded for tracking: (a) herdr `worktree create`
  submodule-init option; (b) Worktrunk submodule-aware worktree
  creation; (c) a path-addressed diff read in `herdr-plugins.git/v1`
  if pane-less worktree diffs are ever needed (today: out of scope,
  pane-addressed contract stands).
