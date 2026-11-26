# rebuildup.mcp

Outside-agent MCP surface for herdr (parent #30
`mcp-outside-agents`, release-0-7-0 — all surfaces stable).

A **local stdio MCP server** that exposes herdr sessions and sibling
plugin contracts to agents herdr did not start — terminal
Claude Code/Codex, IDE agents, bots. Boundary, access levels, session
resolution, and the remote/HTTP/OAuth upstream gap are fixed by
ADR-0025; the canonized upstream inventory is
`docs/research/mcp-upstream-inventory.md`.

## Status

**Contract `herdr-plugins.mcp/v1` is stable.** T1 (#135) fixed the
boundary (ADR-0025); T2 (#138) implemented the stdio server core and
read tools; T3 (#139) the mutation tools + access-level enforcement;
T4 (#140) the event surface (`events_subscribe`/`events_poll`/
`events_wait`/`events_unsubscribe` — in-process subscriptions over
herdr `events.subscribe` with pane/workspace/status filters,
auto-resubscribe, and structured `gap`/`resync` notices; see
`docs/contracts/mcp-v1.md` "Events").

## MCP client config

`serve` is a per-client stdio server — the MCP client spawns it:

```json
{
  "mcpServers": {
    "herdr": {
      "command": "bun",
      "args": [
        "run", "/path/to/herdr-plugins/plugins/mcp/src/cli.ts", "serve",
        "--session", "my-session",
        "--access-level", "read-only"
      ]
    }
  }
}
```

An external client has no ambient herdr env, so it must select the
target explicitly (`--session`/`--socket`, or `HERDR_SESSION`/
`HERDR_SOCKET_PATH` env). `herdr_capability.resolved_session` reports
what was resolved.

## Contract

`herdr-plugins.mcp/v1` — see `docs/contracts/mcp-v1.md`; internal
spec `docs/specs/mcp.md`.

Access levels (`--access-level`, default `read-only`):
`read-only` < `supervised` < `full`. Below-level calls fail with
structured `capability_denied` before dispatch.

Protocol: newline-delimited JSON-RPC 2.0 over stdio —
`initialize`/`ping`/`tools/list`/`tools/call`/`resources/*`.
stdout is protocol-only; diagnostics go to stderr; the process exits
on stdin EOF.

## Commands

```bash
bun run src/cli.ts capability [--session NAME] [--socket PATH] [--access-level L]
bun run src/cli.ts serve [--session NAME] [--socket PATH] [--access-level L]
bun run src/cli.ts help
```

`capability`/`help` emit one JSON document / text on stdout; `serve`
keeps stdout protocol-only.

## Session resolution

`--socket` > `--session`/`HERDR_SESSION` > `HERDR_SOCKET_PATH` >
default session socket. Pane env vars are ignored — an MCP client is
not a pane (ADR-0025 §4).

## Remote / HTTP / OAuth

Out of v1 scope: herdr has no inbound HTTP/tunnel/OAuth surface
(herdrdev/herdr#6199). No bespoke public server is built.

## Interactive TUI (#248)

The plugin ships a tab-placed pane entrypoint plus an `open` action
(`herdr-plugins.tui/v1`; ADR-0031/0032/0033):

```toml
# herdr-plugin.toml (already declared)
[[panes]] id = "main"  placement = "tab"  command = ["bun","run","src/tui.ts","main"]
[[actions]] id = "open" contexts = ["pane","workspace"]  command = ["bun","run","src/tui.ts","open"]
```

- **Diagnostics only.** The stdio MCP server is never screen-ified
  (ADR-0025/0033): no `serve`, no tool invocation, no mutations. The
  surface renders the `capability` document — contract/version,
  surfaces, session/socket resolution + reachability, access levels
  and the negotiated level, the declared tool table with per-level
  availability, per-plugin availability, error codes, and upstream
  gaps.
- `open` pins the origin context once and calls `plugin.pane.open`
  with `placement = "tab"`, forwarding the pins as `HERDR_TUI_*` env
  vars. `HERDR_PANE_ID` inside the UI is the UI pane's own surface
  identity — never a target. The diagnosed session is the one
  `capability` resolves from the inherited env
  (`HERDR_SOCKET_PATH`/`HERDR_SESSION`/flags), exactly like an MCP
  client config would.
- Every read goes through the plugin's own `capability` CLI
  subprocess, so the public contract stays the single source of truth
  and CLI/MCP/TUI cannot drift. Opening performs reads only; refresh
  is user-triggered (`r`). Absent/unreachable fields render their real
  error or `unknown`, never a fabricated state.
- Keys: `t` tool table (enter → per-tool detail incl. the
  read-only < supervised < full availability matrix), `p` plugin
  availability, `i` contract reference, `j` raw capability JSON,
  `/` filter inside lists, `?` help.
- Non-TTY stdin degrades to a plain-text capability summary; the
  non-interactive CLI is unchanged.

Opt-in keybind (user-owned; plugins never write herdr config):

```toml
[[keys.command]]
key = "prefix+M"
type = "plugin_action"
command = "rebuildup.mcp.open"
description = "open mcp diagnostics TUI"
```

## Runtime prerequisite

Bun (same as every plugin in this repo; see root README / AGENTS.md).
