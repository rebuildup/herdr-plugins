# Verification evidence — rebuildup.git PR review/comment mutations (Issue #172)

Verification of the forge mutation surface (`pr review|comment|reply|
reviewers`, contract `herdr-plugins.git/v1` additive, plugin v0.4.0) on
two levels: fake-`gh` transport contract tests and a **real end-to-end
run on an isolated named herdr session** (`verify172`) against the real
`gh`-authenticated repo `rebuildup/herdr-plugins`.

**Honesty note:** no review, comment, reply, or reviewer change was ever
submitted to GitHub. Submitting real reviews/comments on the
maintainer's repo is not acceptable, so every check below exercises
only paths that cannot mutate: usage validation, the mandatory
`--expect-head` stale-head guard (which re-fetches the PR head via a
read-only `GET` and refuses *before* any POST), and structured error
mapping for unreachable endpoints. Successful-mutation payload
assembly is covered exclusively by the fake-`gh` contract tests.

Environment: herdr 0.9.5, gh 2.105.0 (authenticated as `rebuildup`),
Bun 1.4.4, macOS arm64.

## Isolation

- Named session `verify172`, socket under
  `/var/tmp/herdr-172/xdg-config/herdr/sessions/verify172/`, started
  headless via `herdr --session verify172 server` with dedicated
  `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HERDR_CONFIG_PATH`
  and all ambient `HERDR_*` vars unset.
- The user's live session, agents, and worktrees were never touched.
- Pane `w2:p1` was created by `herdr workspace create --cwd
  /var/tmp/herdr-172/repo`, a throwaway git repo whose only remote is
  `https://github.com/rebuildup/herdr-plugins.git`.
- `gh` auth reuse via `GH_CONFIG_DIR=/Users/rebui/.config/gh`
  (read-only auth reuse — the plugin never sees or handles tokens).
- Cleanup: `herdr server stop` + `herdr session delete verify172`,
  `/var/tmp/herdr-172` removed.

## Results (all via `bun run src/cli.ts pr <action> w2:p1 <n> --session verify172`)

Target PR: **#189** (merged), head `171` @
`bb8764c4013e0d934b01b5c353a591a6012679e1`, base `release-0-9-0` @
`b04f6040…`. The head sha was obtained through `pr reviews` (the same
`head.sha` field callers must pass to `--expect-head`).

| Check | Invocation | Result |
| --- | --- | --- |
| Read path sanity | `pr view w2:p1 189`, `pr reviews w2:p1 189` | PASS — real head/base `{ref,sha}` echoed; repo resolved to `rebuildup/herdr-plugins` |
| Missing guard | `pr review w2:p1 189 --approve` | PASS — usage error exit 2: `requires --expect-head <full head sha>` |
| Short sha rejected | `pr comment … --expect-head bb8764c` | PASS — usage error exit 2 (full 40/64-hex required) |
| Stale head — review | `pr review … --approve --expect-head 000…0` | PASS — `kind:"stale_head"` exit 1, message reports expected vs current sha; **no POST issued** (guard runs before the write) |
| Stale head — comment | `pr comment … --body hello --expect-head 000…0` | PASS — `stale_head`, no POST |
| Stale head — reply | `pr reply … 22 --body hi --expect-head 000…0` | PASS — `stale_head`, no POST |
| Stale head — reviewers | `pr reviewers … --add-reviewer someone --expect-head 000…0` | PASS — `stale_head`, `gh pr edit` never invoked |
| Missing body | `pr comment w2:p1 189 --expect-head 000…0` | PASS — usage error exit 2 |
| Missing reviewer flag | `pr reviewers w2:p1 189 --expect-head 000…0` | PASS — usage error exit 2 |
| Conflicting review events | `pr review … --approve --comment` | PASS — usage error exit 2 (exactly one event required) |
| Bad `--comments-file` | `--comments-file` pointing at non-JSON | PASS — usage error exit 2 |
| Unknown PR | `pr comment w2:p1 999999 --body hi --expect-head 000…0` | PASS — structured `kind:"gh_error"` exit 1 (`gh api …/pulls/999999: gh: Not Found (HTTP 404)`), no fabricated success |
| Capability | `capability` | PASS — `version:"0.4.0"`, `read_only:false`, `pr` in `mutation_commands` |

Pane→repo resolution, `gh` preflight (`--version` ≥ 2.81.0 +
`auth status`), `GH_PROMPT_DISABLED`, argv-only spawn, stdin-piped
`gh api --input -` payloads, and the `remoteTimeoutMs` budget are the
unchanged ADR-0008 paths shared with the read surface.

## Fake-transport contract tests

`tests/gh.test.ts` grew a bash `gh` stub covering `api … --method POST
--input -` (with stdin payload capture), `pr edit`, and the new
`GH_STUB_*_POST_JSON` fixtures — 14 new tests, 36 total in file:

- `submitPrReview`: argv shape (`api repos/{repo}/pulls/{n}/reviews
  --method POST --input -`), `commit_id` pinned to the verified head
  sha, `event` mapping, `comments[]` (path/line/side/body) delivered in
  the stdin payload, and proof that bodies never appear in argv.
- `submitPrComment` / `submitPrReply`: correct endpoints
  (`issues/{n}/comments`, `pulls/{n}/comments/{id}/replies`), bounded
  echo of the created object.
- `updatePrReviewers`: `gh pr edit --add-reviewer a,b
  --remove-reviewer c` argv and post-mutation `review_requests` echo.
- Stale-head negative fixtures for **every** mutation: mismatched
  `expectHead` rejects with `kind:"stale_head"` and the stub log proves
  no POST/`pr edit` call was made; missing head sha → `gh_error`;
  invalid line-comment entries and reviewer logins rejected before any
  write; `isValidHeadSha` accepts 40/64-hex only.

## Not verified here (by design)

- A successful POST round-trip against real GitHub (review submission,
  comment posting, thread reply, reviewer add/remove). The payload
  shape is pinned by fake-gh tests; the endpoints are the documented
  REST paths used by `gh api`. First real use should be a low-risk
  `pr comment --event COMMENT`-style review on a disposable PR.
- `gh pr edit` reviewer flag semantics on GHES (same `gh` version floor
  as the rest of the surface).
