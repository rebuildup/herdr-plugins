# Live verification — `rebuildup.projects` repo↔worktree/diff association (#184)

End-to-end smoke of the `repos list` worktree association against a real
herdr session — complementing the fake-socket/fake-git-plugin contract
tests (`tests/projects-worktrees.test.ts`).

- Plugin: `plugins/projects` @ branch `184` (v0.3.0)
- herdr: `0.9.5` (protocol 22, isolated named session `verify184`,
  headless `herdr server`)
- Bun: system bun; platform: macOS (arm64)

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `verify184` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME` (`/var/tmp/herdr-plugin-184`) — the user's live sessions were never targeted; every CLI call ran with ambient `HERDR_*` socket/workspace vars unset and `HERDR_SESSION=verify184` |
| plugin state | herdr-owned plugin state dir via XDG (`state/herdr/plugins/rebuildup.projects/state.json`); CLI calls ran with `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` unset so `pluginDirs()` resolves the same XDG path |
| test repo | `/var/tmp/herdr-plugin-184/repo` — fresh `git init`, one commit; linked worktree `/var/tmp/herdr-plugin-184/wt` on branch `feature` created via plain `git worktree add`, then opened in herdr via `herdr worktree open` (workspace `w3`, pane `w3:p1`) |
| git plugin | sibling `plugins/git` resolved by the env-pin spawn (`HERDR_PROJECTS_ROOT_GIT` unset → sibling discovery); its CLI ran against the `verify184` session socket only |

The isolated session was stopped and deleted afterwards
(`herdr session stop verify184` / `herdr session delete verify184`); the
git worktree checkout was removed via `git worktree remove --force`.
Evidence retained at `/var/tmp/herdr-plugin-184` (`env.sh` recipe,
`server.log`, scratch `repo/`).

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | `worktree.list` read | `repos list` returned both checkouts (`repo` main checkout + `wt` linked worktree) with live `branch`, `is_linked_worktree`, `open_workspace_id`, `label` — PASS |
| 2 | Pane resolution | After `herdr worktree open`, `wt` reported `open_workspace_id:"w3"` and `panes:[{pane_id:"w3:p1", cwd:"…/wt"}]` resolved via `session.snapshot`; the unrelated main-checkout workspace `w2` panes were not attributed to `wt` — PASS |
| 3 | Git-v1 status via sibling CLI | `panes[0].status` carried `contract:"herdr-plugins.git/v1"`, `ok:true`, `repo_root` = the worktree path (not the member root — pane cwd resolution is correct), `branch`, and `changes` counts; `commands` pointers (`status`/`diff`/`files`/`compare`) emitted per pane — PASS |
| 4 | Dirty propagation | After editing `wt/a.txt`, `wt.dirty=true` (inspectRepo) AND `panes[0].status.changes.unstaged=1` (git plugin) — both surfaces agree — PASS |
| 5 | Pane-less honesty | Before `worktree open`, `open_workspace_id:null` → `panes:[]`, no git/diff fields anywhere in the entry — nothing fabricated — PASS |

## Notes / honest limits

- `worktree.list` was invoked with `trust_repository:false`; the scratch
  repo was trusted by default in the isolated session. The
  untrusted-repo path is covered by contract tests (`repo_untrusted`
  RPC error → `worktrees_error`), not re-verified live.
- `worktrees_error`/`worktrees_skipped` degradation paths
  (`session_unreachable`, `repo_mismatch`, `not_member_repo`,
  `plugin_unavailable`) are covered by `tests/projects-worktrees.test.ts`
  against the fake herdr socket and a fake git plugin root.
- macOS path canonicalization (`/var/tmp` vs `/private/var/tmp`) is
  handled by `canonicalRepoRoot`/`realpathSync` on both the
  `source.repo_root` cross-check and the git-common-dir comparison —
  verified live (herdr reports `/var/tmp/…`, git resolves
  `/private/var/tmp/…`).
- The git plugin `status` spawn is capped at 8 calls per member repo
  (`MAX_GIT_STATUS_CALLS`); beyond that `status_error.kind =
  "budget_exceeded"`.
