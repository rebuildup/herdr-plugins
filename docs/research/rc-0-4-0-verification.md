# RC verification — v0.4.0 (`rebuildup.checkpoints` Checkpoints)

Verification record for the v0.4.0 release candidate. Fixed target:

- Ticket branch HEAD (code under test): `31640357c3f7d7f01657184f7bcbcddc09096440`
  (branch `94`, on top of `release-0-4-0` @ `6364074`; this document, the
  ledger/PR sync, and a biome-format-only commit land on top — no
  behavioral change after the verified SHA)
- herdr: `0.9.5` (protocol 22), Bun: `1.4.4`, git: `2.56.1`
- Platform exercised: macOS (arm64)

## Environment

| Env | Host | Session | Isolation |
| --- | --- | --- | --- |
| macOS | local (arm64) | `plugin-rc04` | dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`HOME` under `/var/tmp/herdr-plugin-rc04`, headless `herdr server`, clean `PATH` (direct mise bins, no shims) |

The user's live sessions were never intentionally touched; the isolated
session was stopped and deleted after verification. Evidence retained at
`/var/tmp/herdr-plugin-rc04` (server logs, plugin checkout, test repos).

Environment notes (not plugin defects):

- **Ambient `HERDR_*` env wins over `--session`** (known, issue #83):
  this agent environment exports `HERDR_SOCKET_PATH`/`HERDR_PANE_ID`/
  `HERDR_TAB_ID`/`HERDR_WORKSPACE_ID` pointing at the user's live
  session. All verification ran under `env -i` with only the isolated
  `HERDR_SOCKET_PATH` exported for CLI calls.
- **Headless panes need `SHELL`.** The isolated `herdr server` was
  started with `SHELL=/bin/zsh`; without it spawned panes exit
  immediately (same caveat as rc-0-3-0).
- `env -i` + direct binary `PATH` was used throughout (mise shims error
  on the repo's untrusted `mise.toml` when cwd is inside a checkout).
- The auto-capture check needed a real agent: the isolated `HOME`
  symlinked `~/.claude`/`~/.claude.json` (read-only use of existing
  credentials; symlinks removed afterwards) and the server `PATH`
  included the claude mise bin. One trivial prompt was run; Claude
  Code's folder-trust dialog was accepted via `agent send-keys`.

## Results

| # | Area | Method | Result |
| --- | --- | --- | --- |
| 1 | Quality gates | `bun run validate:fast` at `3164035` (`validate:integration` is the same entry) | PASS — tsc clean, biome clean (pre-existing FIXABLE warnings only), **170 tests / 0 fail** (one unrelated `t3json` test hit the 5s timeout once under full-suite load; passes standalone — flaky, not a regression) |
| 2 | Plugin install | `herdr plugin install rebuildup/herdr-plugins/plugins/checkpoints --ref 94` → resolved exactly `3164035`; version **0.4.0**, 1 action, 2 events | PASS |
| 3 | Capability | `capability` → contract `herdr-plugins.checkpoints/v1`, 12 commands, `read_only:false`, `mutation_commands` enumerated (7) | PASS |
| 4 | `create` | `--repo PATH` with label → hidden ref `refs/herdr-plugins/checkpoints/<key>/<id>`, synthetic commit parented to HEAD, `files_summary` (`M file.txt`, `A new.txt`), real index/worktree untouched; pane-targeted `create w1:p1` resolved via session snapshot and projected `checkpoint_latest`/`checkpoint_count` metadata tokens | PASS |
| 5 | `list`/`show`/`diff`/`plan` | aggregate + `--repo` + `--group` listing; `show` reports ref `exists:true`+oid and bounded `git show --stat`; `diff <id> HEAD` returned the real patch; `plan` reported `files_to_change:2`, `untracked_to_delete:0` without mutating | PASS |
| 6 | `delete` | removed ref AND state entry together; `ref_existed:true`; repo ref count dropped 4→3 | PASS |
| 7 | `restore` refusal | 2 live panes (`w1:p1`,`w1:p2`) sharing repo-a → `shared_worktree` error, exit 1, worktree untouched | PASS |
| 8 | `restore --force` | captured mandatory `pre_restore` checkpoint first, restored tracked+staged content, deleted post-checkpoint untracked file, post-verify clean; `isolation:"forced"` + warning recorded | PASS |
| 9 | `save` + `restore-group` | `save --repo A --repo B` → shared `group_id`, per-repo checkpoints; live discovery `save` (no flags) deduped pane cwds → same 2 repos; `restore-group` full success, then partial run: repo-a refused (`shared_worktree`), repo-b restored → `ok:false`, exit 1, `partial_restore` stderr — honest per-repo results | PASS |
| 10 | Linked worktree | `restore <id> --repo <linked-wt> --force` restored into the sibling worktree of the same common dir; main worktree untouched | PASS |
| 11 | `gc` | `--max-count 2 --dry-run` predicted exactly the oldest entry; real run deleted ref+state together, `pre_restore` entry protected; `gc --repo <missing>` → `ok:false` + exit 1 + `unreachable_repos` (new #94 fix verified live) | PASS |
| 12 | `prune` | hand-made orphan ref under the checkpoints namespace deleted; state-referenced refs kept; foreign `refs/herdr-plugins/other/*` untouched; `--dry-run` listed without deleting | PASS |
| 13 | Auto-capture hook | real `claude` agent in pane `w2:p1` (cwd repo-b): `working → done` transition → `pane.agent_status_changed` hook recorded a pending mark → next `list` drained it into a `kind:"auto"` checkpoint of repo-b, reported under `auto_captures.captured` | PASS |
| 14 | Error paths | `unknown_checkpoint`, `unknown_group`, `cross_repo` (diff across repos), `not_a_repo`, usage exit 2, `HEAD` vs `HEAD` rejected | PASS |
| 15 | Regression | `rebuildup.inbox` capability + `list` on the same session unaffected; `rebuildup.git` (`@release-0-2-0`) `status w1:p1` reported correct branch/changes on a checkpoint-touched repo | PASS |

## Audit items (#94)

1. **gc/prune dishonest exit code** — FIXED. `gc` emitted `ok:false`
   when every wanted repo was unreachable but exited 0; `prune`
   hardcoded `ok:true` even when nothing could be scanned. Both now
   compute `ok` honestly and, when false, exit 1 with a structured
   `{kind:"unreachable_repos"}` stderr error (same convention as
   `partial_save`/`partial_restore`). Verified live (#11) and by a new
   unit test. Spec + contract updated.
2. **`deleteRef` missing `--no-deref`** — FIXED (trivial). Now matches
   `prune`'s `update-ref --no-deref -d`.
3. **Ambient `GIT_*` env inheritance** — FOLLOW-UP issue #96 filed.
   `packages/git-core` spawns inherit `process.env` wholesale;
   ambient `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_CONFIG_*`
   could redirect checkpoint capture/restore into the wrong repo or
   object store. Shared-package change → deferred.
4. **`git_missing` mislabel for nonexistent cwd** — OBSERVATION, not
   fixed. `spawn` ENOENT is ambiguous (missing binary vs missing
   cwd); `gc --repo /nonexistent` reports kind `git_missing` ("git
   executable not found on PATH") which is misleading but still lands
   in `unreachable` honestly. Documented here; a `stat` pre-check in
   git-core could disambiguate — folded into the same class of
   follow-up as #96.

## Invariant check (AGENTS.md §4)

- No fabricated states: every failure path is a structured error;
  `unknown`/unreachable are reported, never dressed as success
  (incl. the new `unreachable_repos` exit code).
- Ref atomicity: capture writes via temp `GIT_INDEX_FILE` +
  `update-ref`; state writes are lock + tmp + atomic rename; gc
  deletes ref and state entry together.
- `pre_restore` protection: mandatory capture before any mutation;
  gc exempts recent `pre_restore` entries (`--protect-days`).
- `prune` is orphan-only: deletes solely refs under
  `refs/herdr-plugins/checkpoints/` not named by ANY state entry;
  `--no-deref`; foreign ref namespaces untouched (verified live).
- State lives only under `HERDR_PLUGIN_*_DIR` (verified: state file
  under isolated `XDG_STATE_HOME/herdr/plugins/rebuildup.checkpoints`).
- No secrets: fixed synthetic commit identity, no credential handling,
  `GIT_TERMINAL_PROMPT=0` pinned.
- Auto-capture never fabricates work units: only observed
  `working → idle|done` edges pend; generation-guarded by
  `state_change_seq` + `agent_session`; stale marks dropped.

## Defects / observations

1. **Ambient `HERDR_SOCKET_PATH` overrides `--session`** — known
   environment hazard, follow-up #83 (unchanged).
2. **`git_missing` kind mislabels a nonexistent `--repo` path** — see
   audit item 4; cosmetic, honest `unreachable` outcome regardless.
3. **Disk pressure**: the full `bun test` suite took ~186s on this
   host and one unrelated `t3json` test timed out once at the 5s
   default; it passes standalone and in the checkpoints files. Flaky,
   environmental.
4. Auto-capture used a real Claude Code session (user credentials via
   symlinked `~/.claude`); the folder-trust dialog added one manual
   `send-keys` step. Claude wrote its normal session data under the
   real `~/.claude` — expected side effect, no live-session touch.

## Verdict

**READY FOR APPROVAL on macOS.** All `herdr-plugins.checkpoints/v1`
surfaces verified end-to-end on real herdr 0.9.5 in an isolated
session at the fixed RC SHA (`3164035`): GitHub-install path at ref
`94`, capability, create (repo + pane-targeted with metadata
projection), list/show/diff/plan/delete, plan→restore with
shared-worktree refusal and `--force`, mandatory `pre_restore`
capture, save/restore-group across 2 repos including live pane-cwd
discovery and honest `partial_restore`, linked-worktree `--repo`
restore, gc dry-run+real with `pre_restore` protection and the new
`unreachable_repos` exit-1 path, prune orphan-only deletion, and the
`pane.agent_status_changed` → lazy-drain auto-capture loop with a
real agent. Inbox/git regressions clean. The two #94 audit fixes are
converged; the ambient `GIT_*` concern is filed as #96.
Linux/Windows official-install verification was NOT exercised in this
round (single-host environment) — tracked as residual before
`release-0-4-0 → main`; unit coverage is platform-neutral and the
Windows-specific paths (named-pipe socket, path handling) are
contract-tested.

Cleanup: isolated session `plugin-rc04` stopped and deleted; claude
credential symlinks removed; user's live session otherwise untouched.
