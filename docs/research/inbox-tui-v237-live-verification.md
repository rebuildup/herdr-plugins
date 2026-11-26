# Live verification: `rebuildup.inbox` TUI surface v0.7.0 (Issue #237)

Date: 2026-11-27. Scope: install-mode reachability of the
`packages/tui` relative import plus an end-to-end interactive pass
(open → list → keys → confirm-gated mutation → exit → focus return) on
real herdr 0.9.5. This is the ADR-0032/ADR-0033 open-question #1
measurement that `docs/program/tui-coverage.json` deferred to #237.

## Environment

| Env | Host | Session | Isolation |
| --- | --- | --- | --- |
| macOS | local (arm64) | `verify237` | dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HERDR_CONFIG_PATH` under `/var/tmp/herdr-plugin-237`, headless `herdr --session verify237 server` (real binary `~/.local/share/mise/installs/herdr/0.9.5/herdr`), all ambient `HERDR_*` unset for server/CLI calls via an `env -u` wrapper |

The user's live session was never touched. The isolated session was
stopped and deleted afterwards and `/var/tmp/herdr-plugin-237` removed.

## Install-mode reachability — the key measurement

`herdr plugin install` only accepts `OWNER/REPO[/SUBDIR]` from GitHub,
so the managed-checkout path was exercised for real:

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/inbox --ref 237 -y
herdr plugin update rebuildup.inbox -y   # → resolved_commit 19b328c
```

- The managed checkout is a **full-repo clone**
  (`…/github-installations/rebuildup.inbox-<hash>/<n>/checkout`) with
  `plugin_root` at `checkout/plugins/inbox`. `packages/tui` is present
  at `checkout/packages/tui`, so the entrypoint's
  `../../../packages/tui/src/index` import **resolves in install mode**.
- `herdr plugin pane open --plugin rebuildup.inbox --entrypoint main
  --placement tab` spawned `bun run src/tui.ts` in the managed
  checkout; the pane rendered the alternate-screen TUI (no module
  resolution error, no fallback text). **Verdict: PASS — no vendored
  copy needed; ADR-0032 relative-import approach works.**

## Interactive pass (all via `herdr pane send-keys` / `plugin action invoke`)

| # | Check | Result |
| --- | --- | --- |
| 1 | `plugin pane open` (manifest `[[panes]] main`, `placement=tab`) | PASS — pane `w1:p3` opened in new tab `w1:t3`, focused, label "Inbox" |
| 2 | First render | PASS — header `Inbox — verify237`, scope `inbox`, item list with pane ids, keybar footer; read-only open (only `cli.ts list` ran) |
| 3 | `?` help overlay | PASS — full keymap table rendered from the same table as the footer |
| 4 | `esc`/`q` exit | PASS — help closed, then `q` exited the process; pane `w1:p3` closed on exit (herdr closes plugin panes on process exit) |
| 5 | Focus return | PASS — after pane close, focus returned to the previously focused pane |
| 6 | `plugin action invoke rebuildup.inbox.open` | PASS — the `--open` helper invoked `plugin.pane.open` via `HERDR_BIN_PATH`, returned promptly (log `plugin-log-2`, exit 0), and pane `w1:p4` opened in tab `w1:t4` with the origin context pinned (`focused_pane_id w1:p1`, `workspace_id w1`) |
| 7 | Scope cycle `f` | PASS — `scope:inbox 1/2` → `scope:all 2/2`; settled pane shown with `[settled]` badge |
| 8 | `s` settle on `w1:p1` | PASS — confirm dialog (`[ Apply ] [ Cancel ]`, CLI preview `bun run src/cli.ts settle w1:p1`), Enter applied; status `settle w1:p1`, inbox count dropped to `1/2` |
| 9 | `r` restore on `w1:p1` | PASS — confirm dialog showed `cli: bun run src/cli.ts restore w1:p1`; after apply the item returned unbadged, scope `all 2/2` |
| 10 | Final `q` exit | PASS — pane `w1:p4` closed; `pane list` shows only `w1:p1`, focused |
| 11 | Plugin logs | PASS — `plugin log list` shows `plugin-log-1`/`plugin-log-2` `status: succeeded`, `exit_code: 0`, empty stderr |

Mutations were executed through the existing `cli.ts` commands only;
the TUI wrote no plugin state directly. The stale-generation guard and
non-TTY fallback paths are covered by `tests/inbox-tui.test.ts` (27
tests) rather than re-driven live.

## Notes / observations

- Two earlier `plugin pane open` runs left panes `w1:p2`/`w1:p3` alive
  while the TUI ran; both closed cleanly on `q`/`plugin pane close`.
  No zombie processes or leaked alternate-screen state observed.
- `herdr plugin pane open` does not take a `--plugin`-less form and
  requires `--entrypoint`; `plugin action invoke` takes the qualified
  id `rebuildup.inbox.open` as a positional arg (`--plugin` is not a
  flag on `invoke`).
- The TUI lists plugin-owned TUI panes themselves as inbox items
  (they are ordinary panes to herdr); this is honest behavior, not a
  defect — organize state can target them like any pane.
