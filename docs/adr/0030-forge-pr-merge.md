# ADR-0030: PR merge / auto-merge via `gh api` REST, with merge-state guard and release-train refusal

## Status

Accepted (v0.5.0, `rebuildup.git`, Issue #173 / #25 decomposition T3)

## Context

Issue #173 asks whether `rebuildup.git` should expose an explicit
user-invoked merge operation on top of the #171 read surface
(`mergeStateStatus`/`reviewDecision`/`statusCheckRollup`) and the #172
mutation surface (`--expect-head` stale-head guard, `gh api --input -`
payloads). Upstream T3 Code (`docs/user/source-control.md` at pinned
`9cc4018c`) offers merge, auto-merge, and merge-queue support after
review. Hard requirements from the issue and the github-delivery skill:

- re-verify merge state immediately before merging and merge only the
  verified head sha;
- report merge-queue/pending states honestly — never claim merged when
  GitHub queued or deferred;
- never bypass the release-approval boundary: `release-* -> main`
  merges wait for explicit maintainer authorization;
- structured errors for blocked/dirty/behind/failing-checks states.

## Decision

1. **Provide `pr merge` as an explicit CLI mutation** (the issue left
   provide/not-provide open; providing was chosen because the read
   surface already exposes everything needed and agents need a
   first-class, guarded path instead of shelling out to `gh`
   themselves). Three modes on one action:
   `pr merge <n> [--squash|--merge|--rebase]` (immediate),
   `--auto` (arm auto-merge, method flag required), `--disable-auto`
   (disarm).
2. **Transport is `gh api` REST, not `gh pr merge` argv.** The issue
   sketched `gh pr merge`; the REST endpoints
   (`PUT pulls/{n}/merge` with `sha`, `POST`/`DELETE
   `pulls/{n}/auto-merge`) were chosen because they (a) pin the head sha
   server-side via the `sha` parameter, (b) return structured JSON
   (`merged`, `sha`, `message`) instead of human text, and (c) reuse the
   #172 `ghApiCall`/`--input -` machinery unchanged. `gh pr merge`'s
   interactive prompts (method selection, branch deletion) would have
   needed extra non-interactive flags anyway; ADR-0008's argv-only,
   no-shell, prompt-disabled discipline is identical either way.
3. **Two-layer freshness guard.** `--expect-head` stays mandatory. The
   pre-write fetch is `gh pr view --json` (`mergeStateStatus`,
   `reviewDecision`, `isDraft`, `headRefOid`, `headRefName`,
   `baseRefName`, `autoMergeRequest`) which yields both the stale-head
   check (`headRefOid === expectHead` → else `stale_head`) and the
   merge-state classification in a single call.
4. **Merge-state classification is conservative and honest.**
   Immediate merge proceeds only for `CLEAN`/`UNSTABLE`
   (`UNSTABLE = non-required checks failing`; required-gate failures
   surface as `BLOCKED`); `BEHIND`, `BLOCKED`, `DIRTY`, `DRAFT`,
   `HAS_HOOKS`, `UNKNOWN`, drafts, and non-`OPEN` states refuse with
   `merge_blocked` plus the observed values in the message. Auto-merge
   refuses only `DIRTY`/`DRAFT`/`UNKNOWN` — `BLOCKED` is its purpose.
   gh HTTP 405/409/422 write refusals map to `merge_blocked`; other
   failures stay `gh_error`. Post-write state (`state`,
   `auto_merge_request`) is re-fetched so merge-queue semantics are
   reported as GitHub records them; `result` is `merged` only on
   `merged: true` from the API (`pending` otherwise).
5. **Hard release-train refusal.** Any PR whose **head** ref matches
   `release-<digits>(-<digits>)*` is refused with
   `release_boundary` for merge *and* auto-merge. The guard keys on the
   head ref only: ticket PRs targeting `release-x-y-z` as *base* (the
   normal train flow) are unaffected. This makes the github-delivery
   boundary structural rather than advisory — no caller, agent, or
   automation path can merge or arm auto-merge on a release PR through
   this plugin.
6. **Contract stays `herdr-plugins.git/v1` (additive).** New action +
   new error kinds only; all read payloads unchanged. Plugin version
   bumps to 0.5.0.

## Consequences

- Merge-queue repositories: `mergeStateStatus` is reported verbatim in
  `pre_merge_state` and post-write `state`/`auto_merge_request`; the
  plugin never interprets queue position or timing.
- A `CLEAN`-state merge can still be refused server-side (race between
  the guard fetch and the PUT); that surfaces as `merge_blocked` via
  the 405/409/422 mapping — the stale-head `sha` pin bounds the race to
  "same commits, changed protection", never "different commits".
- `--disable-auto` keeps the `--expect-head` guard for uniformity even
  though no merge is armed; disarming on a moved head is still refused.
- Out of scope (later tickets if wanted): merge-queue entry
  manipulation, GitHub stack merges, agent credits, `gh pr merge`'s
  branch-deletion flow, non-GitHub forges.
