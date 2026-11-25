# rebuildup.handoff

Handoff / delegation plugin for herdr (issue #103, parent #6 T1).

Records versioned **handoff records** that bind a source pane/agent
generation to a **payload of references** — conversation index sessions,
checkpoints, bounded excerpts, external spec/requirement pointers — plus
a status lifecycle (`pending → ready → delivered → done/failed/
superseded`) and a transfer strategy (`native_resume` /
`portable_context` / `checkpoint_ref` / `manual`).

T1 scope: payload contract, state store, `create` / `list` / `status`.
Execution (target pane/workspace creation, `agent.start`, payload
injection, status transitions) is T2 (#104); cross-machine handoff is
T3 (#105); delegation/lineage is T4 (#106).

## Contract

`herdr-plugins.handoff/v1` — see `docs/contracts/handoff-v1.md`.
Internal docs: `docs/specs/handoff.md`, ADR-0017 (Agent Router boundary).

## Commands

```bash
bun run src/cli.ts create <pane_id> [--strategy S] [--note TEXT] \
    [--conversation KEY] [--checkpoint ID] [--external VALUE] [--dry-run]
bun run src/cli.ts list [--status S] [--limit N]
bun run src/cli.ts status <handoff-id> [--no-resolve-refs]
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
  only records intent and reads snapshots.
- Payloads are references + bounded excerpts, never transcript copies.
- Stale identity (pane reuse, `agent_session`/`state_change_seq`
  mismatch) is reported, never applied.
- Agent Router routing (dotfiles `script/agent`, `config/agents.toml`)
  is not reimplemented; `provider_hint` is an opaque label (ADR-0017).
