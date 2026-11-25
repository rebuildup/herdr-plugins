# Contract `herdr-plugins.controls/v1`

Structured JSON CLI contract for the `rebuildup.controls` herdr
plugin — the agent operation core: send a prompt, wait for an agent
status, interrupt (PTY-level keys), read terminal scrollback, and
rename, all over herdr's `agent.*` socket API. Follows the same
conventions as `herdr-plugins.conversations/v1` /
`herdr-plugins.usage/v1`.

PTY text is never parsed into invented agent state. Every result
echoes the resolved herdr identity (host / session / workspace / tab /
pane / `agent_session` / `state_change_seq`) observed via `agent.get`
before the operation ran.

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.controls"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.controls/v1"` and the commands you
   need exist.

## Invocation

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts send <target> <text...> [--wait] [--wait-until STATUS]... [--timeout-ms MS]
bun run src/cli.ts wait <target> [--until STATUS]... [--timeout-ms MS]
bun run src/cli.ts interrupt <target> [--key KEY]... [--keys k1,k2]
bun run src/cli.ts read <target> [--source SOURCE] [--lines N] [--format text|ansi] [--no-strip-ansi]
bun run src/cli.ts rename <target> (--name NAME | --clear)
```

- `<target>` is a herdr agent target (pane id or agent name), resolved
  by `agent.get` before every operation. A target that is not a live
  agent fails with the upstream RPC code as `error.kind`
  (`agent_not_found`, …) — never a fabricated success.
- All commands accept `--session NAME`, `--socket PATH`, `--timeout MS`
  (socket request timeout). Every command needs a reachable herdr
  session except `capability`, which works offline.
- All commands print exactly one JSON document on stdout. Handled
  errors print `{contract, ok:false, error:{code,message,kind?,…}}` on
  **stderr** and exit 1; usage errors exit 2.
- Identity guards on every command: `--expect-pane PANE_ID`,
  `--expect-state-seq N`, `--expect-agent-session VALUE` (matches
  `agent_session.value`). Any mismatch aborts with
  `kind: "stale_generation"` **before** the mutating `agent.*` call —
  stale control state is never applied to a different agent generation.

## `capability`

Offline. Reports the contract version, the command list, the
`agent.*` API mapping per operation (`pty_level` distinguishes
structured calls from PTY key injection), the per-provider support
matrix (uniform across herdr-detected agent kinds; provider-specific
input semantics are not verified), and the known upstream gaps
(structured interrupt, queue/steer, structured approval/question
dialogs, structured history).

`mutation_commands: ["send", "interrupt", "rename"]`; `read` and
`wait` are non-mutating.

## `send`

Wraps `agent.prompt`. `<text>` is the remaining positional words joined
with spaces.

- `--wait` / `--wait-until STATUS` (repeatable) map to herdr's
  `wait{until[], timeout_ms}`: observe the first matching
  `agent_status` after submission. This observes status transitions
  only — it does not track turns (upstream semantics).
- `--timeout-ms MS` sets `wait.timeout_ms` when waiting.
- **Blocked agents**: if `agent.get` reports `agent_status: "blocked"`,
  `send` fails with `kind: "requires_interactive_input"` and the
  `agent.prompt` call is never made — mirroring herdr's upstream
  `agent_blocked` pre-send rejection. Success is never fabricated for
  a blocked agent.

Result: `{contract, command:"send", identity, waited, result}` where
`result` is herdr's `agent.prompt` response verbatim.

## `wait`

Wraps `agent.wait`. `--until STATUS` (repeatable; default upstream:
`idle|done|blocked`) and `--timeout-ms MS` pass through. Timeout
surfaces as `kind: "timeout"`.

## `interrupt`

Wraps `agent.send_keys` — **PTY-level key injection, not a structured
interrupt**. Default keys: `["esc"]`; `--key` (repeatable) and
`--keys k1,k2` add/override. The result echoes `pty_level: true` so
callers cannot mistake it for a semantic interrupt.

## `read`

Wraps `agent.read` — bounded terminal **scrollback**, not structured
conversation history (`scrollback: true` in the result). For
conversation events use `rebuildup.conversations`
(`herdr-plugins.conversations/v1`).

`--source` ∈ `visible|recent|recent-unwrapped|detection` (default
`recent`), `--lines N`, `--format text|ansi`. `strip_ansi` defaults to
`true` for `text` and `false` for `ansi`; `--no-strip-ansi` forces it
off.

## `rename`

Wraps `agent.rename`. Exactly one of `--name NAME` or `--clear`
(`name: null` upstream).

## Identity

Every non-capability result carries:

```json
"identity": {
  "host": "…",
  "herdr_session": "…",
  "workspace_id": "…",
  "tab_id": "…",
  "pane_id": "…",
  "agent": "claude",
  "agent_session": { "agent": "…", "kind": "…", "value": "…" },
  "state_change_seq": 7,
  "agent_status": "idle",
  "interactive_ready": true,
  "launch_pending": false
}
```

`agent_session`/`state_change_seq` are the generation signals; fields
herdr does not report are `null`/omitted — never fabricated.

## Error kinds

| kind | Meaning |
| --- | --- |
| `requires_interactive_input` | `send` targeted a `blocked` agent; prompt not submitted |
| `stale_generation` | `--expect-*` guard mismatched; mutation not sent |
| `agent_not_found` (and other upstream codes) | `agent.get`/operation RPC rejection, code passed through |
| `timeout` | upstream wait/prompt timeout |
| `session_unreachable` | socket connect/transport failure |
| `usage` | CLI usage error (exit 2) |
