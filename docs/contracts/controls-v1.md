# Contract `herdr-plugins.controls/v1`

Structured JSON CLI contract for the `rebuildup.controls` herdr
plugin — the agent operation core: send a prompt or provider slash
command, wait for an agent status, interrupt (PTY-level keys), read
terminal scrollback, rename, and launch agents with launch-time
controls, all over herdr's
`agent.*` socket API. Follows the same conventions as
`herdr-plugins.conversations/v1` / `herdr-plugins.usage/v1`.

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
bun run src/cli.ts command <target> <slash-command> [args...] [--wait] [--wait-until STATUS]... [--timeout-ms MS]
bun run src/cli.ts wait <target> [--until STATUS]... [--timeout-ms MS]
bun run src/cli.ts interrupt <target> [--key KEY]... [--keys k1,k2]
bun run src/cli.ts read <target> [--source SOURCE] [--lines N] [--format text|ansi] [--no-strip-ansi]
bun run src/cli.ts rename <target> (--name NAME | --clear)
bun run src/cli.ts start <pane_id> --agent <kind> [--name NAME] [--model M] [--reasoning L]
  [--permission-mode MODE] [--resume SESSION | --resume-from TARGET]
  [--arg ARG]... [--unsafe-args] [--timeout-ms MS]
  [--wait] [--wait-until STATUS]... [--wait-timeout-ms MS]
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
input semantics are not verified), the advisory per-provider
slash-command table, and the known upstream gaps (structured
interrupt, queue/steer, structured approval/question
dialogs, structured history).

`mutation_commands: ["send", "command", "interrupt", "rename", "start"]`;
`read` and `wait` are non-mutating.

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

## `command`

Provider slash-command passthrough (`/model`, `/clear`, `/compact`,
`/goal`, …). herdr has no structured command API, so this wraps
`agent.prompt` with the literal `/name args` text — the same
bracketed-paste + Enter mechanism as `send`.

- `<slash-command>` must start with `/` and match
  `/[A-Za-z][A-Za-z0-9_-]*/`; remaining positionals are args joined
  with spaces (no quoting layer). The built text **always starts with
  the command** — provider commands only run at message start (T3 Code
  composer rule).
- Args must be non-empty and contain no control characters; violations
  are usage errors (exit 2) before any RPC.
- `--wait` / `--wait-until` / `--timeout-ms` behave exactly as in
  `send`; the blocked-agent pre-check and `requires_interactive_input`
  error are identical.
- **Fragile by contract.** Whether the provider TUI interprets the
  text as a command is provider-version dependent and unverified.
  Results carry `fragile: true`, `passthrough: "agent.prompt"`,
  `command_name`, the submitted `text`, and a `provider` object
  `{kind, commands, known_command, note}` looked up from the advisory
  per-provider table (`capability.providers[].commands`). Unknown
  commands and providers without table entries are still forwarded —
  `known_command: false` is a hint, never a gate.

Result: `{contract, command:"command", identity, passthrough,
command_name, text, provider, fragile, waited, result}`.

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

## `start`

Wraps `agent.start` — launches a detected agent kind in an existing
pane that sits at its interactive shell prompt (upstream
`agent_pane_busy`/`agent_pane_not_found`/`unsupported_agent_kind` errors
pass through as `error.kind`). Unlike the other commands the positional
is a **pane id**, not an agent target, and the `--expect-*` generation
guards do not apply (there is no prior agent generation to guard).

- `--agent KIND` is required. herdr kind labels and common aliases are
  accepted; the canonical label is echoed as `launch.kind` alongside
  `launch.requested_kind`.
- `--name NAME` sets the agent display name (herdr rules:
  `[a-z][a-z0-9_-]{0,31}`). Default: `<kind>-<random suffix>`.
- `--timeout-ms MS` maps to `agent.start.timeout_ms` (integer in
  `(3000, 300000]`; upstream default 30000). This is herdr's
  interactive-readiness wait — the launch gate.
- Launch options map to provider CLI args via the per-provider table
  below; `--arg ARG` (repeatable) appends raw provider args last.
  - `--model VALUE`, `--reasoning VALUE`, `--resume VALUE` reject empty
    values, control characters, and leading `-` (flag smuggling).
  - `--permission-mode` ∈ `supervised|auto-accept-edits|auto|full-access`.
  - Unsupported option/provider pairs fail with
    `kind: "unsupported_launch_option"` **before** `agent.start` is
    called — implicit provider defaults are never relied on.
  - `--resume-from TARGET` resolves an existing agent's reported
    `agent_session` (kind `id`/`path` checked against the provider's
    accepted session kinds) instead of taking a literal value; a
    provider mismatch fails `resume_session_mismatch`, a missing
    session `no_agent_session`.
  - `--arg` values are screened against a privilege-escalation
    denylist (bypass/never-ask/danger-full-access flags, e.g.
    `--dangerously-skip-permissions`, `--yolo`, codex
    `--dangerously-bypass-approvals-and-sandbox`, `--sandbox
    danger-full-access`, claude `--permission-mode bypassPermissions`,
    cursor `--force`). Denied args fail `unsafe_agent_argument` before
    any RPC. `--unsafe-args` is the explicit opt-out and is echoed as
    `launch.applied.unsafe_args: true`.
- `--wait` / `--wait-until STATUS` / `--wait-timeout-ms MS` add a
  post-launch `agent.wait` (default until `idle|working`) — optional
  confirmation on top of `agent.start`'s own readiness wait.

Result: `{contract, command:"start", identity, launch, waited?, wait?}`
where `launch` carries `{kind, requested_kind, name, pane_id, args,
argv, applied, resume_source?}`. `argv` is herdr's full
`[executable, ...args]` echo; `applied` records which structured
options produced args.

### Launch option support (per provider)

`capability.providers[].launch` reports the same table: `model`,
`reasoning`, `permission_modes` (mode → argv), and `resume` (argv
template + accepted session kinds, or `"unsupported"`).

| kind | model | reasoning | permission-mode | resume |
| --- | --- | --- | --- | --- |
| claude | `--model` | `--effort` | all 4 (`manual`/`acceptEdits`/`auto`/`bypassPermissions`) | `--resume <id>` |
| codex | `--model` | `-c model_reasoning_effort=` | all 4 (`-a`/`-s` combos, `--approve-for-me`, bypass flag) | `resume <id>` |
| gemini | `--model` | — | supervised/auto-accept-edits/full-access (`--approval-mode`) | — |
| cursor | `--model` | — | full-access only (`--force`) | `--resume <id>` |
| pi | `--model` | `--thinking` | — | `--session <path\|id>` |
| opencode | — | — | full-access only (`--auto`) | `--session <id>` |
| omp | — | — | — | `--resume=<path\|id>` |
| mastracode | — | — | — | `--thread <id>` |
| copilot | — | — | — | `--resume=<id>` |
| devin, droid, grok, hermes, qodercli, qwen | — | — | — | `--resume <id>` |
| kimi, kilo | — | — | — | `--session <id>` |
| agy | — | — | — | `--conversation <id>` |
| letta | — | — | — | `--conversation <id>` (`default:<agent>` form supported) |
| cline, kiro, amp, maki, muse | — | — | — | — |

Resume argv mirrors herdr's own `agent_resume.rs` launch plan (the
mapping herdr uses for session restore). `agent_session_path` is not
exposed for claude/codex upstream, so only id-kind resume is
available there.

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
| `unsupported_launch_option` | `start` option has no verified mapping for the provider (see `capability.providers[].launch`) |
| `unsafe_agent_argument` | `--arg` matched the privilege-escalation denylist; `agent.start` not called |
| `no_agent_session` | `--resume-from` target reported no `agent_session` |
| `resume_session_mismatch` | `--resume-from` session provider differs from `--agent` |
| `agent_not_found` (and other upstream codes) | `agent.get`/operation RPC rejection, code passed through (incl. `agent_pane_busy`, `agent_pane_not_found`, `unsupported_agent_kind`, `invalid_agent_timeout`) |
| `timeout` | upstream wait/prompt timeout |
| `session_unreachable` | socket connect/transport failure |
| `usage` | CLI usage error (exit 2) |
