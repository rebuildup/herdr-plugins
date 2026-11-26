# Verification evidence — rebuildup.git PR merge / auto-merge (Issue #173)

Verification of the forge merge surface (`pr merge`, contract
`herdr-plugins.git/v1` additive, plugin v0.5.0, ADR-0030) on two
levels: fake-`gh` transport contract tests and a **real end-to-end run
on an isolated named herdr session** (`verify173`) against the real
`gh`-authenticated repo `rebuildup/herdr-plugins`.

**Honesty note:** no PR was ever merged and no auto-merge was ever
armed or disarmed on GitHub. Merging a real PR — even a disposable
ticket PR — is not acceptable for verification, so every live check
below exercises only paths that cannot mutate: usage validation, the
mandatory `--expect-head` stale-head guard, merge-state re-verification
refusals (`merge_blocked`), and the release-train hard refusal
(`release_boundary`). The write paths (`PUT pulls/{n}/merge`,
`POST`/`DELETE pulls/{n}/auto-merge`) are covered exclusively by the
fake-`gh` contract tests, including the post-write state re-fetch.

Environment: herdr 0.9.5, gh 2.105.0 (authenticated as `rebuildup`),
Bun 1.4.4, macOS arm64.

## Isolation

- Named session `verify173`, socket under
  `/var/tmp/herdr-173/xdg-config/herdr/sessions/verify173/`, started
  headless via `herdr --session verify173 server` with dedicated
  `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HERDR_CONFIG_PATH`.
- All ambient `HERDR_*` vars were unset for every CLI invocation
  (issue #199 hygiene — `HERDR_SOCKET_PATH` in particular would
  otherwise override `--session` and hit the user's live session).
- The user's live session, agents, and worktrees were never touched.
- Pane `w1:p1` was created by `herdr workspace create --cwd
  /var/tmp/herdr-173/repo`, a throwaway git repo whose only remote is
  `https://github.com/rebuildup/herdr-plugins.git`.
- `gh` auth reuse via `GH_CONFIG_DIR=/Users/rebui/.config/gh`
  (read-only auth reuse — the plugin never sees or handles tokens).
- Cleanup: `herdr server stop` + `herdr session delete verify173`,
  `/var/tmp/herdr-173` removed.

## Targets

- PR **#204** (open ticket PR, head `182` → base `release-0-9-0`,
  `mergeStateStatus: DIRTY`, `mergeable: CONFLICTING`), head sha
  `14b033489a0fe17bade79f9aa35f3e63721a73f6` obtained via `pr checks`.
- PR **#169** (open release PR, head `release-0-8-0` → base
  `release-0-7-0`, `mergeStateStatus: UNKNOWN`) — chosen deliberately:
  even if the release guard regressed, `UNKNOWN` is refused by the
  merge-state check too, so no write could ever land.

## Results (all via `bun run src/cli.ts pr merge w1:p1 <n> --session verify173`)

| Check | Invocation | Result |
| --- | --- | --- |
| Missing guard | `pr merge w1:p1 204` | PASS — usage error exit 2: `requires --expect-head <full head sha>` |
| Short sha rejected | `--expect-head 14b0334` | PASS — usage error exit 2 (full 40/64-hex required) |
| `--auto` without method | `--auto` alone | PASS — usage error exit 2 (`requires --squash, --merge, or --rebase`) |
| Conflicting modes | `--auto --disable-auto --squash` | PASS — usage error exit 2 (mutually exclusive) |
| Two methods | `--squash --merge` | PASS — usage error exit 2 (at most one) |
| Stale head | `--expect-head 000…0 --squash` | PASS — `kind:"stale_head"` exit 1 reporting expected vs current sha; **no write issued** (guard runs before any PUT/POST/DELETE) |
| Dirty immediate merge | correct `--expect-head --squash` on #204 | PASS — `kind:"merge_blocked"` exit 1; message carries `mergeStateStatus=DIRTY reviewDecision=null mergeable=CONFLICTING isDraft=false head=182 base=release-0-9-0`; **no PUT issued** |
| Dirty auto-merge | `--auto --squash` on #204 | PASS — `kind:"merge_blocked"` (`cannot be queued for auto-merge`, same state echo); **no POST issued** |
| Release head — merge | correct `--expect-head --merge` on #169 | PASS — `kind:"release_boundary"` exit 1 (`refusing to merge release-train head 'release-0-8-0'`); **no write issued** |
| Release head — auto-merge | `--auto --merge` on #169 | PASS — `kind:"release_boundary"`; **no POST issued** |
| Head moved mid-check | `--disable-auto` on #169 | PASS — `kind:"stale_head"` (the release head advanced between `pr checks` and the merge attempt — the guard caught a real race); no DELETE issued |
| Capability | `capability` | PASS — `version:"0.5.0"`, `read_only:false`, `pr` in `mutation_commands` |

Pane→repo resolution, `gh` preflight, `GH_PROMPT_DISABLED`, argv-only
spawn, `--input -` payloads, and the `remoteTimeoutMs` budget are the
unchanged ADR-0008 paths.

## Fake-transport contract tests

`tests/gh.test.ts` grew `PUT`/`DELETE`/`auto-merge` handling in the bash
`gh` stub plus `GH_STUB_MERGE_*` fixtures and a post-write `pr view`
fixture — 21 new tests, 57 total in file:

- Immediate merge: `PUT pulls/{n}/merge` argv + stdin payload pins
  `sha` to the verified head and `merge_method`; `result:"merged"` only
  on `merged:true`; `merged:false` reports `result:"pending"` with the
  re-fetched `state:"OPEN"` — never fabricated.
- `mergeStateStatus` matrix: `BLOCKED`/`DIRTY`/`BEHIND`/`UNKNOWN`/
  `DRAFT`/`HAS_HOOKS` all refuse `merge_blocked` with zero writes;
  `UNSTABLE` proceeds (non-required check failures are not a gate).
- Draft and already-`MERGED` PRs refuse; stale head refuses before any
  write for merge **and** `--disable-auto`.
- Release-train head (`release-0-9-0`, `release-1-0-0`) refuses merge
  and auto-merge with `release_boundary`; a ticket branch (`173`)
  targeting `release-0-9-0` as **base** merges normally — the guard
  keys on head only.
- gh HTTP 405 maps to `merge_blocked`.
- Auto-merge: `POST pulls/{n}/auto-merge` with `merge_method`; armed
  `auto_merge_request` echoed from the post-write fetch while `state`
  stays `OPEN` (queued, not merged); `DIRTY`/`DRAFT`/`UNKNOWN` refuse
  but `BLOCKED` (pending checks — auto-merge's purpose) is allowed;
  missing method rejected before any fetch; `--disable-auto` issues
  `DELETE pulls/{n}/auto-merge`.

## Not verified here (by design)

- A successful merge or auto-merge round-trip against real GitHub.
  Payload shapes and endpoint paths are pinned by the fake-gh tests;
  the `sha` parameter semantics are the documented REST contract.
  First real use should be a low-risk ticket PR.
- Merge-queue repository behavior end-to-end (no merge-queue repo is
  available); the plugin reports `mergeStateStatus`/`state`/
  `auto_merge_request` verbatim and does not interpret queue timing.
