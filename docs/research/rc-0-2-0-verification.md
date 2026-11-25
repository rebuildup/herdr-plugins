# RC verification — v0.2.0 (`rebuildup.git` Source Control)

Verification record for the v0.2.0 release candidate. Fixed target:

- Release branch HEAD: `6b7ea50ac4c09def4627addfcca926fa4c44ba81`
  (`release-0-2-0`, includes PRs #41–#47)
- herdr: `0.9.5` (protocol 22), Bun: `1.4.4`, gh: `2.105.0`
- Platform exercised: macOS (arm64)

## Environment

| Env | Host | Session | Isolation |
| --- | --- | --- | --- |
| macOS | local (arm64) | `plugin-rc02` | dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`HERDR_CONFIG_PATH` under `/var/tmp/herdr-plugin-rc02`, clean `PATH` (direct mise bins, no shims) |

The user's live sessions were never touched. The isolated session was
stopped and deleted after verification. The RC checkout lived in a
dedicated worktree (`herdr-plugin-rc02`, detached at `6b7ea50`).

Environment notes (not defects):

- Running herdr commands with cwd inside the repo fails — the repo's
  `mise.toml` makes mise shims error on untrusted project config.
  Verification used explicit binary `PATH` and cwd
  `/var/tmp/herdr-plugin-rc02`.
- `XDG_CONFIG_HOME` redirects gh's config lookup, so `pr` commands
  needed `GH_CONFIG_DIR=$HOME/.config/gh` (gh auth is via keyring,
  account `rebuildup`). Operators with isolated XDG dirs hit the same
  requirement — documented here for the record.

## Results

| # | Area | Method | Result |
| --- | --- | --- | --- |
| 1 | Quality gates | `bun install`, `bun run validate:fast`, `validate:integration` at `6b7ea50` | PASS — tsc clean, biome clean (3 pre-existing FIXABLE warnings), **70 tests / 0 fail** |
| 2 | Plugin install | `herdr plugin link` git+inbox; `plugin install rebuildup/herdr-plugins/plugins/git --ref release-0-2-0` → resolved exactly `6b7ea50` | PASS |
| 3 | Capability | `capability` → contract `herdr-plugins.git/v1`, v0.2.0, 16 commands incl. files/diff/log/compare/stage/…/remote/pr/project; `read_only:false`; `mutation_commands` enumerated; `remoteTimeoutMs:60000`, `timeoutMs:10000`, `diffMaxBytes:262144` | PASS |
| 4 | `status` | branch/upstream/ahead-behind/staged/unstaged/untracked/conflicted counts vs fixture | PASS |
| 5 | `files` | rename (`kind:renamed`, `oldPath`), untracked binary (`binary:null`), `--path` filter | PASS |
| 6 | `diff` | worktree patch; `--path`; `--staged --name-status` (`R100` rename record); `--numstat`; rev-pair; binary differ; `--max-bytes` → `truncated:true` | PASS |
| 7 | `log` / `compare` | commit records newest-first; `--all`/`--limit`/`--grep`; `compare main feature` merge-base + ahead/behind/files/stat/patch; default `origin/main..HEAD` | PASS |
| 8 | Local mutations | `stage --path`/`--all`, `unstage`, `commit -m` (sha returned), empty-commit structured `git_error`; `branch create --switch`/`switch`; `upstream` tracking | PASS |
| 9 | Remote ops | `fetch` (default + `--prune`), `push` (verified via `ls-remote` on bare remote), `push --set-upstream` tracking; **credential stripping**: `https://user:secretpass@host/…` reported without credentials | PASS |
| 10 | `pr` read surface | real GitHub, repo `rebuildup/herdr-plugins`: `pr list`, `pr status` (branch → PR #55; detached HEAD → `pr:null, detached:true`), `pr view 55` full payload incl. checks; `pr view 99999999` → structured `gh_error`; bad args → usage exit 2 | PASS |
| 11 | `pr create` | **not run** (real-world mutation forbidden during RC). Arg validation (`--title` required) precedes any gh call — code-inspected | NOT RUN (by policy) |
| 12 | Pane context | `herdr plugin action invoke status` → focused pane resolved; `HERDR_PANE_ID` env path; `project` wrote `git_branch`/`git_changes`/`git_ahead_behind` metadata tokens visible via `pane get` | PASS |
| 13 | Error paths | non-git pane → `not_a_repo`; missing pane → `pane_not_found`; unknown command/bad flags → `usage` exit 2; unauthenticated gh → `gh_error` exit 1 | PASS |
| 14 | Inbox regression | `rebuildup.inbox` capability/list/settle/restore at `6b7ea50` — unaffected | PASS |

## Defects found

None blocking. Observations:

1. **Usage-error kind inconsistency**: `stage` without `--all`/`--path`
   and `commit` without `-m` return `kind:"git_error"` exit 1, while
   equivalent misuse elsewhere returns `code:"usage"` exit 2.
   Cosmetic contract inconsistency; candidate for a follow-up ticket.
2. **Unknown `--flags` silently ignored**: `status <pane> --bogus`
   exits 0 (parser skips `--*` args). Leniency, not a defect; noted.
3. **gh-auth check precedes arg validation** in `cmdPr`: without gh
   auth, `pr create`/`pr view` misuse reports `gh_error` instead of
   usage errors. Acceptable ordering.

## Verdict

**READY FOR APPROVAL.** All contract surfaces verified end-to-end on
real herdr 0.9.5 in an isolated session at the fixed RC SHA, including
the GitHub-install path, all mutations against a local bare remote,
remote-credential stripping, gh read-only PR commands against the real
repository, pane-context resolution, and structured error paths.
`pr create` was intentionally not exercised (real mutation); its
pre-flight validation was code-inspected. `rebuildup.inbox` is
unaffected.

Cleanup: isolated session `plugin-rc02` stopped and deleted; user's
live session untouched. Evidence retained at `/var/tmp/herdr-plugin-rc02`
and worktree `/Users/rebui/work/herdr-plugin-rc02` (detached at RC SHA).

## Addendum — #64 convergence verification (fixed SHA `837e63e`)

After PR #79 (strict option parsing + unified usage errors + `pr create`
fixtures), the candidate moved to `837e63e2803af3be96643ee4ca159321680eb5f4`.
Cross-platform verification ran on isolated herdr 0.9.5 sessions
(`plugin-rc64-wsl`, `plugin-rc64-win`; dedicated XDG dirs; user sessions
untouched, sessions deleted afterward).

| Host | Result |
| --- | --- |
| Linux WSL2 (`device-wsl`, bun 1.4.5, gh 2.105.0) | **READY** — official `plugin install --ref release-0-2-0` resolved `837e63e` exactly; full read/mutation/remote/`pr` read surface verified; strictness checks (`--bogus`→exit 2, `stage`/`commit` misuse→exit 2) confirmed; inbox regression PASS |
| Windows 11 (`device-windows`, bun.exe, gh 2.105.0) | **READY** — identical coverage; exit codes verified via `$LASTEXITCODE`; inbox regression PASS |

`pr create` was again **not run** (real mutation forbidden); argv/body-file/
failure paths are covered by stub-gh fixtures in `tests/gh.test.ts` (PR #79).
The real GitHub `pr create` path remains explicitly unverified by policy.

Environment caveats (not plugin defects): Windows sshd kills foreground
`herdr server` on session end (headless servers need a persistent
session); `GH_CONFIG_DIR` must point at real gh config when `XDG_CONFIG_HOME`
is redirected; mise shims unusable over non-interactive ssh (direct binary
paths used, same as RC 0.1.0).

Combined with the macOS run above, all three target platforms now have
RC evidence at the fixed candidate SHA.
