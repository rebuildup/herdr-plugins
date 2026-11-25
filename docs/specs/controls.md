# Controls plugin (`rebuildup.controls`) — specification

Scope: agent operation core over herdr's `agent.*` socket API —
send / wait / interrupt / read / rename. Contract:
`herdr-plugins.controls/v1` (`docs/contracts/controls-v1.md`). Design:
ADR-0017. First ticket of the #27 Provider Controls/Composer
decomposition (T1); #6 handoff destination control and #29 textgen
generation-pane control are intended consumers of this surface.

## Purpose

Give agents, the TUI, the CLI, and external clients (herdr-t3) one
versioned way to operate detected agents — submit prompts, await
status transitions, interrupt, inspect scrollback, and rename —
without any plugin reimplementing PTY handling or inventing agent
state. herdr remains the sole execution authority.

## Identity and resolution

- `<target>` is a herdr agent target (pane id or agent name) passed
  verbatim to `agent.get` / the `agent.*` methods; herdr resolves it.
- Before every operation the CLI resolves the target via `agent.get`
  and echoes the full identity: host, herdr session, workspace/tab/
  pane ids, `agent` kind, `agent_session` ref, `state_change_seq`,
  `agent_status`, `interactive_ready`, `launch_pending`.
- Optional per-invocation guards `--expect-pane`,
  `--expect-state-seq`, `--expect-agent-session` pin the generation
  the caller observed (same signals inbox/checkpoints use for
  organize-state staleness). A mismatch aborts with
  `stale_generation` before the `agent.*` mutation is sent — control
  operations are never applied to a reused pane id or a different
  agent session.
- The plugin keeps **no durable state**: there is nothing to go stale
  between invocations, and every guard is evaluated against a live
  `agent.get`.

## Commands

| Command | Upstream API | Mutating? | Notes |
| --- | --- | --- | --- |
| `capability` | — (offline) | no | Contract/version/command discovery, per-operation API mapping, provider matrix, upstream gaps. |
| `send <target> <text...>` | `agent.prompt` | yes | `--wait`/`--wait-until`/`--timeout-ms` map to `wait{until[],timeout_ms}`. `blocked` target → `requires_interactive_input`, prompt never sent. |
| `wait <target>` | `agent.wait` | no | `--until` repeatable, `--timeout-ms`; upstream default until = idle/done/blocked. |
| `interrupt <target>` | `agent.send_keys` | yes (PTY) | PTY-level keys only — default `esc`; `--key`/`--keys` customize. No structured interrupt exists upstream. |
| `read <target>` | `agent.read` | no | Scrollback (`--source`, `--lines`, `--format`, `--no-strip-ansi`); not structured history — see `rebuildup.conversations`. |
| `rename <target>` | `agent.rename` | yes | `--name NAME` or `--clear`. |

## Semantics and honest limits

- **No fabricated state.** `agent_status`, `state_change_seq`, and
  `agent_session` come only from herdr (`agent.get` / snapshot). The
  plugin never parses PTY text into statuses.
- **Blocked send.** herdr 0.9.5 `agent.prompt` rejects an already
  `blocked` agent with `agent_blocked` before input is sent (verified
  upstream, `src/app/api/agents.rs`). The CLI additionally pre-checks
  via `agent.get` and returns `requires_interactive_input` without
  calling `agent.prompt` — identical outcome, structured earlier, and
  guaranteed not to report success.
- **Interrupt is PTY-level.** `agent.send_keys` injects key names into
  the terminal; effect depends on the provider's keybindings. The
  result marks `pty_level: true`.
- **Read is scrollback.** `agent.read` returns terminal text
  (`visible|recent|recent_unwrapped|detection`, `text|ansi`), not a
  structured event history. Conversation history is
  `rebuildup.conversations`' job (#5).
- **Unsupported is explicit.** Unknown/unresolvable targets surface
  the upstream RPC error code as `error.kind`; unreachable sessions
  surface `session_unreachable`; upstream gaps are enumerated in
  `capability.upstream_gaps` (structured interrupt, queue/steer,
  structured approval/question dialogs, structured history).

## Upstream gaps (recorded, not worked around)

From the #27 feasibility research (herdr 0.9.5, protocol 22):

1. No structured interrupt API — PTY keys only.
2. No queued-message / steer session concept.
3. No structured approval/question events or responses; `blocked`
   agents reject `agent.prompt` (shared root with #8 attention
   granularity).
4. `agent.read` is scrollback; `agent_session_path` is discarded by
   claude/codex adapters upstream (#89 candidate).

## Testing

`tests/controls.test.ts` runs the real CLI against a fake herdr socket
(`net.createServer` speaking the NDJSON protocol): identity echo,
wait-option forwarding, blocked-send rejection without an
`agent.prompt` call, key/read/rename parameter passthrough, all three
generation guards, `agent_not_found`, invalid-argument usage errors,
and `session_unreachable`.
