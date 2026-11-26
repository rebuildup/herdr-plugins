# Contract: `herdr-plugins.mcp/v1` (draft — read + mutation surfaces stable)

Versioned structured interface for the `rebuildup.mcp` plugin — a
**local stdio MCP server** that exposes herdr sessions and sibling
plugin contracts to outside MCP clients (agents herdr did not start).
Boundary, access levels, session resolution, and the remote/HTTP/OAuth
upstream gap are fixed by ADR-0025; the upstream inventory is canonized
in `docs/research/mcp-upstream-inventory.md`.

**Status: draft overall; the read surface is stable as of T2 (#138) and
the mutation surface as of T3 (#139).** The event surface lands in T4
(#140). `capability` (CLI and `herdr_capability` tool) reports
`contract_status` plus a per-surface `surfaces` map and per-tool
`status` so clients can detect what is implemented.

## Transport and lifecycle

- MCP over **stdio** (JSON-RPC 2.0, newline-delimited): `initialize`,
  `ping`, `tools/list`, `tools/call`, `resources/list` (empty),
  `resources/read` (not found), `notifications/*` (ignored). The
  `initialize` handshake negotiates the protocol version from
  `2024-10-07`, `2024-11-05`, `2025-03-26`, `2025-06-18` (newest
  preferred; an unsupported request falls back to the newest
  supported). stdout is protocol-only; diagnostics go to stderr.
- One server process per MCP client (spawned by the client config,
  e.g. `bun run <plugin_root>/src/cli.ts serve --access-level
  read-only --session <name>`). No daemon, no resident process
  (ADR-0002). The process exits when the client's stdin closes.
- `tools/call` results carry `structuredContent` (the structured
  document) plus a `content[0].text` JSON rendering. Tool-level
  failures (contract error codes) return an `isError: true` result
  whose `structuredContent`/`text` is
  `{contract, ok:false, error:{code,message,details?}}`; protocol-level
  failures (bad JSON, unknown method, missing `params.name`) return
  standard JSON-RPC errors (-32700/-32600/-32601/-32602).
- Remote HTTP + OAuth/pairing is **out of v1 scope** — upstream gap
  herdrdev/herdr#6199. No custom public server exists or will exist in
  this plugin.

## Access levels

Selected at server start (`--access-level`, default `read-only`).
Enforced server-side before dispatch; a tool called below its required
level fails with `error.code = "capability_denied"` (T3 `McpToolAccess`
semantics) and changes nothing.

| Level | Read tools | Mutation tools |
| --- | --- | --- |
| `read-only` | allowed | `capability_denied` |
| `supervised` | allowed | allowed; every mutation echoes full identity and honors stale-generation guards; provider permission mode is capped via controls launch args |
| `full` | allowed | allowed without additional plugin-side restriction |

`capability` (the MCP `tools/call` discovery tool and the CLI
`capability` command) always reports the negotiated `access_level`.

## Identity echo (invariant)

Every tool result that touches a herdr object carries an `identity`
block: `host`, `session` (name/key), `workspace_id`, `tab_id`,
`pane_id` where applicable, `agent` kind, `agent_session` ref, and
`state_change_seq` generation — resolved live from `session.snapshot`/
`agent.get`, never from caller-supplied stale ids alone. Mutations
additionally accept optional expectation guards (`expect_pane`,
`expect_state_seq`, `expect_agent_session`, mirroring controls
`--expect-*`) and refuse mismatches with `stale_generation`. A stale
identity is **never** applied to a different agent generation or a
reused pane id.

## Session resolution

The server resolves its target session once at startup:

1. `--socket PATH` (explicit socket path), else
2. `--session NAME` or `HERDR_SESSION` (named session socket under the
   herdr config dir), else
3. `HERDR_SOCKET_PATH` env (e.g. inherited inside a herdr pane — valid
   and desirable there), else
4. the default session socket.

Pane-scoped env (`HERDR_PANE_ID`/`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`)
is ignored — it identifies a pane *inside* herdr and is meaningless to
the MCP client process. `capability` reports the resolved
`session{socket, name?, key}` so the client can verify the target.
Saved-machine (`herdr --machine`) targeting is deferred post-v1.

**External clients (the #30 use case):** an MCP client running outside
herdr has no ambient `HERDR_*` env, so it must select the target
explicitly in its server config — `--session <name>` (or
`HERDR_SESSION=<name>` env) for a named session, `--socket <path>`
(or `HERDR_SOCKET_PATH`) for an explicit socket. There is no
session-discovery channel in v1; `herdr_capability.resolved_session`
reports what was actually resolved so the client can verify it.
Per-plugin root overrides for tests/managed installs:
`HERDR_MCP_ROOT_<NAME>` (e.g. `HERDR_MCP_ROOT_GIT`).

## Tool surface (v1)

Each entry: MCP tool name · required access level · read-only
annotation (`readOnlyHint`) · backing implementation · status.
Names are snake_case per MCP convention; `t3_*`-style prefixes are not
used — the server IS the herdr surface. **Implemented (stable):** all
tools in the Capability/discovery, Plugin contract reads, and Mutations
tables below (reads T2 #138, mutations T3 #139). Planned tools remain
listed by `tools/list` and fail honestly with `unsupported` (or
`capability_denied` below their access floor) until T4.

Tool results are wrapped as
`{contract, ok:true, tool, result}` in `structuredContent`; plugin-CLI
backed tools nest the sibling contract document under `result` and
report `plugin`/`plugin_contract`/`resolved_via`. Results touching
herdr objects carry the `identity` block (contract "Identity echo");
`agent_get`/`agent_read` accept optional `expect_state_seq`,
`expect_agent_session`, `expect_pane` arguments that refuse mismatches
with `stale_generation`.

### Capability / discovery

| Tool | Level | Read-only | Backs onto |
| --- | --- | --- | --- |
| `herdr_capability` | read-only | yes | contract version, access level, resolved session, tool list, per-plugin availability (`plugin_unavailable` honest reporting) |
| `session_snapshot` | read-only | yes | `session.snapshot` via herdr-client |
| `agent_list` / `agent_get` | read-only | yes | `agent.list`/`agent.get` |
| `agent_read` | read-only | yes | `agent.read` (scrollback; structured history is `conversations_*`) |
| `workspace_list` / `pane_list` | read-only | yes | `workspace.*`/`pane.*` snapshot surfaces |

### Plugin contract reads

| Tool | Level | Read-only | Backs onto |
| --- | --- | --- | --- |
| `conversations_search` / `conversations_show` | read-only | yes | `rebuildup.conversations` CLI (`history`/`search`/`show`), env-pinned spawn |
| `git_status` / `git_files` / `git_log` | read-only | yes | `rebuildup.git` CLI read ops, env-pinned spawn |
| `projects_list` | read-only | yes | `rebuildup.projects` CLI |
| `usage_report` | read-only | yes | `rebuildup.usage` CLI |

### Mutations (implemented, T3 #139)

All mutation tools are gated server-side by the access level before
dispatch (`capability_denied` below the floor, changing nothing) and
share the mutation result shape: the sibling plugin's contract
document (or the direct herdr result) under `result`, the contract
`identity` block, and an `effects` array recording the exact herdr API
method / sibling CLI command that ran — the summary never replaces
herdr as the authority. Agent-target mutations accept the same
`expect_pane`/`expect_state_seq`/`expect_agent_session` arguments as
the read tools and forward them to `rebuildup.controls` `--expect-*`
guards, so the generation check runs again at mutation time.

| Tool | Level | Read-only | Backs onto |
| --- | --- | --- | --- |
| `agent_prompt` | supervised | no | `rebuildup.controls` `send` (identity echo + `--expect-*` guards; `blocked` → `upstream_gap` with `details.plugin_kind: "requires_interactive_input"`) |
| `agent_wait` | read-only | yes (blocking observation, no mutation) | `rebuildup.controls` `wait` |
| `agent_interrupt` | supervised | no | `rebuildup.controls` `interrupt` — PTY-level `send_keys`, documented as such in the tool description |
| `agent_start` | supervised | no | `rebuildup.controls` `start`; provider `permission_mode` is capped by the access level (below) |
| `workspace_create` | supervised | no | herdr `workspace.create` (herdr-client) |
| `handoff_invoke` | supervised | no | `rebuildup.handoff` `execute`/`delegate`/`merge-back` CLI (ADR-0021 boundaries apply; `--remote` is not exposed in v1) |

`agent_prompt` args: `target`, `text` (must not start with `--` — the
controls CLI would parse it as a flag), optional `wait`,
`wait_until[]`, `timeout_ms`.

`agent_wait` args: `target`, optional `until[]`, `timeout_ms`.

`agent_interrupt` args: `target`, optional `keys[]` (default `["esc"]`).

`agent_start` args: `pane_id` (must exist in the live snapshot),
`agent` (provider kind), optional `name`, `model`, `reasoning`,
`permission_mode`, `resume` | `resume_from` (mutually exclusive),
`extra_args[]` (provider passthrough — the controls privilege
denylist applies; there is no `--unsafe-args` equivalent), `timeout_ms`,
`wait`, `wait_until[]`, `wait_timeout_ms`, `expect_*`.

`workspace_create` args: optional `cwd`, `label`, `focus`. No `env`
passthrough in v1 — tool arguments must never carry secrets.

`handoff_invoke` args: `operation` (`execute`|`delegate`|`merge-back`),
`id`, plus a per-operation allowlist of the handoff CLI flags
(`target_pane`, `target_workspace`, `new_workspace`, `worktree`,
`worktree_branch`, `worktree_base`, `provider`, `model`, `strategy`,
`task`, `note`, `requirement[]`, `conversation[]`, `checkpoint[]`,
`external[]`, `handoff[]`, `link_note`, `wait_ms`,
`cleanup_on_failure`, `no_execute`, `dry_run`). Arguments outside the
operation's surface are refused `invalid_params`, never silently
dropped.

**Permission-mode cap (`agent_start`).** The negotiated access level
bounds the provider permission mode an MCP-started agent may run with:
`supervised` accepts only `permission_mode: "supervised"` and pins it
explicitly when the caller omits the argument (a provider default can
never silently exceed the level); requesting a higher mode
(`auto-accept-edits`/`auto`/`full-access`) fails `capability_denied`
before any socket call. `full` passes the caller's choice through
unrestricted. Providers without a verified `supervised` launch mapping
fail honestly via controls `unsupported_launch_option` → `unsupported`.

**Error mapping.** Sibling-CLI failure `kind`s map onto the contract
codes (`stale_*` → `stale_generation`, `*_not_found`/`*_missing` →
`not_found`, `unsupported_*`/`*_busy` → `unsupported`,
`requires_interactive_input`/`agent_blocked` → `upstream_gap`, usage/
invalid kinds → `invalid_params`, transport kinds →
`session_unreachable`, unmapped kinds (e.g. transient
`agent_not_ready` while agent registration settles) → `internal`); the
original kind is always preserved in `error.details.plugin_kind`.

### Events (T4, #140 — planned)

`events_subscribe`/`events_unsubscribe` (or resource equivalents) over
`events.subscribe`/`events.wait` with pane/agent/workspace/session
filters, reconnect + `session.snapshot` resync, and structured `gap`
reporting on missed events. Read-only clients may subscribe (read
nature); notifications are observation only.

### Explicitly out of scope for v1

- Remote HTTP/OAuth/pairing (herdrdev/herdr#6199).
- `request_secret`-equivalents and any tool that would place secrets in
  tool arguments/results/logs (ADR-0014/0015/0018 boundaries).
- Thread-scoped-only T3 tools (subagent internals, rendered HTML,
  device control, worktree handoff *inside* a running agent) — herdr
  has no equivalent agent-internal surface; attempting them returns
  `unsupported`, the same honest-refusal pattern as T3.
- MCP session registry persistence, MCP apps/widgets, sampling,
  elicitation (not needed by the herdr surface).

## Error model

`tools/call` failures return a JSON-RPC error (or `isError` result with
structured content, per the negotiated protocol revision) carrying:

```json
{
  "code": "capability_denied | not_found | stale_generation | session_unreachable | unsupported | plugin_unavailable | invalid_params | upstream_gap | internal",
  "message": "human-readable",
  "details": { "...": "tool-specific structured context" }
}
```

- `capability_denied` — access level insufficient (T3 semantics).
- `not_found` — unknown pane/agent/workspace/handoff id.
- `stale_generation` — `state_change_seq`/`agent_session`/pane identity
  mismatch; mutation refused before any side effect.
- `session_unreachable` — socket connect/timeout failure.
- `unsupported` — tool exists in the listing but cannot run here
  (e.g. thread-scoped T3-equivalent, or missing provider capability).
- `plugin_unavailable` — a backing sibling plugin is not installed or
  its CLI failed; `herdr_capability.plugins[]` reports the same
  verdicts proactively.
- `upstream_gap` — capability herdr does not expose (recorded per-tool
  in `herdr_capability.upstream_gaps`).
- Never fabricate: empty results are `[]`/`null` with explicit
  `coverage`/`missing` fields, not invented data.

## CLI surface (plugin's own commands)

The plugin keeps a minimal CLI for discovery and debugging (all emit
one JSON document on stdout; errors on stderr, exit 1/2):

- `mcp capability [--session NAME] [--socket PATH] [--access-level L]`
  → contract/version/access-level/tool-table/plugin-availability JSON.
- `mcp serve [--session NAME] [--socket PATH] [--access-level L]`
  → stdio MCP server (implemented, T2 #138; was `not_implemented`
  in T1).
- `mcp help`.

## State and config

- v1 writes **no durable state** (ADR-0025 §5): per-client stdio
  process, in-memory session/capability cache only.
- Config dir reserved under `HERDR_PLUGIN_CONFIG_DIR`; v1 reads no
  config file (access level is a CLI flag, not persisted).

## Versioning

`contract` is `herdr-plugins.mcp/vN`. Within v1 only additive optional
fields and new tools may appear; renaming/removing tools, changing
access-level semantics, or altering the error model requires v2.
Stability is declared per surface via `surfaces` in `capability`:
`read` is **stable** (T2, #138 — protocol methods, read tools,
identity echo, error model), `mutation` is **stable** (T3, #139 — the
six mutation tools, access gating, permission-mode cap, `effects`
echo), and `events` remains `planned` until #140 lands.
