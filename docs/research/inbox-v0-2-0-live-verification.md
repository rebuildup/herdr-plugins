# Live verification: `rebuildup.inbox` v0.2.0 (Issue #176)

Date: 2026-11-26. Scope: pin / unpin / archive / unarchive / order /
restore / reconcile / capability on real herdr 0.9.5.

## Environment

| Env | Host | Session | Isolation |
| --- | --- | --- | --- |
| macOS | local (arm64) | `verify176` | dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HERDR_CONFIG_PATH` under `/var/tmp/herdr-plugin-176`, headless `herdr --session verify176 server` (real binary `~/.local/share/mise/installs/herdr/0.9.5/herdr`), all ambient `HERDR_*` unset for server/CLI calls |

The user's live session was never touched. Plugin CLI was invoked with
`HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` under the isolated XDG
roots and `--socket` pointing at the isolated session socket
(`…/sessions/verify176/herdr.sock`).

## Setup

- `herdr --session verify176 server` (headless), then
  `herdr --session verify176 workspace create` ×2 → panes `w1:p1`, `w2:p1`
  (plain shells, `agent_status: unknown`, no agent session — the
  non-agent-pane path; agent/attention paths are covered by the
  fake-socket contract tests in `tests/inbox-contract.test.ts`).

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | `capability` | PASS — version 0.2.0, commands include pin/unpin/archive/unarchive/order, contract `herdr-plugins.inbox/v1` |
| 2 | `list` baseline | PASS — 2 items, `in_inbox: true`, counts include `pinned`/`archived` |
| 3 | `pin w2:p1` | PASS — `pinned: true`, item sorts first, `counts.pinned: 1`, `in_inbox` unchanged |
| 4 | `archive w1:p1` | PASS — `organize.kind: "archived"`, `in_inbox: false`, `counts.archived: 1`; **`herdr pane list` immediately after still shows `w1:p1` alive** — archive never touches execution state |
| 5 | `unarchive w1:p1` | PASS — `organize: null`, pane back in inbox |
| 6 | `order w1:p1 --first` | PASS — `order: 0` rank persisted; state file shows `order` field only |
| 7 | `order w1:p1 --after w2:p1` | PASS (rejection) — exit 2, `reference pane is not in the same inbox group` (w2:p1 was pinned → different display group) |
| 8 | `unpin w2:p1` | PASS — `pinned: false`, entry dropped from state file |
| 9 | `reconcile` | PASS — `cleared`/`pruned`/`projected` empty (only an `order` rank remained; order carries no metadata token) |
| 10 | State file | PASS — schema v2, session-namespaced (`hostname + canonical socket path`), only surviving fields persisted |

## Notes

- Contract-level invariants not exercisable without a live agent
  (attention override, generation-advance clearing, agent_session
  fingerprinting) are fixed by unit tests (`tests/inbox-model.test.ts`)
  and the fake-socket contract test (`tests/inbox-contract.test.ts`),
  which also asserts organize commands emit only `session.snapshot` and
  `pane.report_metadata` socket methods.
- `bun run validate:fast` green (typecheck + lint + 711 tests).

## Cleanup

Isolated session `verify176` deleted, server process stopped,
`/var/tmp/herdr-plugin-176` removed. Live session untouched.
