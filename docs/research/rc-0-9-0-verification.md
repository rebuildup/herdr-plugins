# RC verification — v0.9.0 (`rebuildup.git` v0.6.0 + `rebuildup.inbox` v0.5.0 + `rebuildup.projects` v0.4.0 + `rebuildup.textgen` v0.6.0, `#22` residual train)

Verification record for the v0.9.0 release candidate (Issue #214, final
ticket of the train — same shape as #167 for v0.8.0). Fixed target:

- Code under test: `release-0-9-0` @ `586ea1df07960d3fa3be0c58026ddd1449ec1b8e`
  (all four plugins installed into the isolated session with
  `herdr plugin install rebuildup/herdr-plugins/plugins/<name>
  --ref release-0-9-0`; every installation resolved exactly `586ea1d`.
  This document, the ledger/program sync, and any audit follow-ups
  land on top — no behavioral change after the verified SHA)
- herdr: `0.9.5` (real binary
  `~/.local/share/mise/installs/herdr/0.9.5/herdr`), Bun: `1.4.4`,
  git: homebrew `git`, gh: `2.105.0` (real, authenticated as
  `rebuildup` via `~/.config/gh` hosts.yml + keyring — read-only use
  only, no forge mutation performed live)
- Platform exercised: macOS (arm64)

## Environment

| Env | Host | Session | Isolation |
| --- | --- | --- | --- |
| macOS | local (arm64) | `verify214` | dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HERDR_CONFIG_PATH` under `/var/tmp/herdr-plugin-214`, headless `herdr --session verify214 server`, all ambient `HERDR_*` unset for server/CLI calls |

The user's live session was never touched; the isolated session was
stopped and deleted after verification and `/var/tmp/herdr-plugin-214`
removed. For CLI invocations of the plugins themselves,
`--socket /var/tmp/herdr-plugin-214/config/herdr/sessions/verify214/herdr.sock`
was passed explicitly (or `HERDR_SOCKET_PATH` exported consistently)
and plugin config/state dirs resolved under the isolated XDG roots
(`/var/tmp/herdr-plugin-214/{config,state}/herdr/plugins/…`).

Environment notes (not plugin defects):

- Ambient `HERDR_*` env must be stripped for every call
  (`env -u HERDR_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID -u
  HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_ENV -u
  HERDR_STARTUP_CWD -u HERDR_PLUGIN_CONFIG_DIR -u
  HERDR_PLUGIN_STATE_DIR`); the agent environment exports live-session
  vars (known hazard, issue #83).
- The mise `herdr` shim fails under XDG override; the real binary path
  was used throughout.
- `gh` reads its own config from `XDG_CONFIG_HOME/gh`; the real
  `~/.config/gh` (hosts.yml + keyring reference, no token material
  copied) was mirrored into the isolated XDG root so `gh` stayed
  authenticated inside the sandbox. No `GH_TOKEN`/`GITHUB_TOKEN` env
  was set or needed.

## Audit results (Issue #214 scope 1)

Boundary audit of the release-0-9-0 delta vs `release-0-8-0`
(`git diff origin/release-0-8-0..origin/release-0-9-0`, ~16k LOC across
`plugins/{git,inbox,projects,textgen}`, `packages/herdr-client`,
`packages/git-core` unchanged):

- **Forge mutations (git plugin) — PASS.** Every forge-mutating `pr`
  action (`create`, `review`, `comment`, `reply`, `reviewers`,
  `merge`) and `issue` action (`create`, `edit`, `comment`, `close`,
  `link`, `unlink`) sets `options.mutation = true`
  (`plugins/git/src/cli.ts:1157`, `:1771`) before target resolution →
  `resolveTarget`/`socketFor` fail closed with `target_required` on the
  implicit default socket (`packages/herdr-client/src/socket.ts:495`).
  Live-verified: `pr review`/`issue close` without `--socket` return
  `target_required` before any `gh` spawn. PR mutations additionally
  require `--expect-head <full sha>` (mandatory stale-head guard,
  re-verified inside `gh.ts` immediately before the write);
  `pr merge` re-checks `mergeStateStatus`/`reviewDecision`/`isDraft`
  and hard-refuses release-train head branches (ADR-0030). Issue
  mutations have no head-sha analog by design (documented in
  git-v1.md). `issue link|unlink|links` delegate to
  `rebuildup.inbox`'s public CLI via `plugins/git/src/inbox.ts`
  (`runInboxCli`): sibling/plugin-list/override root resolution,
  `HERDR_PLUGIN_*` scrub + env-pin to the *inbox* plugin's dirs
  (ADR-0013 pattern) — the git plugin keeps no link state.
- **gh/git spawn hygiene — PASS with one observation.** All `gh`
  invocations in `plugins/git/src/gh.ts` go through the single
  `runGh` spawn (argv-only, no shell, `stdio` piped+closed,
  `GH_PROMPT_DISABLED=1`, hard timeout, `maxBuffer` cap) with
  `env: ghChildEnv(...)` — the full `GIT_*` redirect strip plus
  `GH_REPO`/`GH_DEBUG`/`GH_FORCE_TTY`/`GH_PAGER` removal
  (`packages/git-core/src/git-env.ts`). `git` spawns use
  `sanitizedChildEnv`. Auth env (`GH_TOKEN`, `GH_HOST`, …) is
  preserved by design — the plugin never handles tokens itself.
  Mutation payloads go via `gh api --input -` (stdin), never argv.
  **Observation O1 (minor, see Defects):** `plugins/inbox/src/cli.ts`
  `verifyTrackerRef` (~line 810) spawns `gh <kind> view … --repo`
  with the *inherited* environment — no `ghChildEnv` equivalent —
  for the opt-in `link --verify` check only.
- **Inbox organize state — PASS.** New organize kinds
  (`pin`/`unpin`/`archive`/`unarchive`/`order`), `link`/`unlink`,
  `watch`, `watch-pr`, `reconcile`, `_wake` all set
  `options.mutation = true` before snapshot/state access
  (`plugins/inbox/src/cli.ts:421,673,688,719,867,912,984,1427`);
  read commands (`list`, `links`, `transitions`, `capability`) do
  not. `appendTransition` records organize transitions inside the
  same `updateState` single-writer critical section
  (`plugins/inbox/src/transitions.ts`) — bounded 500/session log with
  `dropped` accounting; `transitions` is a read-only cursor API.
  `watch-pr` is opt-in, polls only *declared* links via the git
  plugin's public CLI (`runPluginCli` env-pin, ADR-0013), and only
  *observed* forge deltas clear hide-kind marks — never PTY text,
  never invented statuses (`plugins/inbox/src/watchpr.ts` header
  contract). Plugin state stays under `HERDR_PLUGIN_STATE_DIR`
  (`state.json` + watch baselines; verified live at
  `/var/tmp/herdr-plugin-214/state/herdr/plugins/rebuildup.inbox/`).
- **Projects triggers — PASS with one observation.** `register`,
  `update`, `repos add/remove`, `settings set/unset`,
  `scripts run|stop|tick` set `options.mutation = true`
  (`plugins/projects/src/cli.ts:1064,1107` + mutation command table).
  `worktree.created` marks (`hook.ts` → `state.pending_triggers`)
  and settle drains (`triggers.ts`) fire scripts through the
  ADR-0010 dedicated-pane runner — `workspace.create` →
  `pane.send_input` → `pane.wait_for_output` marker — never a
  shell spawn from the plugin; run ownership/session-key
  re-validation (#66) preserved. Settle drain consumes the inbox
  `transitions` CLI over the ADR-0013 env-pin path with a per-session
  seq cursor, within-batch settle→restore collapse, and
  `transition_seq` dedupe — no fabricated events. **Observation O2:**
  the lazy drain also runs atop read-ish commands (`scripts
  results`/`logs`, `scripts tick` advertised in `mutation_commands`)
  and fires herdr mutations (workspace/pane creation) without
  `options.mutation = true` on those invocations; the target socket
  is resolved explicitly per mark/session (`triggers.ts:652`) and
  the behavior is documented in `docs/contracts/projects-v1.md`
  ("Drain (lazy)"). Recorded as design-consistent, not a defect.
- **State/secrets boundaries — PASS.** All plugin state resolves via
  `pluginDirs()` → `HERDR_PLUGIN_{CONFIG,STATE}_DIR` or derived herdr
  dirs only (`packages/herdr-client/src/socket.ts:576`); nothing
  writes inside the installed source tree (verified: plugin roots
  under `…/github-installations/` contain no state writes). Cross-
  plugin child envs strip the caller's `HERDR_PLUGIN_*` and pin the
  target plugin's dirs (`inbox/pluginroot.ts`, `git/inbox.ts`,
  `projects/{plugincli,inbox-source}.ts`). No secrets material in any
  new code path: forge auth stays inside `gh`; projects scripts are
  user-declared config executed in dedicated panes (documented
  surface); textgen JSON tolerance is a pure parser change.
- **Honest failure states — PASS.** `gh`/`git` errors surface as
  structured `GhError`/`GitError` kinds; watch-pr reports
  `last_error`/`consecutive_failures`/`next_poll_at` honestly;
  trigger drains report `skipped[]` reasons (`no_run_on_settle_scripts`,
  `session_unreachable`, `cwd_gone`, …) and never fail the calling
  command; `repos list` reports `worktrees_error`/`worktrees_skipped`
  instead of fabricating associations; `transitions` exposes
  `cursor_expired` via `oldest_seq`/`dropped`.

No audit findings requiring code fixes in this ticket. Observation O1
is flagged for a follow-up (see Defects); O2 is documented design.

## Results

| # | Area | Method | Result |
| --- | --- | --- | --- |
| 1 | Quality gates | `bun install`; `bun run typecheck`; `bunx @biomejs/biome check .`; `bun test --timeout 30000` with all ambient `HERDR_*` stripped | PASS — tsc clean; biome exit 0 (19 pre-existing FIXABLE style diagnostics, non-blocking, same class as v0.8.0); **948 tests / 0 fail** (5311 expects, 51 files, ~207s) |
| 2 | Plugin install | `herdr plugin install rebuildup/herdr-plugins/plugins/{git,inbox,projects,textgen} --ref release-0-9-0 -y` in `verify214` | PASS — all four resolved `586ea1d`, enabled, config/state dirs under isolated XDG |
| 3 | git `status` | `status w1:p1` on pane in worktree `herdr-plugin-214` (branch `214`) | PASS — correct repo root/git-dir/git-common-dir, branch/upstream/ahead-behind, change counts |
| 4 | git `pr list` / `issue list` | real `gh` (authed `rebuildup`) read-only | PASS — live `rebuildup/herdr-plugins` PRs (release-train stack visible) and issues (#214, #211, …) returned with full contract envelopes |
| 5 | git `pr view 169` | read-only, real gh | PASS — full PR payload incl. `mergeStateStatus`, `statusCheckRollup`, bounded `reviews` |
| 6 | git forge fail-closed | `pr review`/`issue close` without `--socket`/ambient target | PASS — `target_required` before any gh spawn; with `--socket`, `--expect-head` full-sha validation rejects short shas (usage exit) |
| 7 | inbox `capability`/`list` | isolated env | PASS — contract `herdr-plugins.inbox/v1`, version `0.5.0`, all 16 commands advertised; list shows pane `w1:p1` with new fields (`pinned`, `links`, counts) |
| 8 | inbox `link --verify` (pr + issue) | real gh verification, opt-in | PASS — issue link `#214` verified clean; PR link on an issue number honestly reported `link verification failed … recorded anyway` in `warnings[]` (no fabrication) |
| 9 | inbox `settle` → `transitions` | organize mutation + read | PASS — settle recorded; `transitions` shows `seq:1 kind:settled` with pane/workspace/cwd context, `head_seq:1`, `dropped:0` |
| 10 | inbox mutation fail-closed | `pin w1:p1` with no target | PASS — `target_required` |
| 11 | projects `capability`/`register`/`repos list` | register worktree repo `herdr-plugin-214`, then `repos list` | PASS — v0.4.0 capability advertises both trigger mechanisms; register resolves remote `github.com/rebuildup/herdr-plugins`; `repos list` returns branch/dirty/has_submodules and honest `worktrees_error: repo_mismatch` (member is a linked worktree whose `worktree.list` source is the main checkout — reported, not fabricated) |
| 12 | projects settle drain | `scripts tick` after the settle in #9 | PASS — inbox transition consumed via public CLI; honest `skipped: no_run_on_settle_scripts`; `settle_cursors` advanced `0→1`, `cursor_expired:false` |
| 13 | textgen `capability` | isolated env | PASS — contract `herdr-plugins.textgen/v1` v0.6.0; git integration resolved via sibling plugin root (`resolved_via: sibling`), credential-boundary ADR refs present |
| 14 | Regression | `herdr plugin list` on `verify214` | PASS — four plugins enabled, no cross-plugin interference; live session untouched throughout |

Real-forge-mutation evidence (review/comment/merge/issue writes) is
contract-tested only (`tests/gh.test.ts`, `tests/git-issue.test.ts` —
fake-gh + fake-socket) per the issue's non-destructive policy; the RC
re-verifies the same code paths read-side and the fail-closed gates
live. Prior per-feature live records:
`git-pr-read-verification.md`, `git-pr-mutation-verification.md`,
`git-pr-merge-verification.md`, `git-issue-verification.md`,
`inbox-v0-2-0-live-verification.md`, `projects-180-live-verification.md`,
`projects-184-live-verification.md`,
`textgen-v1-real-provider-verification.md`.

## Defects / observations

1. **O1 — `verifyTrackerRef` gh spawn inherits ambient env**
   (`plugins/inbox/src/cli.ts` ~line 810, `spawn("gh", [kind, "view",
   …])` with default `env`). Unlike `runGh` in the git plugin it does
   not strip `GH_DEBUG`/`GH_REPO`/`GH_PAGER`/`GH_FORCE_TTY` or the
   `GIT_*` redirect set. Concrete risk: with ambient `GH_DEBUG=api`,
   gh writes request/response debug (potentially including auth
   headers) to stderr; on non-zero exit the first 200 chars of stderr
   are embedded in the `link` command's `warnings[]` output. Narrow
   (requires the user to export `GH_DEBUG`, opt-in `--verify` only,
   read-only `gh … view`), but it is the one place in the 0-9.0 delta
   where provider debug output can reach plugin output unsanitized.
   Recommended follow-up: route this spawn through a sanitized env
   (strip `GH_DEBUG` at minimum) or reuse `ghChildEnv`. Not a
   release blocker — recorded honestly, no silent workaround.
2. **O2 — lazy trigger drain fires herdr mutations from read-ish
   commands** (documented design, see Audit): `scripts results`/`logs`
   can create workspaces/panes via pending trigger marks without
   `mutation: true` on the invoking command. The socket target is
   explicit per mark/session and the drain is advertised in the
   contract; noted for completeness, not a defect.
3. **Biome FIXABLE diagnostics** — 19 pre-existing style warnings
   (`useTemplate`, `useLiteralKeys`) across `plugins/conversations`,
   `tests/conversations*`, `tests/projects.test.ts`, `tests/usage.test.ts`;
   lint exits 0, unchanged in kind from v0.8.0.
4. **Real forge mutations unexercised live** — by design (non-
   destructive RC policy); covered by fake-gh contract tests and the
   per-feature verification records above.

## Verdict

**READY FOR APPROVAL on macOS.** All four bumped plugins verified
end-to-end on real herdr 0.9.5 in isolated session `verify214` at
`release-0-9-0` @ `586ea1d`: GitHub-install path, git read surface +
forge fail-closed gates against real gh, inbox v0.5.0 organize/link/
transition/watch-pr surfaces with honest verification warnings, projects
v0.4.0 register/repos-list plus a live inbox.settled → settle-drain
round-trip, textgen v0.6.0 capability with sibling git resolution.
Boundary audit of the 0-9.0 delta found no violations of the herdr
source-of-truth / plugin-state / secrets invariants; one minor
sanitization gap (O1) recorded for follow-up. Residuals (unchanged
from feature verifications and issue #214 scope): real forge mutations
not performed live, Linux/Windows install verification not exercised,
open follow-ups #209 (secrets stderr sanitize) and #211 (Windows
test pipe), device-windows unverified.

Cleanup: isolated session `verify214` stopped and deleted;
`/var/tmp/herdr-plugin-214` removed; user's live session, agents, and
worktrees untouched.
