# rebuildup.inbox

Work inbox for herdr agent panes — the standalone-plugin port of T3 Code's
settle / snooze / restore organize model.

- Plugin ID: `rebuildup.inbox`
- Install: `herdr plugin install rebuildup/herdr-plugins/plugins/inbox`
  (pre-release: append `--ref release-0-1-0` or a commit SHA)
- Runtime prerequisite: [Bun](https://bun.sh) on `PATH` (plugin commands run
  `bun run src/cli.ts`; see ADR-0003 for the no-daemon/Bun decision).

## What it does

- `settle` hides a pane's organize state until its `state_change_seq`
  advances or its agent session identity changes.
- `snooze` hides a pane until a wall-clock deadline (`--until`), waking early
  on the same generation signals.
- `restore` returns a pane to the inbox immediately.
- `list` emits the versioned JSON contract (`herdr-plugins.inbox/v1`) for TUI,
  CLI, agents, and external clients such as herdr-t3 — see
  `docs/contracts/inbox-v1.md`.
- Event hooks (`pane.agent_status_changed`, `pane.closed`) and a startup
  reconcile keep organize state consistent and refresh pane metadata tokens
  (`inbox_state`, `inbox_snoozed_until`).

Organize state is user-side UI state only: it never modifies herdr agent
execution state, and attention statuses (e.g. `blocked`) are never hidden.

## Commands

```bash
bun run src/cli.ts list [--session NAME] [--socket PATH]
bun run src/cli.ts settle <pane_id>
bun run src/cli.ts snooze <pane_id> --until <iso8601|+30m|+2h|+1d>
bun run src/cli.ts restore <pane_id>
bun run src/cli.ts reconcile
bun run src/cli.ts watch [--interval SECONDS]
bun run src/cli.ts capability
```

Inside a manifest action or event hook, `<pane_id>` may be omitted; the
plugin resolves it from `HERDR_PANE_ID` / `HERDR_PLUGIN_CONTEXT_JSON`.

`watch` is an opt-in long-running reconciler (subscription + periodic
expiry). Without it or an event, snooze expiry materializes lazily on the
next command invocation — see `docs/specs/inbox.md` for the constraint.

## State

Durable state lives only under herdr's plugin state dir
(`HERDR_PLUGIN_STATE_DIR` at runtime; `~/.local/state/herdr/plugins/rebuildup.inbox/state.json`
for external clients). Config (`config.json`, e.g. `defaultSnooze`) lives
under the plugin config dir. Nothing is written inside the installed source
tree.
