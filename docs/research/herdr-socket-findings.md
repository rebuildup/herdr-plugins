# Research: herdr socket API findings (verified live, v0.9.5 / protocol 22)

Verified against a disposable named session (`herdr server` headless +
`HERDR_SESSION`), not just docs. These details correct assumptions that doc
reading alone gets wrong.

## Response envelopes

- Every method returns `{ "type": "<method_snake>", ...payload }`.
- `session.snapshot` → `{type:"session_snapshot", snapshot:{...}}`; unwrap
  `.snapshot`.
- `agent.list` / `agent.get` → `{type:"agent_list"|"agent_info", agents|agent}`.
- Success-only methods return `{type:"ok"}`.

## `session.snapshot().snapshot` shape

- `agents` is an **array** of agent entries (not a map). Each entry carries
  `pane_id`, `agent` (name string), `agent_status`, `state_change_seq`,
  `completion_seq`, `revision`, `cwd`, `foreground_cwd`, `tokens`,
  `state_labels`, `terminal_title_stripped`, `focused`, and optionally
  `agent_session: {source, agent, kind, value}`.
- `agent_status` values observed/declared: `idle`, `working`, `blocked`,
  `done`, `unknown`.
- `state_change_seq` bumps on **status transitions**, not on every
  `pane.report_agent` call: re-reporting the same state does not advance it.
- `agent_session` was not populated by `pane.report_agent_session` with
  `agent_session_id` in this test; it appears for real agent integrations.
  Plugins must treat it as optional (fingerprint falls back to seq).

## `pane.report_agent` semantics

- Params: `pane_id`, `source`, `agent`, `state` (`idle|working|blocked|unknown`),
  optional `seq`, `agent_session_id`, `agent_session_path`, `message`,
  `resume_argv`.
- Reporting authority is per-`source`; multiple sources can coexist.
- `done` is not a reportable `PaneAgentState`; it derives from completion
  transitions (`completion_seq`).

## `pane.report_metadata`

- Required: `pane_id`, `source`. Optional: `agent`, `tokens`
  (`Record<key, string|null>`), `seq` (u64, per-source ordering), `ttl_ms`,
  `title`, `state_labels`, etc.
- Token keys: ASCII alphanumeric + `_`/`-` only (**no dots**); max length
  bounded. Empty/blank values clear the token (`null` also clears).
- Verified live: `tokens: {inbox_state: "settled"}` shows up in `pane.get`.

## Plugin command environment (from `src/app/api/plugins/runtime.rs`)

- `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`,
  `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONTEXT_JSON`,
  `HERDR_PLUGIN_ACTION_ID` (actions), `HERDR_PLUGIN_EVENT` +
  `HERDR_PLUGIN_EVENT_JSON` (event hooks), `HERDR_WORKSPACE_ID`,
  `HERDR_TAB_ID`, `HERDR_PANE_ID` (context), `HERDR_BIN_PATH`,
  `HERDR_SOCKET_PATH`, `HERDR_ENV=1`.
- cwd = plugin root (`checkout/plugins/<name>` for managed installs; the
  whole repo checkout is present, so `../../..`-relative imports into
  `packages/` resolve).
- `plugin.action.invoke` accepts only `action_id` + `context` — **no
  free-form args**. Parameterized operations must go through the plugin's
  own CLI, not manifest actions.
- Event hook JSON: `{event, data:{type, pane_id, agent_status, ...}}`;
  `pane.agent_status_changed` data carries only `pane_id` + `agent_status`
  (no seq) — hooks must re-read the snapshot for generation signals.

## Headless testing

`herdr server` runs headless and honors `HERDR_SESSION=<name>`; the socket
appears at `$XDG_CONFIG_HOME/herdr/sessions/<name>/herdr.sock`. This avoids
needing a nested TUI for API-level verification. Use isolated
`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`HERDR_CONFIG_PATH` (with
`[experimental] allow_nested` only when a TUI is required).
