# Contract: `herdr-plugins.tui/v1`

Versioned interface for the **interactive terminal surface** of
`hoxay-plugins` plugins (program #228, foundation #229). This is not a
per-plugin data contract like `herdr-plugins.<name>/vN`; it is the shared
contract that every plugin TUI entrypoint, the optional shared launcher,
and consumers (herdr TUI users, agents driving `plugin.pane.open`)
implement and rely on. Decisions: ADR-0031/0032/0033. Capability basis:
herdr **0.9.5** (verified; see ADR-0031 for the measured inventory).

## Scope

- IN: manifest pane entrypoints, `open` actions, target-identity passing,
  state ownership, keymap/help conventions, honest unsupported display,
  the safety contract.
- OUT: forking herdr, TUI-owned persistent business state, private
  cross-plugin state reads, reimplementing herdr TUI capabilities,
  screen-ifying the MCP server, requiring GUI/browser for core flows.

## 1. Entrypoint manifest shape

Each interactive plugin declares pane entrypoint(s) in
`herdr-plugin.toml`:

```toml
[[panes]]
id = "main"                          # local id: [a-zA-Z0-9_:-], no dots
title = "<Plugin>: <surface>"
platforms = ["linux", "macos", "windows"]   # or inherit top-level
placement = "tab"                    # see placement policy below
command = ["bun", "run", "src/tui.ts", "main"]
```

And at least one action that opens the UI:

```toml
[[actions]]
id = "open"
title = "<Plugin>: open UI"
contexts = ["pane"]                  # or ["workspace"] for workspace-scoped UIs
command = ["bun", "run", "src/tui.ts", "--open"]
```

Rules:

- `command` is an argv array executed with `plugin_root` as cwd; no
  shell. The entrypoint MUST be runnable via `bun run` with zero
  installation steps (repo convention; Bun is the documented runtime
  prerequisite).
- The pane process MUST terminate when its UI exits; herdr closes the
  pane/popup on process exit. Long-running background work belongs to
  the plugin's existing daemon/CLI paths, not the pane process.
- Plugins MUST work when launched by any of: manifest pane default,
  `plugin.pane.open` placement override, action→pane-open helper, or the
  optional launcher. No entrypoint may assume a specific placement.

### Placement policy

| placement | use for | constraints |
| --- | --- | --- |
| `tab` | primary workspace-scale browsers (recommended default for main UIs) | normal pane; has pane id |
| `split` / `zoomed` | auxiliary panels beside the working pane | needs `target_pane_id` or active pane |
| `overlay` | temporary focused flows | restores previous focus/zoom on close |
| `popup` | compact transient pickers/confirmations only | **session singleton, no pane id, no `HERDR_PANE_ID`, `ui_busy` while another modal is open** |

Multi-instance or identity-sensitive surfaces MUST NOT use `popup`.

## 2. Action naming

- Local action ids: `open` for the primary UI; `open-<surface>` for
  additional surfaces (e.g. `open-picker`). Pane entrypoint ids may
  differ (`main`, `picker`) but SHOULD mirror action names.
- Qualified ids are herdr's `plugin.id.action` — plugins never invent
  cross-plugin namespaces.
- Existing action ids are frozen; TUI additions are additive only.
- The `open` action's command SHOULD invoke `plugin.pane.open` via
  `HERDR_BIN_PATH` (portable across Unix socket / Windows named pipe)
  and return promptly; it MUST NOT block on the UI.

## 3. Target-identity passing

The UI process receives `HERDR_PLUGIN_CONTEXT_JSON` describing the
**origin** (workspace/tab/focused pane/worktree/agent/selected text/
invocation source) plus `HERDR_PLUGIN_ENTRYPOINT_ID`,
`HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`,
`HERDR_PLUGIN_STATE_DIR`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`,
`HERDR_ENV=1`, and `HERDR_PANE_ID` **only when the placement is a real
pane** (never for popup).

Contract rules:

1. The **target identity is pinned at launch**: the action/open helper
   captures the origin context once and passes it explicitly (context
   JSON plus `env` params on `plugin.pane.open` such as
   `HERDR_TUI_TARGET_PANE_ID` when the surface operates on a specific
   pane). The UI never re-derives "current" target from ambient focus
   after launch except through explicit user selection inside the UI.
2. **Surface identity ≠ target identity.** `HERDR_PANE_ID` (when
   present) identifies the UI pane itself — used only for self
   focus/close. Popup UIs have no pane id; all targeting flows through
   the pinned context.
3. **Liveness revalidation before mutation.** Before any mutating
   operation the UI re-reads the target through the public
   socket/CLI (`pane.get`/`agent.*`/plugin contract reads) and compares
   the same generation signals the CLI uses (agent_session fingerprint,
   `state_change_seq`, HEAD sha, checkpoint id, etc.). Stale ⇒ abort
   with a `stale_*`-class message and a refresh affordance; never
   silently retarget.
4. All herdr interaction goes through `HERDR_BIN_PATH` CLI or the
   documented socket API — the same public surface CLI/MCP/GUI use. No
   private channels, no PTY text scraping for state.

## 4. State ownership

- Durable state lives only in the plugin's existing
  `HERDR_PLUGIN_STATE_DIR` files via existing contracts. The TUI layer
  keeps **ephemeral view state only** (selection, filters, scroll
  position) and MAY persist trivial UI prefs (column widths, last
  filter) under the plugin's own state dir — never business state.
- No cross-plugin private state reads: sibling capabilities are consumed
  through their published `herdr-plugins.<name>/vN` contracts (CLI or
  documented socket), exactly as GUI/MCP do.
- The optional launcher holds no state; it is discovery +
  `plugin.pane.open` only.

## 5. Safety contract (normative checklist)

Every TUI surface MUST satisfy all of:

1. **Read-only open**: opening a view performs reads only. Lazy drains
   that mutate (reconcile-style) never run implicitly on open.
2. **Explicit target**: mutations name workspace/pane/repo/agent/host/
   session resolved from pinned context or in-UI selection.
3. **Stale generation**: abort-and-refresh on generation mismatch.
4. **Mutation gating**: consult `capability`/`mutation_commands`; render
   unsupported ops disabled-with-reason.
5. **Irreversible confirmation**: destructive ops show exact target +
   consequence; Esc cancels; no single-keystroke mutations.
6. **Secret non-display**: no secret values/tokens in render, logs,
   argv, or scrollback (ADR-0027).
7. **Timeout/cancel**: long ops show progress, honor cancel, report
   timeouts; partial results labeled.
8. **Escape/path safety**: untrusted strings (filenames, agent output,
   remote data, errors) escaped before render — no CSI/OSC injection;
   paths/commands validated like the CLI; external open is explicit.
9. **Honest unsupported**: missing sibling plugin, missing external CLI,
   older herdr, unsupported platform, or absent remote capability ⇒
   explicit unavailable state + reason + CLI fallback; never fabricated
   success.
10. **Resource discipline**: no unconditional resident service or
    high-frequency polling; refresh is user-triggered/event-driven;
    bounded output.

## 6. Keymap and help conventions

- Keys are defined per-surface in the plugin's TUI module; `packages/tui`
  supplies the keymap table component. Reserved: `q`/`Esc` = back/close,
  `?`/`h` = help, `Ctrl-C` = cancel current op (second press exits where
  safe), `/` = search/filter where a list exists.
- Plugins ship **no** `[[keys.command]]` entries and never write herdr
  config. Docs provide opt-in snippets, e.g.:

  ```toml
  [[keys.command]]
  key = "prefix+o"
  type = "plugin_action"
  command = "rebuildup.inbox.open"
  description = "open inbox TUI"
  ```

- In-TUI help (`?`) is generated from the same keymap table — no drift.
- Non-interactive CLI (`bun run src/cli.ts <cmd> --json` etc.) is
  **unchanged**: same commands, formats, exit codes. TUI-only affordances
  never alter CLI behavior.

## 7. Optional shared launcher

A launcher MAY exist that discovers installed plugins
(`herdr plugin list` / `plugin.action.list`) and opens their `open`
actions/panes. Contract:

- discovery-only; removing/disabling it affects nothing else;
- lists unavailable plugins (platform/`min_herdr_version`/missing
  entrypoint) with reasons, never silently;
- is itself a plugin or `packages/tui`-based entry — never a required
  dependency of any plugin.

## 8. Versioning

`herdr-plugins.tui/v1` is additive-stable: new optional fields/commands
extend v1; breaking changes to entrypoint shape, identity passing, or
safety semantics require `/v2` plus migration notes. Implementation
tickets (#230–#233) MUST cite this contract and record per-surface
coverage back into `docs/program/tui-coverage.json`.
