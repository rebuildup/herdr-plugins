# ADR-0031: TUI surface architecture — official plugin panes as the primary path, measured against herdr 0.9.5

## Status

Accepted (design foundation for #228 / #229, TUI release train `release-0-11-0`)

## Context

Issue #228 makes the herdr TUI a first-class plugin consumption surface:
human-facing plugin capabilities must be operable without a GUI, on WSL2,
SSH, headless Linux, macOS, and Windows terminals. Issue #229 requires the
design to be grounded in what the distributed herdr version actually
supports — "measure, don't assume".

This ADR records (a) the verified herdr capability inventory and (b) the
architecture decision for how `herdr-plugins` exposes interactive terminal
UIs.

### Verified capability inventory (herdr 0.9.5)

Verification method: installed `herdr 0.9.5` (`/Users/rebui/.local/bin/herdr`,
`herdr --version`) plus the matching source checkout at
`herdrdev/herdr` (worktree HEAD `e8d7d970`, post-v0.9.5) and the versioned
docs `docs/versions/0.9.5/website/src/content/docs/{plugins,socket-api,configuration}.mdx`
in that repo, cross-checked against <https://herdr.dev/tui/docs/plugins/>,
<https://herdr.dev/tui/docs/socket-api/>, and
<https://herdr.dev/tui/docs/configuration/>.

**Manifest schema** (`src/app/api/plugins/manifest.rs:14-37`,
`docs/versions/0.9.5/.../plugins.mdx`):

- Top level: `id`, `name`, `version`, `min_herdr_version` (required;
  install/link refused when newer than the running binary),
  `description`, `platforms`.
- `[[build]]`, `[[startup]]`, `[[actions]]`, `[[events]]`, `[[panes]]`,
  `[[link_handlers]]` are all supported in 0.9.5.
- `[[actions]]`: `id`, `title`, `description`, `contexts`
  (`global|workspace|tab|pane|selection`,
  `src/api/schema/plugins.rs:373-380`), `platforms`, `command` (argv array,
  no shell).
- `[[events]]`: `on` (plugin hook event name), `platforms`, `command`.
- `[[panes]]`: `id`, `title`, `description`, `platforms`, `placement`,
  `width`/`height` (`PopupSize`: cells or `"NN%"`), `command`
  (`manifest.rs:64-77`, `src/api/schema/plugins.rs:280-292`).
- `[[link_handlers]]`: `id`, `title`, `pattern` (Rust regex), `action`,
  `platforms` — routes modified clicks on matching URLs to an action.

**Pane placements** (`PluginPanePlacement`,
`src/api/schema/plugins.rs:467-474`; dispatch `src/app/api/plugins/mod.rs:504-545`):

| placement | behavior in 0.9.5 | pane ID? |
| --- | --- | --- |
| `overlay` (default) | temporary zoomed overlay over active pane; restores previous focus/zoom on close | yes (normal pane) |
| `popup` | session-modal terminal popup; receives all terminal input incl. Escape; closes when the command exits or `popup.close` is sent; `ui_busy` while Settings/Copy mode/another modal is active; singleton per session | **no pane ID, no `HERDR_PANE_ID`, no pane lifecycle events, outside all `pane.*`/agent APIs** |
| `split` | real split pane next to `target_pane_id` (or active pane), `direction` right/down, `focus` flag | yes |
| `tab` | new tab in `workspace_id` (or active workspace) | yes |
| `zoomed` | split placement + zoomed flag, always focused | yes |

Popup via CLI: `herdr plugin pane open --placement` accepts `popup` and a
hidden alias `fullscreen`, but both are `hide(true)` in help
(`src/cli/plugin/bindings.rs:70-81`); `--width`/`--height` are likewise
hidden. The socket API `plugin.pane.open` accepts `popup` officially
(`src/api/schema/plugins.rs:441-445`, docs socket-api.mdx). Manifest
`placement = "popup"` is fully supported.

**Open/focus/close API**: socket methods `plugin.pane.open`,
`plugin.pane.focus`, `plugin.pane.close` (`socket-api.mdx` method table;
CLI `herdr plugin pane open|focus|close`). `plugin.pane.open` params:
`plugin_id`, `entrypoint`, `placement`, `width`, `height`,
`workspace_id`, `target_pane_id`, `direction`, `cwd`, `focus`, `env`
(`src/api/schema/plugins.rs:433-460`). Open returns `PluginPaneInfo`
(`plugin_id`, `entrypoint`, `pane`) for pane-backed placements.

**Action invocation**: `plugin.action.invoke` (socket) /
`herdr plugin action invoke` runs the manifest command as a **background
process with captured output** (64 KiB cap, 32 in-flight max, 200-entry log
ring; `src/app/api/plugins/runtime.rs:14-16,104-107`), not as a pane. Keybind
path `[[keys.command]] type = "plugin_action"` calls
`invoke_plugin_action_from_keybind` (`mod.rs:225`) with the same semantics.
Results are read via `plugin.log.list` / `herdr plugin log`. **Actions
cannot render a UI** — they are the trigger, panes are the surface.

**Context injection**: every plugin command receives
`HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_ENV=1`, `HERDR_PLUGIN_ID`,
`HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`,
`HERDR_PLUGIN_CONTEXT_JSON`, and available `HERDR_WORKSPACE_ID`,
`HERDR_TAB_ID`, `HERDR_PANE_ID` (`panes.rs:270-310`, `runtime.rs:36-78`).
Context JSON fields (`src/api/schema/plugins.rs:382-411`):
`workspace_id/label/cwd`, `worktree`, `tab_id/label`,
`focused_pane_id/cwd/agent/status`, `selected_text`, `invocation_source`,
`correlation_id`, `clicked_url`, `link_handler_id`.
Pane commands additionally get `HERDR_PLUGIN_ENTRYPOINT_ID`; action
commands get `HERDR_PLUGIN_ACTION_ID`; hooks get `HERDR_PLUGIN_EVENT` and
`HERDR_PLUGIN_EVENT_JSON`.

Crucially, the context describes the **origin** (workspace/tab/focused
pane at launch time), while `HERDR_PANE_ID` on a pane-backed plugin pane
identifies the **new UI pane itself** when the normal pane env applies.
For `popup`, no `HERDR_PANE_ID` is exported at all — the origin identity
must travel exclusively through `HERDR_PLUGIN_CONTEXT_JSON` and explicit
`env` params on `plugin.pane.open`.

**Keybindings** (`configuration.mdx`, `src/config/keybinds.rs:110-133`):
`[[keys.command]]` with `key`, `type = "plugin_action"`, `command =
"<plugin>.<action>"` (qualified id), optional `description`. Other types:
`shell`, `pane`, `popup`. User config is never rewritten by plugins —
bindings are opt-in per user.

**Remote / SSH / WSL**: plugin commands run on the **herdr server host**
inside a real PTY pane (post-v0.9.0 the TUI shell renders client-side but
the server owns panes/PTYs — `207be3c7` "render the shell in the client",
first tagged v0.9.0). Over SSH attach or WSL, `plugin.pane.open` executed
through `HERDR_BIN_PATH`/the session socket opens the pane **on the remote
server**, which is exactly where the plugin and its state live. No
DISPLAY/browser is involved. The socket transport differs by OS (Unix
socket vs Windows named pipe) but `HERDR_BIN_PATH` CLI calls are portable
(`plugins.mdx` "Commands and environment").

**Windows**: action/event commands resolve `PATHEXT` shims (`npm.cmd`,
`bun.cmd`); pane commands use herdr's normal Windows pane launcher
(`plugins.mdx` "On Windows"). Plugin pane launch path resolution on Windows
was fixed in `6f57f2f6`, first tagged **v0.9.0**.

**Version availability summary** (from `git tag --contains` on the herdr
repo):

| capability | first release |
| --- | --- |
| plugin v1 system (`[[actions]]`, `[[events]]`, `[[panes]]` overlay/split/tab/zoomed, `plugin.action.*`, `plugin.pane.*`) | v0.7.0 (`fbd20ad6`) |
| `placement = "popup"` | v0.7.4 (`2c7c8beb`) |
| plugin state global across sessions | v0.8.0 (`69d07dba`) |
| server-owned runtime / client-rendered shell, Windows plugin pane launch fix | v0.9.0 (`207be3c7`, `6f57f2f6`) |

All 14 `herdr-plugins` already declare `min_herdr_version = "0.9.0"`, which
covers the full TUI surface including popup and the Windows fixes. **No
manifest change to `min_herdr_version` is required.**

**Documented-only / absent in 0.9.5**:

- No non-terminal/native UI widget API — panes are real terminals only.
- No dynamic action registration at runtime — the action/pane list is fixed
  at manifest parse; discovery is via `plugin.action.list` /
  `plugin.pane.open` against declared entrypoints.
- `agent.view` remains a single-slot per-source projection
  (`socket-api.mdx` ~line 386-443); not used by this design (ADR-0004
  already deferred it).
- Popup is a **session singleton**: only one popup per herdr session; a
  second `plugin.pane.open` with `placement=popup` fails `ui_busy`. It is
  server-session state, so over a shared/attached session a popup opened by
  one client is visible session-wide — recorded as a design constraint,
  not a blocker (split/tab/zoomed are the multi-instance path).
- No upstream "structured approval dialog" primitive; dialogs must be
  built inside the plugin pane (existing upstream gap, tracked under
  attention-granularity / controls ADR-0019).

## Decision

1. **Primary TUI path = manifest `[[panes]]` entrypoint + `[[actions]]`
   trigger.** Each plugin that gains an interactive surface declares pane
   entrypoint(s) running `bun run <tui-entry>.ts` inside the plugin
   checkout. A same-named (or dedicated `open`/`ui`) `[[action]]` invokes
   `plugin.pane.open` through `HERDR_BIN_PATH` so keybinds, command palettes,
   and other plugins can open the UI without knowing pane internals.
   Rationale: it is the only herdr-supported way to render an interactive
   terminal UI; actions alone cannot render; CLI JSON output is not a TUI.
2. **Placement policy**: declare `placement = "popup"` for compact,
   transient, single-instance surfaces (pickers, confirmations, quick
   views) and rely on `overlay`/`split`/`tab`/`zoomed` for workspace-scale
   browsers. Because popup is a session singleton with no pane ID, the
   **default recommended placement for primary plugin workspaces is
   `tab` or `split`**, with `popup` reserved for auxiliary pickers — this
   keeps concurrent use across plugins possible and preserves pane
   identity for `plugin.pane.focus/close`.
3. **Origin identity is pinned at launch, never re-derived inside the
   UI.** The launching action/pane-open call captures the origin
   `PluginInvocationContext` (workspace/tab/focused pane/agent/worktree)
   plus a fresh correlation id and passes it to the UI process via
   `HERDR_PLUGIN_CONTEXT_JSON` (automatic) and explicit `env` params
   (e.g. `HERDR_TUI_TARGET_*`) on `plugin.pane.open`. The UI treats that
   snapshot as the operation target; it must re-validate liveness
   (pane exists, agent_session/generation unchanged) through the public
   socket/CLI before mutating, per the existing stale-generation
   discipline. The UI pane's own `HERDR_PANE_ID` (when present) is the
   *surface* identity — used only for self-management (focus, close) —
   and is never confused with the target identity. Popup UIs have no
   pane ID, so all target identity flows through the pinned context.
4. **Fallbacks for older herdr**: `min_herdr_version = "0.9.0"` already
   guarantees popup + all placements + Windows fixes, so no runtime
   fallback matrix is required today. If the floor is ever lowered,
   `plugin.pane.open` placement override (`overlay`/`split`/`tab`/`zoomed`
   all exist since v0.7.0) is the degradation path; the launcher detects
   `ui_busy`/unknown-placement errors and reports them honestly rather
   than silently downgrading.
5. **Remote/WSL/SSH**: TUI panes are opened through `HERDR_BIN_PATH` on
   the session's own socket, so they always materialize on the host that
   owns the herdr session — correct for SSH/WSL where the plugin and its
   state live server-side. No client-side assumptions.
6. **Actions stay non-interactive**: `[[actions]]` remain the
   keyboard/palette/CLI-triggerable verbs (open UI, or run a headless
   operation). Interactive work happens inside the pane process, which
   talks back to herdr exclusively through `HERDR_BIN_PATH`/socket —
   the same public contract CLI/MCP/GUI consumers use.

## Consequences

- Every plugin TUI is a real terminal process: it inherits herdr's PTY,
  scrollback, resize, and detach/reattach semantics for free, and works
  identically over SSH/WSL/Windows Terminal without a GUI.
- Popup's missing pane ID and session-singleton nature are accepted
  constraints; multi-instance and identity-sensitive surfaces use
  pane-backed placements.
- `plugin.action.invoke`'s 64 KiB/32-in-flight background model means
  "open UI" actions must return quickly; the UI process is the pane
  command, not the action command.
- Upstream gaps recorded for future tracking: no runtime action
  registration, no non-terminal UI primitive, no structured dialog
  primitive, single-slot `agent.view` (unchanged from ADR-0004).
