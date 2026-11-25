# rebuildup.controls

Agent operation core for herdr panes
(`herdr-plugins.controls/v1`).

## Install

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/controls
```

Prerequisites: herdr ≥ 0.9.0, Bun on `PATH`, and a reachable herdr
session for every command except `capability`.

## What it does

Thin, stateless wrappers over herdr's `agent.*` socket API:

- `send <target> <text...>` — `agent.prompt`; `--wait`/`--wait-until`/
  `--timeout-ms` observe post-submit status. A `blocked` agent fails
  with `requires_interactive_input` and the prompt is never sent.
- `command <target> <slash-command> [args...]` — provider slash-command
  passthrough via `agent.prompt` (literal `/name args` text; fragile,
  provider-TUI dependent — see `capability.providers[].commands`).
- `wait <target>` — `agent.wait` until a status set or timeout.
- `interrupt <target>` — `agent.send_keys` (PTY-level; default `esc`,
  `--key`/`--keys` to customize). Not a structured interrupt.
- `read <target>` — `agent.read` scrollback (`--source`, `--lines`,
  `--format`, `--no-strip-ansi`). Not structured history — use
  `rebuildup.conversations` for conversation events.
- `rename <target>` — `agent.rename` (`--name` / `--clear`).
- `start <pane_id> --agent <kind>` — `agent.start` launch-time
  controls: `--model`, `--reasoning`, `--permission-mode`
  (supervised / auto-accept-edits / auto / full-access), `--resume` /
  `--resume-from`, repeatable `--arg` passthrough (privilege-flag
  denylist; `--unsafe-args` opt-out), `--timeout-ms` startup wait,
  optional `--wait*` post-launch `agent.wait`. Provider support is
  per-kind and explicit — unsupported pairs fail
  `unsupported_launch_option` (see `capability.providers[].launch`).
- `capability` — offline contract/provider/operation discovery.

Every operation resolves `<target>` (pane id or agent name) via
`agent.get` first and echoes the full identity (host, session,
workspace/tab/pane, `agent_session`, `state_change_seq`). Optional
guards `--expect-pane` / `--expect-state-seq` /
`--expect-agent-session` abort with `stale_generation` before any
mutation — control state is never applied to a different agent
generation.

## Usage

```bash
cd "$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id=="rebuildup.controls") | .plugin_root')"
bun run src/cli.ts capability
bun run src/cli.ts send pane-1 "please continue" --wait-until idle --timeout-ms 60000
bun run src/cli.ts command pane-1 /compact
bun run src/cli.ts wait pane-1 --until idle --until done --timeout-ms 30000
bun run src/cli.ts interrupt pane-1            # sends esc
bun run src/cli.ts interrupt pane-1 --key ctrl+c
bun run src/cli.ts read pane-1 --lines 100
bun run src/cli.ts rename pane-1 --name worker-1
bun run src/cli.ts start pane-2 --agent claude --name worker-2 \
  --model sonnet --permission-mode supervised --wait
bun run src/cli.ts start pane-3 --agent codex --resume-from pane-1
```

All commands accept `--session NAME`, `--socket PATH`, `--timeout MS`.
Output is one JSON document on stdout; errors are
`{contract, ok:false, error:{code,message,kind?}}` on stderr
(exit 1 handled, 2 usage).

See `docs/contracts/controls-v1.md` and `docs/specs/controls.md`.
