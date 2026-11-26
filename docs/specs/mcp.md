# MCP plugin (`rebuildup.mcp`) — specification

Scope: local stdio MCP server exposing herdr sessions and sibling
plugin contracts to outside agents. Contract:
`herdr-plugins.mcp/v1` (**draft — read + mutation surfaces stable**;
`docs/contracts/mcp-v1.md`). Boundary ADR: ADR-0025. Upstream
inventory: `docs/research/mcp-upstream-inventory.md`. Decomposition of
#30: T1 boundary/contract (#135), T2 stdio core + read tools (#138),
T3 mutation tools + access enforcement (#139), T4 events + live
verification (#140).

## Purpose

Give agents that herdr did not start — a Claude Code/Codex session in
the user's own terminal, an IDE agent, a bot — a versioned,
access-controlled way to observe and operate herdr sessions and plugin
capabilities, without any plugin reimplementing PTY handling, agent
state, or orchestration. herdr remains the sole execution authority;
this plugin is a *protocol adapter*, not a second control plane.

## What it is / is not

- **Is**: a per-client stdio MCP server (JSON-RPC) that maps MCP
  `tools/list`/`tools/call` onto (a) `packages/herdr-client` socket
  calls for herdr primitives and (b) env-pinned sibling-plugin CLI
  spawns for plugin contract surfaces (ADR-0013 pattern).
- **Is not**: an MCP *client*, a daemon, a PTY owner, a state
  authority, or a remote server. No inbound HTTP/OAuth in v1
  (herdrdev/herdr#6199); no bespoke public endpoint ever.

## Access model

`--access-level read-only|supervised|full` at server start (default
`read-only`). Read tools run at every level; mutation tools require
`supervised`+ and are refused with structured `capability_denied`
below it (T3 `McpToolAccess` semantics). `supervised` mutations carry
the same identity echo and stale-generation guards as
`rebuildup.controls` — `expect_*` args are checked live before dispatch
AND forwarded to the controls `--expect-*` guards — and provider
permission mode is capped through the controls launch-args mechanism
(ADR-0018): `agent_start` pins `permission_mode: "supervised"` at the
`supervised` level (over-cap requests fail `capability_denied` before
any socket call) and passes the caller's choice through at `full`.
Every mutation result echoes `identity` plus an `effects` summary of
the herdr API / sibling CLI call that ran.

## Session resolution

Explicit target selection only: `--socket` > `--session`/`HERDR_SESSION`
> `HERDR_SOCKET_PATH` > default socket. Pane env vars are ignored.
Every result echoes resolved identity (host/session/workspace/pane/
`agent_session`/`state_change_seq`); stale targets are refused, never
applied to reused pane ids. See contract "Session resolution".

## Command surface (plugin CLI)

| Command | Mutating? | Notes |
| --- | --- | --- |
| `capability` | no | Contract/version/access-level/tool-table/plugin-availability discovery; works offline for the static parts, probes the session socket for liveness. |
| `serve` | no | Stdio MCP server (T2, #138): newline-delimited JSON-RPC `initialize`/`ping`/`tools/list`/`tools/call`/`resources/*`; stdout protocol-only, stderr diagnostics; exits on stdin EOF. |
| `help` | no | Usage text. |

## Honest-failure rules (inherited invariants)

- Unsupported/disconnected/uninstalled/stale is never reported as
  success: `plugin_unavailable`, `session_unreachable`,
  `not_found`, `stale_generation`, `unsupported`, `upstream_gap` are
  distinct structured codes (contract "Error model").
- No secrets in tool arguments, results, or logs (ADR-0014/0015/0018).
- Attention signals are never hidden: `blocked` agents surface as
  `requires_interactive_input`, matching controls.
- Event gaps are reported as `gap`/`resync`, never silently
  reconstructed (T4).

## Verification plan

- T1 (#135): contract/spec/ADR + `capability` output test;
  `validate:fast` green.
- T2 (#138): fake herdr socket + fake plugin CLI contract tests
  (`initialize`/`tools/list`/`tools/call`, access-level denial,
  stale-generation refusal, `plugin_unavailable`) in
  `tests/mcp-server.test.ts`; isolated-session live check of ≥1 read
  tool.
- T3 (#139): mutation gating tests (read-only denial, stale generation,
  reused pane id, permission-mode cap, `plugin_unavailable`, sibling
  error-kind mapping) in `tests/mcp-mutations.test.ts` over a stateful
  fake herdr socket + real `rebuildup.controls` / fake
  `rebuildup.handoff` CLIs; isolated-session live check of
  prompt→wait→read recorded for T4.
- T4: filter/reconnect/resync tests + live verification record in
  `docs/research/mcp-v1-live-verification.md`.
