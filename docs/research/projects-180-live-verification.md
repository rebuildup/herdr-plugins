# Live verification — `rebuildup.projects` `runOnWorktreeCreate` auto-triggers (#180)

End-to-end smoke of `t3.json` `runOnWorktreeCreate` scripts firing on real
herdr `worktree.created` plugin-hook events — complementing the
fake-hook/transport contract tests (`tests/projects-triggers.test.ts`).

- Plugin: `plugins/projects` @ branch `180` (v0.2.0)
- herdr: `0.9.5` (protocol 22, isolated named session `verify180`,
  headless `herdr server`)
- Bun: system bun; platform: macOS (arm64)

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `verify180` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME` (`/var/tmp/herdr-plugin-180`) — the user's live sessions were never targeted; every CLI call ran with ambient `HERDR_*` socket/workspace vars unset |
| plugin install | `herdr plugin link plugins/projects` inside the isolated session — manifest registered `[[events]] on="worktree.created"` → `bun run src/hook.ts` |
| plugin state | herdr-owned plugin state dir (`state/herdr/plugins/rebuildup.projects/state.json`); CLI calls ran with `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` unset so `pluginDirs()` resolves the same XDG path |
| test repo | `/var/tmp/herdr-plugin-180/repo` — fresh `git init`, `t3.json` with one `runOnWorktreeCreate: true` script (`bootstrap`: `echo worktree-create-fired && pwd`) |

The isolated session was stopped and deleted afterwards
(`herdr session stop verify180` / `herdr session delete verify180`); the
git worktree checkout was removed via `git worktree remove --force`.
Evidence retained at `/var/tmp/herdr-plugin-180` (server log, `env.sh`
recipe, plugin `state.json`, `runs.json`, `runs/*.log`).

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | Manifest wiring | `plugin link` registered `worktree.created` → `bun run src/hook.ts`; `plugin list` shows the event enabled — PASS |
| 2 | Real event → mark | `herdr worktree create --cwd repo --branch wt-verify180 --path wt` emitted a real `worktree.created`; hook wrote `pending_triggers[0]` with `event:"worktree.created"`, `worktree_path`, `workspace_id`, the session `socket_path`, `received_at`, and the raw snake_case envelope (`data.type:"worktree_created"`) — PASS |
| 3 | Lazy drain | `scripts tick` reported `triggers:{fired:[{run_id, project_id:"repo", script:"bootstrap", result:"success"}], skipped:[], duplicates:0, pending_remaining:0}` — PASS |
| 4 | Run record | `scripts results` shows `trigger:{kind:"worktree.created", worktree_path:"/var/tmp/herdr-plugin-180/wt", event_received_at}` (the mark's `received_at`), `cwd` = the worktree checkout, script `source:"t3.json"` — PASS |
| 5 | Execution | Dedicated-pane run in session `verify180` workspace `w4` pane `w4:p1`; `scripts logs` shows `worktree-create-fired` + `pwd` → `/private/var/tmp/herdr-plugin-180/wt`, sentinel exit `0`, `result:"success"` — PASS |
| 6 | Consumption | `state.json` `pending_triggers` is `[]` after the drain — the mark was consumed under the state lock, not re-fired — PASS |

## Notes / honest limits

- The drain executed against the socket path recorded on the mark
  (`…/sessions/verify180/herdr.sock`) — the session that owns the
  worktree — matching the ADR-0022 addendum design; no session was
  restarted or attached.
- `runOnSettle`/`stopOnSettle` remain out of scope (#181 design / #182
  implementation); only `runOnWorktreeCreate` is wired here.
- Skip-path behavior (`repo_not_registered`, `ambiguous_project`,
  `worktree_gone`, `session_unreachable`, dedupe, cap accounting) is
  covered by `tests/projects-triggers.test.ts` against the fake
  herdr socket; the live run exercised only the happy path.
- Path canonicalization note: herdr reports worktree paths under
  `/var/tmp/…` while macOS resolves the repo root to
  `/private/var/tmp/…`; repo-group matching via `git-common-dir`
  handled the mismatch correctly.
