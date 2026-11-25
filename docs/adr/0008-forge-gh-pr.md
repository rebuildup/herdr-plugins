# ADR-0008: GitHub PR surface via the host `gh` CLI, inside `herdr-plugins.git/v1`

## Status

Accepted (v0.2.0, `rebuildup.git`, Issue #25 / ticket #39)

## Context

Issue #25 requires a GitHub-first PR foundation: list, status, create,
view — without the plugin ever holding GitHub tokens or reimplementing
a forge client. Issue #39 leaves one design decision open: extend
`herdr-plugins.git/v1` or cut a separate forge contract.

Upstream T3 Code (`docs/user/source-control.md` at pinned
`9cc4018c`) supports many forges and a much wider PR surface (review
comments, reviewers, auto-merge, CI logs). This ticket deliberately
covers only the GitHub `gh`-CLI foundation; the residual is tracked in
the feature ledger (`forge-non-github`) and later tickets.

## Decision

1. **`gh` CLI is the only forge transport.** Detection requires
   `gh --version` >= 2.81.0 (matching upstream's documented floor) and
   `gh auth status` success; both failures are structured errors
   (`gh_missing` / `gh_error`). Repo resolution is `gh repo view`
   inside the pane's repo root, so remotes, `GH_HOST` (GHES), and the
   user's `gh auth` accounts apply unchanged. `--repo owner/name`
   overrides for ambiguous cases.
2. **Stay on `herdr-plugins.git/v1`.** PR commands are additive under a
   `pr` action namespace on the same CLI/pane→repo resolution. A
   separate contract would duplicate discovery, target resolution, and
   error conventions for zero compatibility benefit; the contract
   versioning rule (additive only while reads are unchanged) already
   covers this. Recorded here per Issue #39's requirement.
3. **Read-mostly surface.** `pr list`/`status`/`view` are read-only;
   only `pr create` mutates the forge. `pr` is listed in
   `mutation_commands` (conservative superset) so clients feature-detect
   it as mutation-capable.
4. **Bodies never ride in argv.** `pr create` takes `--body` for short
   text or `--body-file PATH`/`-` (stdin) for long bodies; the plugin
   reads the file/stdin itself and pipes it to `gh --body-file -`.
5. **Non-interactive by construction.** `GH_PROMPT_DISABLED=1`, stdin
   closed immediately, `remoteTimeoutMs` budget. gh's own push/prompt
   flow is not driven — the branch must already be pushed.
6. **Bounded output.** `pr view` truncates body at 8000 chars, caps
   reviews at 10 and `statusCheckRollup` at 50 with explicit
   `*_truncated` flags. PR state is exposed, never acted on — the
   plugin cannot approve, merge, or satisfy merge gates.
7. **No token handling.** The plugin never reads, stores, or injects
   `GH_TOKEN`/`GITHUB_TOKEN`; ambient env passes through to `gh` exactly
   as the user's own shell would provide it.

## Consequences

- `gh` absence/degradation degrades only `pr` commands; every git
  command is unaffected (same failure isolation as ADR-0006/0007).
- gh CLI upgrades can change `--json` field availability; fields are
  fixed strings so a gh regression fails loudly as `gh_error`, not as
  silently missing data.
- Merge/review/CI-log/other-forge scope is explicitly deferred;
  extending later means new tickets plus possibly contract review,
  not silent additions here.
