# ADR-0022: MCP outside-agent boundary — local stdio only, access levels, session resolution

Status: Accepted (release-0-7-0 candidate, Issue #135 / parent #30 T1 —
first ticket of the #30 `mcp-outside-agents` decomposition)

## Context

#30 asks for an MCP surface so agents herdr did *not* start (terminal
Claude Code/Codex, ChatGPT, hosted bots) can read and operate herdr
sessions and plugin contracts — the T3Code `apps/server/src/mcp/`
equivalent. The canonized upstream inventory
(`docs/research/mcp-upstream-inventory.md`, t3code `9cc4018c`,
herdr 0.9.5 / protocol 22) establishes:

- T3 exposes MCP two ways: remote `McpHttpServer` (HTTP + OAuth +
  pairing, per-client access levels enforced in `McpToolAccess` with
  structured `capability_denied`) and the local `t3 thread` CLI over
  the same tool surface.
- herdr has the local socket API (`agent.*`, `pane.*`, `workspace.*`,
  `worktree.*`, `events.*`, `session.snapshot`, `plugin.*`) and
  `packages/herdr-client` already wraps it, but **no MCP server, no
  inbound HTTP, no tunnel, no OAuth/pairing**.
- The saved-machine SSH bridge (`herdr --machine`) is an API-backed CLI
  forwarder for the same user's reachable hosts — not a credentialed
  ingress for third-party clients.

T1 must fix the plugin boundary, the access-level model, the v1 tool
surface shape, session resolution for external clients, and record the
remote gap before T2 (#138 server core) and T3 (#139 mutations) build on
it.

## Decision

1. **`rebuildup.mcp` is a plugin that *serves* MCP; it owns no
   execution authority.** It is a local **stdio** MCP server (JSON-RPC
   over stdin/stdout, spawned per MCP client — the same deployment
   shape as `t3 thread`). It exposes herdr/plugin capabilities as MCP
   tools/resources; every mutation still flows through herdr's own API
   (`agent.*`/`workspace.*`/`worktree.*` via `packages/herdr-client`)
   or through another plugin's versioned CLI contract. The plugin
   never owns a PTY, never parses PTY text into state, never
   reimplements orchestration — the root invariants apply unchanged.
   Remote HTTP + OAuth is **out of v1 scope**: it is an upstream gap,
   filed as herdrdev/herdr#6199; no bespoke public server is built
   (that would violate the "no unverified exposure / no reimplemented
   authority" invariants).

2. **Access levels are a server-side contract, T3-aligned.** v1 defines
   three levels selected at server start (`--access-level`, default
   `read-only`):

   | Level | Read tools | Mutation tools | Notes |
   | --- | --- | --- | --- |
   | `read-only` | yes | refused `capability_denied` | observe session/projects/conversations/git |
   | `supervised` | yes | yes, identity-echoed + stale-guarded | mutations may not exceed the caller's declared level; provider permission mode capped via controls launch args (ADR-0018) |
   | `full` | yes | yes, including environment-level operations | no additional restriction beyond herdr's own |

   This is a deliberate simplification of T3's five-value
   `AuthMcpClientAccess` (`read-only`/`approval-required`/
   `auto-accept-edits`/`auto`/`full-access`): T3's middle gradations
   are *approval UX* on a hosted server; a local stdio server has a
   single human operator who picks the level at spawn time, so three
   levels suffice. Mapping for future interop: `read-only`→`read-only`;
   `supervised`→`approval-required`..`auto` band; `full`→`full-access`.
   A mutation tool invoked below its required level returns a
   structured `capability_denied` error (T3 `McpToolAccess`
   semantics), never a silent no-op or fabricated success.

3. **Tool implementation path is split by authority boundary.**
   - *herdr execution surface* (agent/pane/workspace/worktree/session
     snapshot, events): `packages/herdr-client` socket calls directly.
     These are herdr primitives; wrapping them in a CLI spawn would add
     a hop without adding safety.
   - *plugin contract surfaces* (controls send/wait/interrupt/launch,
     conversations history/search, git status/files/log, projects,
     handoff invoke, usage, checkpoints, textgen): spawn the sibling
     plugin's `src/cli.ts` with `bun run`, resolving the plugin root by
     override → sibling `plugins/<name>` → `herdr plugin list --json`,
     and pinning `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` to
     the *target* plugin's dirs — the ADR-0013 env-pin pattern. MCP
     never reaches into another plugin's state files.
   - Tool granularity follows the contract, not the wire: one MCP tool
     per meaningful contract operation (e.g. `controls_send` wraps
     `controls send`), not one tool per herdr RPC method. Raw
     `agent.*` pass-through tools are limited to what no plugin
     contract covers (snapshot/listing primitives).

4. **Session resolution is explicit; ambient pane identity is never
   trusted.** The server resolves its target session at startup with
   the same precedence as `resolveSocketPath` — explicit `--socket
   PATH` > `--session NAME` (or `HERDR_SESSION`) > `HERDR_SOCKET_PATH`
   env > default session socket — **except** that pane-scoped env vars
   (`HERDR_PANE_ID`/`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`) are ignored
   entirely: they describe a pane *inside* herdr and mean nothing to an
   MCP client process. An MCP client spawned inside a herdr pane that
   inherits `HERDR_SOCKET_PATH` legitimately targets that pane's
   session (this is the desired behavior for in-pane agents); an
   external client must pass `--session`/`--socket` or set the env.
   Every tool result echoes the resolved identity — Host /
   Session / Workspace / Pane (where applicable) + `agent_session` +
   `state_change_seq` generation — and stale targets are refused with
   `stale_generation`/`not_found`, never applied to a reused pane id
   (root invariant). `herdr --machine` saved-machine targeting is
   deferred: remote sessions are part of the same upstream gap as HTTP
   reachability (the bridge exists for CLI use; exposing it through MCP
   is a post-v1 decision recorded in the contract's `session` section).

5. **No durable MCP session state in v1.** MCP stdio servers are
   per-client processes: each client spawns its own server, so there
   is no cross-process session registry to persist. In-memory state
   (resolved session, negotiated protocol version, capability cache)
   lives for the process lifetime only. Plugin state
   (`HERDR_PLUGIN_STATE_DIR`) is used only if a later ticket needs
   durable MCP-side state, under the same single-writer-lock +
   atomic-rename discipline; v1 writes nothing.

6. **Contract `herdr-plugins.mcp/v1` starts as draft.** T1 ships the
   skeleton (access levels, tool table with read-only annotations,
   error model, session rules); T2 (#138) stabilizes the read surface,
   T3 (#139) the mutation surface, T4 (#140) the event surface. The
   contract file records `status: draft` until T2 lands; stability is
   declared per-surface as tickets complete, matching how
   `handoff-v1.md` recorded T1–T4 scope.

## Consequences

- `docs/contracts/mcp-v1.md` + `docs/specs/mcp.md` are the binding
  skeleton; `plugins/mcp` ships only `capability`/`help` in T1 — the
  stdio server entrypoint (`serve`) lands in T2 (#138).
- Any client that can spawn a process on the host (terminal agents,
  IDE integrations, `herdr plugin`-aware tooling) can use the full
  surface today; hosted/cloud agents remain blocked on
  herdrdev/herdr#6199.
- Access-level enforcement is entirely plugin-side in v1 (herdr has no
  per-client grant concept). This is honest for a local single-operator
  tool but must be revisited if/when upstream #6199 lands — the
  contract's level names are chosen to map onto T3's model.
- Sibling plugins' failure modes propagate structurally: an
  uninstalled/unreachable dependency plugin surfaces as
  `plugin_unavailable` in `capability` and per-tool errors, never as
  fabricated results.
