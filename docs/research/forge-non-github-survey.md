# Research: non-GitHub forge provider survey (Issue #175)

Status: doc-only survey for `forge-non-github` (feature ledger), first
step of Issue #25's "GitHub first, other forges staged" plan. No plugin
code changes; this document records per-provider feasibility verdicts
and the follow-up issues filed from them.

Cross-check basis (pinned):

- t3code `9cc4018c75ff4c61be8e86a6391d49a6c2d79830` — local checkout
  `/Users/rebui/work/t3code` verified at this revision (`git rev-parse
  HEAD`). Sources: `docs/user/source-control.md`,
  `packages/source-control-{gitlab,forgejo,bitbucket,azure-devops,
  gitcafe,cursor-origin}/`, `packages/source-control-core/`,
  `packages/contracts/src/pullRequest.ts`.
- herdr-plugins contract style: `docs/contracts/git-v1.md`,
  `docs/specs/git.md`, ADR-0006/0007/0008 (argv spawn, credential
  delegation, additive contract evolution).

## Method

For each provider upstream supports beyond GitHub, this survey records:

1. **Upstream implementation reality** — which T3 Code
   `source-control-*` package exists, what transport it uses (CLI vs
   REST API), and which capability areas are implemented (PR/MR
   operations, review, CI/checks, issue tracker).
2. **CLI/auth path** — whether a host CLI exists that our plugin could
   argv-spawn with the user's own credentials, matching the ADR-0008
   `gh` model (plugin never holds tokens).
3. **Contract fit** — whether the `herdr-plugins.git/v1` `pr`
   namespace style (pane → repo resolution, argv spawn, structured
   errors, bounded output) extends cleanly.
4. **Verdict** — `implement` (follow-up issue filed), `defer`
   (real but blocked/low-demand now), or `not-worth-it` (recorded
   rationale, no issue).

## Upstream provider inventory (t3code @ 9cc4018c)

`docs/user/source-control.md` names eight providers: GitHub, GitLab,
Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, Cursor Origin.
Forgejo and Gitea share one upstream integration
(`source-control-forgejo`, picker label "Forgejo / Gitea"), so the
survey covers **seven non-GitHub entries**.

| Provider | Upstream package | Transport | Issue tracker | Notes |
| --- | --- | --- | --- | --- |
| GitLab | `source-control-gitlab` | `glab` CLI | yes (`GitLabIssueTracker`) | self-managed + gitlab.com |
| Forgejo / Gitea | `source-control-forgejo` | `fj` CLI, `tea` fallback | yes (`ForgejoIssueTracker`) | any host incl. subpath mounts; Codeberg public |
| Bitbucket | `source-control-bitbucket` | REST API only (`api.bitbucket.org/2.0`) | no | token credentials, no CLI |
| Azure DevOps | `source-control-azure-devops` | `az` CLI (+ `azure-devops` ext) | yes (`AzureDevOpsIssueTracker`, work items) | comment/review surface thin |
| GitCafe | `source-control-gitcafe` | `cafe` CLI + REST | no | single vendor host `git.cafe` (+staging) |
| Cursor Origin | `source-control-cursor-origin` | `origin` CLI | no | Cursor's own forge |

## Per-provider assessment

### GitLab — verdict: implement

- **Upstream reality.** The most complete non-GitHub integration:
  `GitLabCli.ts` wraps `glab` for MR operations; `GitLabPullRequestProvider`
  implements diff, comments, inline review with verdicts, reactions,
  mentions, labels, checks, and the widest action set of any non-GitHub
  provider (`merge`, `ready`/`draft`, `close`/`reopen`, `update-branch`
  (rebase), `enable/disable-auto-merge`, `revert`, `delete-branch`;
  merge methods merge/squash/rebase). `GitLabIssueTracker` covers issues.
  `gitLabDiscovery`/`gitLabAuthStatus` handle self-managed instances.
- **CLI/auth.** `glab` is a mature standalone CLI; `glab auth login`
  stores per-host credentials (gitlab.com, self-managed, and
  `GITLAB_HOST`-style instances). This is the same shape as `gh`:
  argv spawn + host CLI credential store, zero token handling in the
  plugin. Non-interactive operation is supported (`--output json`-style
  machine output exists across `glab` commands; upstream already drives
  it this way).
- **Contract fit.** Excellent — mirrors ADR-0008 almost exactly. The
  main design wrinkle is MR-vs-PR terminology and GitLab's
  nested-group project paths (`group/sub/repo`), which affects repo
  resolution (`glab repo view` equivalents) and `--repo` override
  syntax.
- **Rationale.** Highest user value after GitHub; GitLab is the most
  common self-hosted forge. Follow-up issue filed.

### Forgejo / Gitea — verdict: implement

- **Upstream reality.** One integration covers both (`fj` preferred,
  `tea` ≥ 0.16 fallback; the doc's subpath-mount caveat — servers under
  a URL path like `https://example.com/forgejo` require `tea` — is
  handled upstream in `ForgejoCli.ts`). `ForgejoPullRequestProvider`
  supports diff, comments, inline review (but `reply: false` and no
  thread resolution — "Forgejo's public API has no thread replies/
  resolution or draft conversion endpoint"), merge methods
  merge/squash/rebase/fast-forward, `update-branch` (merge+rebase),
  labels, reactions, mentions; `changeRequestActions` =
  merge/close/reopen/update-branch. `ForgejoIssueTracker` covers issues.
  Codeberg (`codeberg.org`) is the public host; self-hosted instances
  are first-class.
- **CLI/auth.** `fj` (Forgejo CLI, codeberg.org/forgejo-contrib) and
  `tea` (gitea.com/gitea/tea) are both real CLIs with `auth add-token`/
  `login add` per-host credential stores — again the `gh` model.
  Complication vs GitLab: **two CLIs with different capabilities and a
  host-resolution matrix** (fj loses subpath mounts; multiple `tea`
  logins need `tea login default`; full-URL repo spec needed with
  multiple fj servers). Upstream's resolution logic in
  `ForgejoCli.ts` (~800 lines incl. tests) is the reference.
- **Contract fit.** Good, with the caveat that repo resolution is
  genuinely more complex than `gh repo view` — the plugin must either
  port upstream's fj/tea selection logic or restrict v1 to the
  single-server/simple cases and report structured
  `unsupported`/`ambiguous` errors otherwise (consistent with the
  no-fabrication invariant).
- **Rationale.** Gitea/Forgejo/Codeberg are the standard self-hosted
  lightweight forges; one follow-up issue covers both (mirroring
  upstream's single integration entry).

### Azure DevOps — verdict: implement (lower priority)

- **Upstream reality.** `AzureDevOpsCli.ts` wraps `az` (+ `azure-devops`
  extension); `AzureDevOpsPullRequestProvider` covers diff, merge
  (merge/squash only — no rebase), `ready`/`draft`, `close`/`reopen`,
  auto-merge, PR edit. **Thin review surface**: `comment: false`,
  `inlineComment: false`, no review verdicts, `search: false` ("`az
  repos pr list` has no text filter"), no reactions/mentions. Comments
  are host-website-only per the user doc. `AzureDevOpsIssueTracker`
  covers work items.
- **CLI/auth.** `az login` + `az extension add --name azure-devops`;
  `az repos`/`az boards` commands are scriptable. `az` is a heavy,
  general-purpose dependency (Azure-wide auth) but it is the user's
  own credential store — plugin holds nothing.
- **Contract fit.** Same argv-spawn model; the reduced capability set
  means the contract payload must tolerate absent comment/review
  fields (already the pattern: bounded projections + explicit
  capability reporting).
- **Rationale.** Implementable and worth a ticket, but value is lower
  than GitLab/Forgejo (no inline review/comments via CLI surface) and
  `az` setup is heavier. Filed as a backlog/release-0-9-0+ candidate.

### Bitbucket — verdict: defer

- **Upstream reality.** `source-control-bitbucket` is a **pure REST
  client** (`BitbucketApi.ts`, `BitbucketPullRequestApi.ts` against
  `https://api.bitbucket.org/2.0`) — there is no `bb`/official CLI path
  upstream uses. Capabilities are decent: diff, comments, inline review
  with verdicts/reply/resolve, reviewer request, merge/squash/rebase.
  No issue tracker integration.
- **CLI/auth.** No CLI. Upstream auth is T3's own secret store or
  `T3CODE_BITBUCKET_ACCESS_TOKEN` /
  `T3CODE_BITBUCKET_EMAIL`+`T3CODE_BITBUCKET_API_TOKEN` env vars.
- **Contract fit — the blocker.** Our boundary invariants (ADR-0008 §7
  "no token handling"; root contract "no ambient secret inheritance")
  forbid the plugin from holding or ambiently inheriting forge tokens.
  A Bitbucket implementation would need a *new* credential mechanism:
  either an explicit opt-in credential file under the plugin config dir
  (precedent exists in ADR-0018-style `keys/<id>.key` for textgen, but
  that required its own ADR) or a documented env contract that does not
  count as "ambient" (e.g. `BITBUCKET_TOKEN` explicitly required and
  documented). Either way it is a policy decision, not a mechanical
  port.
- **Rationale.** Real capability, but blocked on a credential-boundary
  decision and Bitbucket demand is unproven in this ecosystem. Defer;
  revisit if (a) a credentials ADR establishes the pattern or (b) user
  demand appears. No follow-up issue filed — the deferral and its
  unblock conditions are recorded here and in the #25 comment.

### GitCafe — verdict: not-worth-it

- **Upstream reality.** `source-control-gitcafe` targets exactly two
  hosts (`gitCafeHosts.ts`: `git.cafe`, `staging.git.cafe`). Transport
  is the `cafe` CLI (`@gitcafe/cli` via bun) plus REST; credentials via
  `CAFE_TOKEN`/`cafe auth login` or T3 secret store. PR provider exists
  with stack support, but the user doc states **line comments are not
  available** and there is **no issue tracker**.
- **CLI/auth.** `cafe` CLI exists but is a thin single-vendor tool.
- **Contract fit.** Technically feasible (CLI + env token), but the
  ecosystem is one small hosted service.
- **Rationale.** Not worth a plugin surface: single-vendor host, no
  issue tracker, no line comments even upstream, minimal CLI
  ecosystem. Recorded; no issue.

### Cursor Origin — verdict: not-worth-it

- **Upstream reality.** `source-control-cursor-origin` wraps the
  `origin` CLI (Cursor's own forge at `origin.cursor.com`). PR-only:
  no issue tracker, `search: false`, no reactions, reviewers cannot
  even be listed (`request: false, listCandidates: false`). Actions are
  merge/ready/draft/close/reopen; merge methods merge/squash.
- **CLI/auth.** `origin auth login` + `origin auth setup-git`; Cursor
  ecosystem-specific.
- **Contract fit.** Feasible mechanically.
- **Rationale.** Cursor Origin is a niche, vendor-tied forge with a
  deliberately minimal API surface upstream. Unless herdr-plugin users
  demonstrably work in Origin repos, the maintenance cost outweighs
  value. Recorded; no issue.

## Contract-design notes for implementation tickets

These are inputs to the follow-up issues, not decisions made here:

1. **Provider-neutral naming.** `git-v1`'s `pr` namespace leaks GitHub
   terminology (`pr`, `gh_*` error codes). Non-GitHub providers need
   either (a) a `--forge`/auto-detected provider dimension with
   neutral field names in v1 additive extensions, or (b) a parallel
   `mr`/`forge` namespace. GitLab calls them merge requests; the
   contract should not hard-code "pull request" semantics where the
   host differs (e.g. GitLab nested groups, ADO work items vs issues).
2. **Capability reporting.** Upstream's `PullRequestCapabilities`
   struct (diff/comment/actions/mergeMethods/review/reviewers/
   updateMethods/search/reactions/labels/stacks/…) is a good model:
   per-provider capability advertisement avoids fabricating
   unsupported operations. Our contract already does bounded
   projections; extending with an explicit capability map is the
   natural fit.
3. **"GitHub only closes v1" policy.** The contract stays additive:
   GitHub's `pr` surface is unchanged; new providers add subcommands
   or a sibling namespace without breaking `herdr-plugins.git/v1`.
   No v1 field may be redefined when non-GitHub providers land —
   GitHub-specific fields (e.g. `statusCheckRollup` naming) get
   provider-neutral aliases or per-provider payloads.
4. **Credential boundary.** Every `implement` verdict relies on a
   host CLI credential store (`glab`, `fj`/`tea`, `az`) — the ADR-0008
   model. Bitbucket is the only provider that would break it, which is
   why it is deferred rather than rejected.

## Verdict summary

| Provider | Verdict | Follow-up issue |
| --- | --- | --- |
| GitLab | implement | filed (see #25 comment) |
| Forgejo / Gitea | implement | filed (see #25 comment) |
| Azure DevOps | implement (lower priority) | filed (see #25 comment) |
| Bitbucket | defer — needs credential-boundary ADR + demand | none |
| GitCafe | not-worth-it — single-vendor, thin CLI, no issues/line comments | none |
| Cursor Origin | not-worth-it — niche vendor forge, minimal API | none |

Related: #25 (parent scope), #22 (program), #175 (this survey),
`docs/contracts/git-v1.md`, ADR-0008.
