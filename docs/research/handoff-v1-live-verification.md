# Live verification — `rebuildup.handoff` v0.6.0 (#106 / parent #6 T4)

End-to-end smoke of `herdr-plugins.handoff/v1` T4 scope — delegation
lineage (`delegate` / `merge-back` / `relationship`), `handoff_record`
payload refs, and `execute --worktree` — against **real herdr 0.9.5**
in an isolated named session, complementing the fake-transport
contract tests (`tests/handoff-lineage.test.ts`, 16 tests).

- Plugin: `plugins/handoff` @ branch `106` (post-T3 `release-0-6-0`)
- herdr: `0.9.5` (protocol 22, isolated named session `verify106`,
  headless `herdr server`)
- Bun: `1.4.4`; platform: macOS (arm64)
- Provider: real `codex 0.171.0` (direct mise-install symlink on a
  clean `PATH`; real `~/.codex` credentials via real `HOME`)

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `verify106` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`HERDR_CONFIG_PATH` (`/var/tmp/herdr-plugin-106`) — the user's live sessions were never targeted; every CLI call ran with ambient `HERDR_*` socket/workspace vars unset and `HERDR_SESSION=verify106` |
| plugin state | `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` under `/var/tmp/herdr-plugin-106` |
| providers | Real `codex` binary via direct symlink (no shims) |
| panes | `w1:p1` (codex "parent-agent", cwd `$HOME`), `w6:p1`/`w7:p1` (plain shells in repo checkouts) |

The isolated session was stopped and deleted afterwards
(`herdr session stop/delete verify106`); the two git worktrees +
branches the verification created in the real repo
(`verify106/wt-handoff`, `verify106/wt-handoff2` under
`~/.herdr/worktrees/herdr-plugin/`) were removed with
`git worktree remove` + `branch -D`. Evidence retained at
`/var/tmp/herdr-plugin-106` (server log, `env.sh` recipe).

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | `capability` | `herdr-plugins.handoff/v1` v0.6.0; commands include `delegate`/`merge-back`; `lineage` block lists the five T3 kinds + same-session scope; `target_selection` includes `--worktree`; `agent_api` includes `worktree.create` — PASS |
| 2 | `execute --new-workspace` (baseline) | record `ho-mwwezq3e` → `delivered`; new workspace `w4`, agent `handoff-ho-mwwezq3e-8d93d293` (codex) started, payload prompt injected (`agent.prompt`, 469 chars) — PASS |
| 3 | `delegate <parent>` | child `ho-mwwf17r7` created with `relationship{subagent_spawn, parent_id: ho-mwwezq3e}`; transfer identity resolved live to the parent's EXECUTED target pane `w4:p1` (not the stale source `w1:p1`); normal execute pipeline ran → new workspace `w5`, agent started, `delivered` — PASS |
| 4 | `merge-back <child>` | result `ho-mwwf2pwy` with `relationship{subagent_result, parent_id: ho-mwwf17r7}`; transfer identity = child's pane `w5:p1`; delivered via `agent.prompt` to the DELEGATING agent's existing pane `w4:p1` (`execution.target.created:false`, `agent.start` never called — the running codex on w4 received the result prompt) — PASS |
| 5 | `status`/`list` lineage | parent `status` returns `lineage{relationship:null, children:[ho-mwwf17r7 done]}`; child shows `child_count:1` (the result record); result record shows its `subagent_result` relationship — children derived by scan, never stored — PASS |
| 6 | `execute --worktree` | record `ho-mwwfnnpc` → `delivered`; herdr `worktree.create` produced workspace `w9` backed by git worktree `/Users/rebui/.herdr/worktrees/herdr-plugin/verify106-wt-handoff2` (branch `verify106/wt-handoff2`); `execution.worktree{path,branch,is_linked_worktree:true,workspace_id}` recorded verbatim; agent + prompt on the worktree root pane — PASS |
| 7 | worktree from a linked worktree | `execute --worktree` with source cwd inside a linked worktree failed honestly at step `surface`: `linked_worktree_source: New and open worktree actions start from the repo parent workspace` — upstream constraint surfaced, record `failed`, nothing half-applied — PASS (honest refusal) |
| 8 | refusals | `delegate --remote` → usage error (same-session only); `merge-back` on a parentless record → `no_parent`; `create --parent` unknown id → `handoff_not_found`; `--relationship` without `--parent` → usage — PASS |

## Upstream observations recorded

1. **`agent.start` name constraint is real.** The plugin previously
   named agents `handoff <id>` (space) — herdr rejects names outside
   `[a-z][a-z0-9_-]{0,31}`. Fixed in this ticket to `handoff-<id>`
   (≤ 32 chars given the `ho-<base36>-<hex>` id shape). The T3 remote
   verification doc had flagged the constraint; T2's fake-transport
   tests never exercised real `agent.start` name validation.
2. **`agent.prompt` registry race after `agent.start`.** Immediately
   after a successful `agent.start` (interactive readiness returned),
   `agent.prompt` could fail `agent_not_ready: agent w9:p1 is not an
   active named agent`; ~40 s later the identical call succeeded. The
   plugin now retries this specific transient error for up to ~5 s
   before failing at step `prompt`; all other prompt errors still fail
   honestly. Candidate upstream issue: `agent.start` readiness should
   imply prompt-ability (or document the lag).
3. **`agent_blocked` is honest.** Codex's folder-trust dialog in a
   brand-new worktree path blocked the first `--worktree` run at step
   `prompt` (`agent_blocked`, record `failed`, `execution.worktree`
   still recorded). Trust applied to the repo root made the retry
   pass — provider behavior, correctly surfaced by the plugin.
4. **`worktree.create` requires the repo PARENT workspace as source**
   (`linked_worktree_source` error from a linked-worktree cwd). The
   plugin records `transfer.cwd` verbatim; callers must hand off from
   the main checkout — documented behavior, not a plugin bug.

## Verdict

`herdr-plugins.handoff/v1` T4 verified end-to-end on real herdr 0.9.5
with a real codex agent in an isolated named session: `delegate`
(spawn child + execute), `merge-back` (result via `agent.prompt` to
the parent's existing pane — no second `agent.start`), derived
`status`/`list` lineage views, `handoff_record` payload refs, and
`execute --worktree` (`worktree.create` target with
`execution.worktree` echo) all behave per contract. Contract v1
stable at plugin v0.6.0; #30/#32 boundaries fixed by ADR-0021.
