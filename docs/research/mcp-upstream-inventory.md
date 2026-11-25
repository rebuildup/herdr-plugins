# Research: T3Code MCP surface inventory and herdr-side feasibility (canonized)

Status: confirmed baseline for `mcp-outside-agents` (#30), ticket T1
(#135). Supersedes the working notes in the #30 investigation comment;
this document is the canonical inventory the contract and ADR cite.

Upstream pins:

- t3code `9cc4018c75` (local checkout `/Users/rebui/work/t3code`
  verified at this revision when this note was written).
- herdr installed 0.9.5 / API protocol 22 (`herdr api schema --json`);
  vendored source `/Users/rebui/work/herdr` @ `e8d7d97`.

## Upstream inventory: `apps/server/src/mcp/` (t3code)

### Server shape and auth

- `McpHttpServer.ts` — remote MCP over HTTP + OAuth.
  `McpSessionRegistry.ts` manages client sessions (pairing code 5 min /
  single-use; client approval lasts 30 days). Credentials are only sent
  to `https` or `localhost` targets (`linkOrigin.ts`).
- `McpToolAccess.ts` enforces per-client access levels. T3's
  `AuthMcpClientAccess` (`packages/contracts/src/auth.ts`) is
  `read-only` | `approval-required` | `auto-accept-edits` | `auto` |
  `full-access`; pairing-code prefixes are `READ` / `SUPERVISED` /
  `EDITS` / `AUTO` / (full). A `read-only` client's write call fails
  with a structured `OrchestratorMcpFailure{code: "capability_denied"}`
  before any mutation (`refuseReadOnlyClient`, McpToolAccess.ts:118).
  `mcpClientScopes` maps each level to orchestration read/operate and
  settings/source-control write scopes — "a thread it starts cannot run
  with more permissions than the mode" is enforced through
  `delegatedTaskModes.ts` + `threadAccess.ts` limits.
- Local path: `t3 thread` CLI exposes the same tool surface without
  sign-in on the host (`docs/user/outside-agents.md`, "Scripts on the
  host").

### Toolkits (`apps/server/src/mcp/toolkits/`)

15 toolkit directories: `orchestrator`, `thread`, `project`,
`worktree`, `message`, `attachment`, `html`, `preview`,
`previewControls`, `issues`, `pullRequests`, `environment`, `theme`,
`device`, `toolSearch` (lazy tool loading).

Notable orchestrator tools: `create_threads`, `delegate_task`,
`task_status`, `task_cancel`, `schedule_task`,
`list_scheduled_tasks`, `delete_scheduled_task`,
`orchestrator_capabilities`, `request_secret`, `t3_workflow_stop`.
Thread tools: `t3_thread_launch/send/wait/read/interrupt/organize/
transfer/search/list/configure/update`, `run_scheduled_task_now`.

Thread-scoped-only tools (subagents, secret requests, rendered HTML,
browser preview, devices, worktree handoff) appear in an outside
agent's tool list but fail with a "needs an agent running inside T3
Code" error when called — the honest-refusal pattern herdr-plugins.mcp
adopts as `unsupported`/`capability_denied`.

Events: no MCP-standard resource/subscription channel was confirmed;
`t3_thread_wait` blocking calls are the primary wait path (re-check in
T4 if push-style notifications are needed).

## herdr-side surface (installed 0.9.5, protocol 22)

- Socket API covers `agent.*` (list/get/read/prompt/wait/send_keys/
  start/rename/focus/explain), `pane.*`, `workspace.*`, `worktree.*`,
  `events.subscribe`/`events.wait`, `session.snapshot`, `plugin.*`.
  `packages/herdr-client` already provides the typed wrapper
  (`request`, `sessionSnapshot`, `resolveSocketPath`, `pluginDirs`).
- Plugin manifest supports `[[actions]]` (pane context), `[[events]]`
  (`pane.agent_status_changed`, `pane.closed`), `[[startup]]` only —
  no resident process or runtime action registration (ADR-0002; bounded
  `_wake` exception per ADR-0005).
- **herdr core has no MCP server, no inbound HTTP server, no tunnel,
  and no OAuth/pairing mechanism** (vendored src contains no MCP/HTTP
  server implementation). Remote reachability exists only as the
  saved-machine SSH bridge (`herdr --machine <id> <cli>` →
  `remote-api-bridge`, verified in ADR-0020), which serves
  API-backed CLI calls for the same user's SSH-reachable hosts — not a
  hosted-agent ingress like T3 Connect.
- `resolveSocketPath` precedence (packages/herdr-client):
  `HERDR_SOCKET_PATH` > `--session`/`HERDR_SESSION` > default session
  socket (`<config>/sessions/<name>/herdr.sock` or
  `<config>/herdr.sock`). Ambient pane env vars
  (`HERDR_PANE_ID`/`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`) identify a
  pane *inside* herdr but are meaningless to an external MCP client
  process unless it was spawned by that pane.

## Feasibility verdict (carried into ADR-0025)

- **Local stdio MCP server: feasible.** A new plugin
  (`rebuildup.mcp`) bundles `packages/herdr-client` (agent/pane/
  workspace/worktree/session ops) plus existing plugin CLIs
  (controls/conversations/git/projects/handoff/usage/textgen/
  checkpoints via the ADR-0013 env-pin spawn pattern) and exposes
  them as MCP tools/resources. Read vs mutation is enforceable via
  tool annotations + a server-side access level with structured
  `capability_denied`.
- **Remote HTTP + OAuth: upstream gap.** No inbound HTTP, no tunnel,
  no authorization/pairing surface exists in herdr. Building a custom
  public server would violate repo invariants (plugins must not
  reimplement execution/orchestration; no unverified exposure). Filed
  as a herdrdev/herdr upstream issue (see ADR-0025); v1 scope is local
  stdio only.
- **Event subscription: feasible with honest resync.**
  `events.subscribe`/`events.wait` can back MCP notifications or a
  polling tool; on socket loss the server must resync from
  `session.snapshot` and report gaps rather than fabricate continuity
  (T4, #140).

## Open design questions resolved by #135

- Session targeting for external agents → ADR-0025 (explicit
  `--session`/`--socket`/env; never ambient pane identity).
- Tool granularity → contract `herdr-plugins.mcp/v1` tool table
  (herdr primitives pass-through vs plugin-contract aggregation).
- CLI-spawn vs socket-direct → ADR-0025 (socket for herdr API,
  pinned CLI spawn for plugin contracts).
- MCP session-registry persistence → ADR-0025 (not needed in v1;
  per-client stdio process).
