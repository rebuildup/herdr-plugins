# Verification evidence — rebuildup.git PR review/read extensions (Issue #171)

Verification of the additive read-only PR surface
(`pr reviews|comments|checks|logs`, contract `herdr-plugins.git/v1`,
plugin v0.3.0) on two levels: fake-`gh` transport contract tests and a
**real end-to-end run on an isolated named herdr session**
(`verify171`) against the real `gh`-authenticated repo
`rebuildup/herdr-plugins`.

Environment: herdr 0.9.5 (protocol 22, real binary
`~/.local/share/mise/installs/herdr/0.9.5/herdr`), gh 2.105.0
(authenticated as `rebuildup`), Bun 1.4.4, macOS arm64.

## Isolation

- Named session `verify171`, socket
  `/var/tmp/herdr-171/xdg-config/herdr/sessions/verify171/herdr.sock`,
  started headless via `herdr --session verify171 server` with dedicated
  `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HERDR_CONFIG_PATH`
  under `/var/tmp/herdr-171/` and all ambient `HERDR_*` vars unset
  (`env -u …` on every call).
- The user's live session, agents, and worktrees were never touched.
- Pane `w1:p1` was created by `herdr workspace create --cwd
  /var/tmp/herdr-171/repo`, a throwaway git repo whose only remote is
  `https://github.com/rebuildup/herdr-plugins.git` (no fetch needed —
  `gh repo view` resolves `rebuildup/herdr-plugins` from the remote).
- `gh` auth note: with `XDG_CONFIG_HOME` redirected, gh looks for its
  config under the isolated XDG root, so calls passed
  `GH_CONFIG_DIR=/Users/rebui/.config/gh` (read-only auth reuse — the
  plugin still never sees or handles tokens). Overriding `HOME` instead
  breaks gh's keyring-backed auth and was not used.
- Cleanup: `herdr server stop` + `herdr session delete verify171`,
  `/var/tmp/herdr-171` removed.

## Results (all via `bun run src/cli.ts pr <action> w1:p1 <n> --session verify171`)

Target PR: **#166** (`feat(secrets): Infisical 参照解決と env 注入
plugin rebuildup.secrets`), head `160` @
`2835b992…`, base `release-0-8-0` @ `cd18042d…`.

| Action | Invocation | Result |
| --- | --- | --- |
| `pr checks` | `pr checks w1:p1 166` | PASS — 2 checks (`check`/ci SUCCESS, CodeRabbit SUCCESS-skipped) with `bucket`/`state`/`workflow`/`link`/timings; `checks_truncated:false`; head/base `{ref,sha}` echoed |
| `pr reviews` | `pr reviews w1:p1 166` | PASS — honest empty `reviews:[]`, `review_requests:{users:[],teams:[]}` (this repo has no submitted reviews; CodeRabbit auto-review is disabled on non-default branches). Non-empty mapping covered by fake-gh tests |
| `pr comments` | `pr comments w1:p1 166` | PASS — 1 issue comment (CodeRabbit skip-review notice, full body < cap) in `issue_comments`; `line_comments:[]` honest empty; independent `*_truncated:false` |
| `pr logs` (runs) | `pr logs w1:p1 166` | PASS — `mode:"runs"`, 1 workflow run `ci` id `45737821758` (completed/success) for head sha `2835b99…` |
| `pr logs --run` | `pr logs w1:p1 166 --run 45737821758` | PASS — `mode:"run"`, run meta + 1 job `check` id `139635227170` (steps stripped from payload) |
| `pr logs --job` | `pr logs w1:p1 166 --job 139635227170 --lines 5` | PASS — `mode:"job"`, `lines_returned:5`, `total_lines:1492`, `truncated:true`, real Actions log tail (checkout post-steps) |
| Error honesty | `pr reviews w1:p1 160` (#160 is an issue, not a PR) | PASS — structured `{ok:false,error:{kind:"gh_error",message:"gh api …/pulls/160: gh: Not Found (HTTP 404)"}}` on stderr, exit 1. No fabricated empty success |

Pane→repo resolution, `gh` preflight (`--version` ≥ 2.81.0 +
`auth status`), `GH_PROMPT_DISABLED`, argv-only spawn, and
`remoteTimeoutMs` budget are the unchanged ADR-0008 paths shared with
`pr list|status|create|view`.

## Fake-transport contract tests

`tests/gh.test.ts` grew a bash `gh` stub covering `api`, `pr checks`,
and `run list|view` (8 new tests, 22 total in file): argv assembly
(`--repo`, `--json` field lists, `--commit <head-sha>`, `--job`,
`--log`), reviews/comments bounding (50-item cap, 4000-char bodies,
8000-char diff hunks, `*_truncated` flags, full-page conservatism),
`no checks reported` → `checks:[]`, run/job JSON mapping (steps
stripped), and job-log tail truncation (`--lines`, `total_lines`,
`truncated`). `gh` missing/old/unauthenticated/non-zero paths remain
structured `gh_missing`/`gh_error` — never success payloads.

## Residuals

- No PR in `rebuildup/herdr-plugins` currently has submitted reviews or
  line comments, so non-empty review/line-comment payloads are
  fake-gh-test-verified only (field mapping follows the REST schema).
- `gh run view --job --log` whole-log fetch is capped at 64 MiB buffer;
  larger logs surface as `gh_error` rather than partial data.
- Windows/Linux herdr sessions not exercised this round (transport and
  gh argv are platform-neutral; stub tests are POSIX-bash).
