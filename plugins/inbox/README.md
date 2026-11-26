# rebuildup.inbox

Work inbox for herdr agent panes — the standalone-plugin port of T3 Code's
settle / snooze / pin / archive / manual-ordering / restore organize model.

- Plugin ID: `rebuildup.inbox`
- Install: `herdr plugin install rebuildup/herdr-plugins/plugins/inbox`
  (pre-release: append `--ref release-0-9-0` or a commit SHA)
- Runtime prerequisite: [Bun](https://bun.sh) on `PATH` (plugin commands run
  `bun run src/cli.ts`; see ADR-0003 for the no-daemon/Bun decision).

## What it does

- `settle` hides a pane's organize state until its `state_change_seq`
  advances or its agent session identity changes.
- `snooze` hides a pane until a wall-clock deadline (`--until`), waking early
  on the same generation signals.
- `archive` hides a pane as "filed away" — it never closes the pane, stops
  the agent, or touches the PTY; `unarchive` (or attention/a generation
  change) brings it back.
- `pin` sorts a pane to the top of the inbox without hiding it.
- `order` sets a manual rank within the pane's display group
  (`--first`/`--last`/`--before <pane>`/`--after <pane>`).
- `list` filters: `--attention`, `--organize settled|snoozed|archived|none`,
  `--search <text>` (title/cwd/pane_id), `--workspace <id>` — read-side
  only, never mutate state.
- `link`/`unlink`/`links` manage user-declared PR/Issue references
  (`<repo>#<n>`) per pane — explicit associations only, no forge-event
  auto-linking; stale links never attach to a new agent generation.
- `restore` returns a pane to the inbox and clears all organize state
  (declared links are preserved).
- `list` emits the versioned JSON contract (`herdr-plugins.inbox/v1`) for TUI,
  CLI, agents, and external clients such as herdr-t3 — see
  `docs/contracts/inbox-v1.md`.
- Event hooks (`pane.agent_status_changed`, `pane.closed`) and a startup
  reconcile keep organize state consistent and refresh pane metadata tokens
  (`inbox_state`, `inbox_snoozed_until`, `inbox_pinned`).

Organize state is user-side UI state only: it never modifies herdr agent
execution state, and attention statuses (e.g. `blocked`) are never hidden.

## Commands

```bash
bun run src/cli.ts list [--session NAME] [--socket PATH]
bun run src/cli.ts settle <pane_id>
bun run src/cli.ts snooze <pane_id> --until <iso8601|+30m|+2h|+1d>
bun run src/cli.ts restore <pane_id>
bun run src/cli.ts pin <pane_id>
bun run src/cli.ts unpin <pane_id>
bun run src/cli.ts archive <pane_id>
bun run src/cli.ts unarchive <pane_id>
bun run src/cli.ts order <pane_id> --first|--last|--before <pane>|--after <pane>
bun run src/cli.ts list --attention --organize settled --search <text> --workspace <id>
bun run src/cli.ts link <pane_id> --pr <owner>/<repo>#<n> [--verify]
bun run src/cli.ts unlink <pane_id> --issue <owner>/<repo>#<n>
bun run src/cli.ts links <pane_id>
bun run src/cli.ts reconcile
bun run src/cli.ts transitions [--after <seq>] [--limit <n>]
bun run src/cli.ts watch [--interval SECONDS]
bun run src/cli.ts capability
```

Inside a manifest action or event hook, `<pane_id>` may be omitted; the
plugin resolves it from `HERDR_PANE_ID` / `HERDR_PLUGIN_CONTEXT_JSON`.

`watch` is an opt-in long-running reconciler (subscription + periodic
expiry). Without it or an event, snooze expiry materializes lazily on the
next command invocation — see `docs/specs/inbox.md` for the constraint.

`transitions` is a read-only page over the per-session organize-transition
log (ADR-0029): every settle/snooze/restore/clear is recorded with a
monotonic `seq`, and consumers drain it via `--after <seq>` —
`rebuildup.projects` uses it for `runOnSettle`/`stopOnSettle` triggers.

## State

Durable state lives only under herdr's plugin state dir
(`HERDR_PLUGIN_STATE_DIR` at runtime; `~/.local/state/herdr/plugins/rebuildup.inbox/state.json`
for external clients). Entries are namespaced per session (hostname +
socket path) so organize state never leaks across sessions or hosts.
Config (`config.json`, e.g. `defaultSnooze`) lives under the plugin config
dir. `snooze` also detaches a one-shot wake process that restores the pane
at its deadline without a resident daemon (ADR-0005). Nothing is written
inside the installed source tree.
