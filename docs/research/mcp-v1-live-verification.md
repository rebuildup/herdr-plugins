# Live verification — `rebuildup.mcp` v0.7.0 (#140 / parent #30 T4)

End-to-end smoke of `herdr-plugins.mcp/v1` (contract **stable**) against a
**real herdr 0.9.5** isolated named session — complementing the
fake-socket contract tests (`tests/mcp-*.test.ts`, 43 tests). Scope per
#140: `events_subscribe` / `events_poll` / `events_wait` /
`events_unsubscribe` over the real `events.subscribe` stream, filters,
live agent status transitions, and a real socket-drop reconnect with
gap + resync reporting.

- Plugin: `plugins/mcp` @ branch `140` (post-T3 `release-0-7-0`)
- herdr: `0.9.5` (protocol 22, isolated named session `mcp140`,
  headless `herdr server`)
- Bun: `1.4.4`; platform: macOS (arm64)
- Agent provider: codex (via `agent_start`, permission mode capped to
  `supervised` → `--ask-for-approval on-request --sandbox read-only`)

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `mcp140` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME` (`/var/tmp/herdr-plugin-140`) — the user's live sessions were never targeted; every call ran under `env -i` with only the isolated vars and `HERDR_SESSION=mcp140` |
| plugin state | `HERDR_PLUGIN_CONFIG_DIR`/`HERDR_PLUGIN_STATE_DIR` under `/var/tmp/herdr-plugin-140` |
| MCP transport | newline-delimited JSON-RPC over stdio (`cli.ts serve --socket <sock>`), driven by `/var/tmp/herdr-plugin-140/drive*.ts` |
| mutation tools | backed by real `rebuildup.controls` sibling plugin CLI (`resolved_via: sibling`) |

The isolated session was stopped afterwards; evidence retained at
`/var/tmp/herdr-plugin-140` (`verify*.log`, `drive*.ts`, `env.sh`-style
env blocks inline in the drivers).

## Subscription verdict (contract-stabilizing decision)

MCP server→client **notifications are not a viable subscription
channel** for this plugin: `rebuildup.mcp` is spawned per client over
stdio, so there is no durable server-side registry an upstream event
stream could anchor push delivery to, and notification support is not
uniform across MCP clients. The contract therefore ships the sanctioned
**tool-polling alternative**: four read-level tools
(`events_subscribe`, `events_poll`, `events_wait`, `events_unsubscribe`)
backed by herdr `events.subscribe` + `session.snapshot`. This is
documented in `docs/contracts/mcp-v1.md` (Events section) and
`docs/specs/mcp.md`; contract v1 is declared **stable** on this basis.

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | `herdr_capability` | `contract_status: stable`, `version: 0.7.0`, surfaces read/mutation/events all `stable` — PASS |
| 2 | `events_subscribe` (agent_status_changed, all panes) | `status: live`, pane expansion `[w1:p1]`, upstream_subscriptions 1, `session.snapshot` baseline embedded with `note` that gap events are not reconstructable — PASS |
| 3 | `events_subscribe` lifecycle (`workspace.created`, `pane.created`, `pane.closed`) | `status: live`, 3 upstream subscriptions, empty pane set (non-pane-parameterized types) — PASS |
| 4 | `events_wait` with no matching events | `{timed_out: true, events: 0, notices: 0}` after bounded wait — PASS |
| 5 | `workspace_create` (supervised) | `w2` + `w2:t1` + root pane `w2:p1` created; `effects` echo `workspace.create` — PASS |
| 6 | Lifecycle delivery | S2 poll returned `workspace.created` (seq 1) and `pane.created` (seq 2) with full payloads — PASS |
| 7 | Filtered subscribe (`pane_id=w2:p1`, `agent_status=working`) | `filters` echoed, pane expansion `[w2:p1]`; poll delivered exactly one `pane.agent_status_changed` (`agent: codex`, `agent_status: working`) — PASS |
| 8 | `agent_start` codex + `agent_prompt --wait` | launch argv permission-capped (`permission_mode_capped: true`); prompt returned without error — PASS |
| 9 | `events_wait` positive path | returned promptly (`timed_out: false`) with a real `pane.agent_status_changed` (`done`) event, `next_cursor` advanced — PASS |
| 10 | Unfiltered + `agent=codex` filtered subscriptions during a prompt turn | poll captured the full `done → working → done` transition sequence (seq 1–3) on both subscriptions; `agent=codex` filter applied client-side — PASS |
| 11 | **Reconnect / gap+resync** | `herdr server stop` mid-subscription → poll reported notices `gap/stream_closed`, `gap/socket_unreachable` (×2 retry attempts with `connect ENOENT` detail), then `resync/reconnect` carrying a **fresh `session.snapshot` baseline** (2 panes) and `reconnects: 1`; buffered pre-drop events retained with original seqs — PASS |
| 12 | `events_subscribe` under `--access-level read-only` | subscription tools are read-level; live subscribe/poll/unsubscribe succeeded on a read-only server (supervised-only mutations unaffected) — PASS |
| 13 | `workspace.closed` delivery | read-only lifecycle subscription received `workspace.closed` for `w2` after `herdr workspace close w2` via CLI — PASS. `pane.closed` was subscribed in the same stream; upstream emitted only the workspace-level close for this path (pane-level close events are covered by `tests/mcp-events.test.ts` contract tests) |
| 14 | `events_unsubscribe` | `closed: true` with `discarded_items` counts matching buffered backlog — PASS |

## Contract observations recorded

1. **Pane-set resolution is subscribe-time.** A `pane.agent_status_changed`
   subscription created before a workspace/pane exists does not retro-
   actively cover it (upstream re-resolves the pane set on reconnect,
   not on topology change). Observed live: S1 subscribed with only
   `w1:p1` never saw `w2:p1` agent events; a fresh subscribe after
   `workspace_create` covered both panes. Documented in the contract's
   pane-expansion section.
2. **Agent status vocabulary on the wire** includes `done` (in
   addition to `idle`/`working`/`blocked`/`unknown`) for completed
   turns — matches `AGENT_STATUSES` in the contract.
3. **`events_lost` upstream frame** is handled via the new
   `Subscription.terminalError` in `packages/herdr-client` (records the
   post-ack error frame before the stream ends); covered by fake-socket
   tests — the live run exercised `stream_closed`/`socket_unreachable`
   instead because the whole server was stopped.
4. **Reconnect is automatic and bounded**: capped backoff
   (500 ms → 5 s), gap notices bracket every disconnect, resync always
   carries a fresh snapshot baseline — never reported as "no events".

## T3 carry-over (#139, PR #157)

Mutation-surface live evidence (prompt→wait→read on real providers,
permission-mode cap, stale-generation refusal) was recorded by T3 in
the same isolated-session pattern; the `agent_prompt(wait)` /
`agent_start` checks above re-confirm the seam T4 depends on.
