# rebuildup.handoff

Handoff / delegation plugin for herdr (issues #103 T1, #104 T2; parent
#6).

Records versioned **handoff records** that bind a source pane/agent
generation to a **payload of references** — conversation index sessions,
checkpoints, bounded excerpts, external spec/requirement pointers — plus
a status lifecycle (`pending → ready → delivered → done/failed/
superseded`) and a transfer strategy (`native_resume` /
`portable_context` / `checkpoint_ref` / `manual`).

T2 scope: `execute` runs the same-host handoff — target surface via
herdr API only (`workspace.create`/`tab.create` + `agent.start` +
`agent.prompt` payload injection), `native_resume` with
`portable_context` fallback, `--cleanup-on-failure`, and honest
`done`/`failed` tracking. Cross-machine handoff is T3 (#105);
delegation/lineage is T4 (#106).

## Contract

`herdr-plugins.handoff/v1` — see `docs/contracts/handoff-v1.md`.
Internal docs: `docs/specs/handoff.md`, ADR-0017 (Agent Router boundary).

## Commands

```bash
bun run src/cli.ts create <pane_id> [--strategy S] [--note TEXT] \
    [--conversation KEY] [--checkpoint ID] [--external VALUE] [--dry-run]
bun run src/cli.ts list [--status S] [--limit N]
bun run src/cli.ts status <handoff-id> [--no-resolve-refs]
bun run src/cli.ts execute <handoff-id> [--target-pane ID | \
    --target-workspace ID | --new-workspace] [--provider HINT] \
    [--model M] [--wait-ms MS] [--cleanup-on-failure] [--dry-run]
bun run src/cli.ts resume-info [--provider KIND]
bun run src/cli.ts capability
```

All commands emit one JSON document on stdout; errors go to stderr
(exit 1 handled, 2 usage).

## Runtime prerequisite

[Bun](https://bun.sh) — the plugin is dependency-free TypeScript executed
directly; there is no build step.

## State

`<plugin state dir>/state.json` — `HERDR_PLUGIN_STATE_DIR` under plugin
runtime, `<state-herdr>/plugins/rebuildup.handoff/state.json` for external
clients. Single-writer lock + tmp+rename; records are never namespaced per
session (the transfer identity carries its own `session_key`).

## Boundaries

- herdr remains the sole authority for PTYs/panes/agents; this plugin
  creates surfaces only through the socket API (`workspace.create` /
  `tab.create` + `agent.*`) and records observed state — it never owns
  a PTY and never invokes the Agent Router launcher (`provider_hint`
  stays an opaque label; ADR-0017/0018).
- Payloads are references + bounded excerpts, never transcript copies.
- Stale identity (pane reuse, `agent_session`/`state_change_seq`
  mismatch) is reported, never applied.
- Agent Router routing (dotfiles `script/agent`, `config/agents.toml`)
  is not reimplemented; `provider_hint` is an opaque label (ADR-0017).
