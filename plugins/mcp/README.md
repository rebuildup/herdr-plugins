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

## Runtime prerequisite

Bun (same as every plugin in this repo; see root README / AGENTS.md).
