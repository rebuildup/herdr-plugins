# rebuildup.handoff

Handoff / delegation plugin for herdr (issues #103–#106; parent #6).

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
`done`/`failed` tracking. T3 (#105) adds cross-machine
`execute --remote`/`status --remote`/`remote-probe` and the portable
bundle. T4 (#106) adds delegation lineage (`create --parent`,
`delegate`, `merge-back`, `handoff_record` refs, `--worktree` targets)
and the #30/#32 boundaries — v1 is stable at v0.6.0.

## Contract

`herdr-plugins.handoff/v1` (stable) — see
`docs/contracts/handoff-v1.md`. Internal docs: `docs/specs/handoff.md`,
ADR-0017/0018/0020/0021 (Agent Router, local/remote execution,
delegation boundaries).

## Commands

```bash
bun run src/cli.ts create <pane_id> [--strategy S] [--note TEXT] \
    [--conversation KEY] [--checkpoint ID] [--handoff ID] [--external VALUE] \
    [--parent ID --relationship KIND] [--link-note TEXT] [--dry-run]
bun run src/cli.ts list [--status S] [--limit N]
bun run src/cli.ts status <handoff-id> [--no-resolve-refs]
bun run src/cli.ts execute <handoff-id> [--target-pane ID | \
    --target-workspace ID | --new-workspace | --worktree] \
    [--worktree-branch B] [--worktree-base R] [--provider HINT] \
    [--model M] [--wait-ms MS] [--cleanup-on-failure] [--dry-run]
bun run src/cli.ts delegate <parent-id> [delegate/execute flags]
bun run src/cli.ts merge-back <child-id> [--task TEXT] [--wait-ms MS] \
    [--link-note TEXT] [payload flags] [--no-execute] [--dry-run]
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
- #30 boundary: handoff stays CLI-only in v1 — whether MCP should
  expose these commands is #30's decision; this contract is the
  surface it consumes (ADR-0021).
- #32 boundary: no scheduled/triggered handoff — automations own
  automation; a future automation may *invoke* `delegate`/`merge-back`/
  `execute` through this CLI (ADR-0021).
