# rebuildup.mcp

Outside-agent MCP surface for herdr (issue #135; parent #30
`mcp-outside-agents`, release-0-7-0 T1).

A **local stdio MCP server** that exposes herdr sessions and sibling
plugin contracts to agents herdr did not start — terminal
Claude Code/Codex, IDE agents, bots. Boundary, access levels, session
resolution, and the remote/HTTP/OAuth upstream gap are fixed by
ADR-0022; the canonized upstream inventory is
`docs/research/mcp-upstream-inventory.md`.

## Status

T1 ships the contract skeleton (`herdr-plugins.mcp/v1`, **draft**),
`capability` discovery, and honest `serve` → `not_implemented`.
The stdio server core + read tools land in T2 (#138), mutations in
T3 (#139), events in T4 (#140).

## Contract

`herdr-plugins.mcp/v1` (draft) — see `docs/contracts/mcp-v1.md`;
internal spec `docs/specs/mcp.md`.

Access levels (`--access-level`, default `read-only`):
`read-only` < `supervised` < `full`. Mutations below their required
level fail with structured `capability_denied`.

## Commands

```bash
bun run src/cli.ts capability [--session NAME] [--socket PATH] [--access-level L]
bun run src/cli.ts serve [--session NAME] [--socket PATH] [--access-level L]
bun run src/cli.ts help
```

All commands emit one JSON document on stdout; errors go to stderr
(exit 1 handled, 2 usage).

## Session resolution

`--socket` > `--session`/`HERDR_SESSION` > `HERDR_SOCKET_PATH` >
default session socket. Pane env vars are ignored — an MCP client is
not a pane (ADR-0022 §4).

## Remote / HTTP / OAuth

Out of v1 scope: herdr has no inbound HTTP/tunnel/OAuth surface
(herdrdev/herdr#6199). No bespoke public server is built.

## Runtime prerequisite

Bun (same as every plugin in this repo; see root README / AGENTS.md).
