# Verification evidence — rebuildup.git issue surface + pane links (Issue #174)

Verification of the additive GitHub issue surface
(`issue list|view|create|edit|comment|close` + delegated
`issue link|unlink|links`, contract `herdr-plugins.git/v1`, plugin
v0.6.0) on two levels: fake-`gh`/fake-inbox transport contract tests and
a **real end-to-end run on an isolated named herdr session**
(`verify174`) against the real `gh`-authenticated repo
`rebuildup/herdr-plugins`.

Environment: herdr 0.9.5 (protocol 22, real binary
`~/.local/share/mise/installs/herdr/0.9.5/herdr`), gh 2.105.0
(authenticated as `rebuildup`), Bun 1.4.4, macOS arm64.

## Isolation

- Named session `verify174`, socket under
  `/var/tmp/herdr-174/xdg-config/herdr/sessions/verify174/`, started
  headless via `herdr --session verify174 server` with dedicated
  `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/
  `HERDR_CONFIG_PATH` under `/var/tmp/herdr-174/` and all ambient
  `HERDR_*` vars unset (`env -u …` on every call).
- The user's live session, agents, and worktrees were never touched.
- Pane `w2:p1` was created by `herdr workspace create --cwd
  /var/tmp/herdr-174/repo`, a throwaway git repo whose only remote is
  `https://github.com/rebuildup/herdr-plugins.git` (no fetch needed —
  `gh repo view` resolves `rebuildup/herdr-plugins` from the remote).
- `gh` auth note: with `XDG_CONFIG_HOME` redirected, gh looks for its
  config under the isolated XDG root, so calls passed
  `GH_CONFIG_DIR=/Users/rebui/.config/gh` (read-only auth reuse — the
  plugin still never sees or handles tokens). Same approach as the
  #171/#172 verifications.
- Cleanup: `herdr server stop` + `herdr session delete verify174`,
  `/var/tmp/herdr-174` removed.

## Results

### Read surface (real gh, real repo)

| Action | Invocation | Result |
| --- | --- | --- |
| `issue list` | `issue list w2:p1 --limit 5` | PASS — `{action:"list", repo:"rebuildup/herdr-plugins", issues:[…]}` with real open issues (newest #211…), gh row shape fields only |
| `issue view` | `issue view w2:p1 174` | PASS — bounded projection of the ticket itself: `state:"OPEN"`, `state_reason`, `closed:false`, author/labels/assignees/milestone, `created_at`/`updated_at`, `url`, full body (< 8000 cap), `comments:[]`/`comments_truncated:false`, `reactions:[]` honest empties |

### Delegated link surface (real herdr session + real inbox plugin)

The sibling-plugin resolution found `plugins/inbox` in the worktree
(`../inbox` fallback — no `inboxPluginRoot` config was set); the
delegated CLI ran against the same `verify174` session socket via the
pass-through `--session`.

| Action | Invocation | Result |
| --- | --- | --- |
| `issue link` | `issue link w2:p1 rebuildup/herdr-plugins#174` | PASS — `{delegated:"rebuildup.inbox", ok:true, link:{kind:"issue",repo:"rebuildup/herdr-plugins",number:174,ref:"…#174"}, links:[…]}`; inbox state written under the isolated plugin state dir |
| `issue links` | `issue links w2:p1` | PASS — same link echoed with `at` timestamp |
| `issue unlink` | `issue unlink w2:p1 rebuildup/herdr-plugins#174` | PASS — `{removed:{…same link…}, links:[]}` |
| `issue links` (after unlink) | `issue links w2:p1` | PASS (honest error) — inbox `links` fails `no inbox state for pane: w2:p1` (entry dropped when it became empty); propagated as exit 1 `error.kind:"inbox_error"`, never a fabricated `links:[]` |

### Mutation surface — contract-tested only

`issue create|edit|comment|close` were **not** executed against the
real repo: they would create/modify real GitHub issues. They are
covered by the fake-`gh` contract tests (`tests/gh.test.ts`,
`tests/git-issue.test.ts`): argv assembly (`gh issue create/edit/
close/reopen`, `gh api repos/{repo}/issues/{n}/comments --input -`),
`--body-file -` stdin discipline, bounded post-mutation view echo,
structured `gh_error`/`gh_missing` failures, mutation target gating
(`target_required` without explicit/ambient target), and per-action
flag whitelists. This matches the #172 precedent (mutations verified
non-destructively; real posts documented as residual).

## Fake-transport contract tests

- `tests/gh.test.ts` — bash `gh` stub extended with `issue` cases
  (`list|view|create|edit|close|reopen|comment`) and `GH_STUB_ISSUE_*`
  env keys; 12 new `describe` cases covering bounded projections,
  argv assembly, stdin bodies, post-state echoes, and error kinds.
- `tests/git-issue.test.ts` — new CLI contract file: fake herdr socket
  + fake `gh` + **real sibling `plugins/inbox`** delegation (link →
  inbox state.json written, links/unlink round-trip, `inbox_unavailable`
  when unresolvable, `inbox_error` propagation, usage errors exit 2).
- `tests/git.test.ts` — 26 `issue` usage-error cases (unknown flags,
  bad positionals, missing required values → exit 2).

## Residuals

- Real forge mutations (`create`/`edit`/`comment`/`close`) unexercised
  against live GitHub — fake-gh verified only (same honesty level as
  #172).
- `issue edit --state` two-step (`gh issue edit` then
  `close`/`reopen`) verified by stub sequencing, not live.
- `issue link --verify` (opt-in gh existence check inside inbox) not
  exercised live; inbox-side `--verify` semantics unchanged by this
  ticket.
- Windows/Linux herdr sessions not exercised (transport and gh argv
  are platform-neutral; stub tests are POSIX-bash).
