# Spike evidence — herdr 0.9.5 pane execution API (Issue #52)

Live verification of the official Socket API surface needed for
project-script execution, run against an **isolated headless session**
(`--session spike`, dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/
`HERDR_CONFIG_PATH` under `/var/tmp/herdr-spike`). The user's live
sessions were never touched; the spike server was stopped afterward.

Wire protocol confirmed: newline-delimited JSON over the Unix socket,
`{"id","method","params"}` → `{"id","result"|"error"}`; one request per
connection (subscribe is the exception). Schema dump:
`herdr api schema` → protocol 22, 102 request variants.

## Method availability (all verified live)

| Method | Params of note | Result |
| --- | --- | --- |
| `workspace.create` | `cwd?`, `label?`, `env?`, `focus?` | `workspace_created` → `{workspace, tab, root_pane}` — cheapest dedicated execution surface |
| `tab.create` | `workspace_id?`, `cwd?`, `env?` | `tab_created` → `{tab, root_pane}` |
| `pane.split` | `direction` (required), `target_pane_id?`, `cwd?`, `env?` | `pane_info`; `cwd`/`env` honored (verified env var + cwd in `process_info`) |
| `pane.send_text` | `pane_id`, `text` | literal text, **no Enter** |
| `pane.send_input` | `pane_id`, `text?`, `keys?[]` | `text`+`keys:["Enter"]` executes a command; key names `Enter`/`ctrl+c` accepted |
| `pane.send_keys` | `pane_id`, `keys[]` | keys only |
| `pane.close` | `pane_id` | `pane_closed` event |
| `pane.process_info` | `pane_id?` | `{shell_pid, foreground_process_group_id, foreground_processes[]}` — foreground ≠ shell ⇒ command running |
| `pane.wait_for_output` | `pane_id`, `source`, `match{type,value}`, `timeout_ms?` | server-side block; match → `output_matched`; timeout → structured `timeout` error |
| `events.subscribe` | `subscriptions[]` | ack `subscription_started`, then `{event,data}` pushes |
| `plugin.pane.open` | `plugin_id`, `entrypoint`, `placement?`, `cwd?` | manifest `[[panes]]` entrypoints only — not arbitrary commands |

Also present: `pane.read/get/list/current`, `agent.start/list/get/prompt/wait`,
`events.wait`, `pane.report_metadata`, `command.invoke`.

## Key findings

1. **No `command`/`argv` param on pane creation.** `workspace.create`,
   `tab.create`, `pane.split` always start a shell; commands are injected
   via `pane.send_input`. The only direct-exec path is `plugin.pane.open`,
   bound to manifest-declared entrypoints — unsuitable for arbitrary
   project scripts.
2. **Input echo defeats naive sentinels.** `wait_for_output` matches
   scrollback including the echoed command line; a literal marker in the
   command matches immediately. Markers must be output-only — e.g.
   `echo MARK$((6*7))` matched `MARK42` only after the command ran
   (verified ~3 s block). Exit status requires the script to echo `$?`
   itself: `cmd; echo "__DONE__=$?"` + regex `__DONE__=(-?\d+)` (the
   echoed `__DONE__=$?` does not match the digit pattern).
3. **Completion detection:** `pane.wait_for_output` returns the matched
   line + full pane read; `pane.process_info` distinguishes foreground
   command vs idle shell (no exit status exposed). Shell `exit` →
   `pane_exited` + pane gone; explicit `pane.close` → `pane_closed`.
4. **Ownership:** socket-created panes carry no ownership token — any
   socket client can send input to any pane. The plugin must persist
   `pane_id`s it created (IDs are never reused) and re-`pane.get` before
   acting. `plugin.pane.*` close/focus enforce ownership server-side but
   only for plugin panes.
5. **Agent vs shell:** plain shell panes have no `agent` entry in
   `agent.list`/snapshot; agent panes are distinguishable — relevant to
   the "never inject into panes already in use" rule.
6. **Event-name casing is inconsistent:** lifecycle events are
   snake_case (`pane_created`, `pane_closed`, `pane_exited`), agent
   events dotted (`pane.agent_status_changed`, data under
   `pane_agent_detected`). Clients must normalize.
7. **Subscription types (27)** cover workspace/tab/pane lifecycle plus
   `pane.agent_detected`, `pane.agent_status_changed`,
   `pane.output_matched` (per-pane match subscriptions),
   `pane.scroll_changed`, `layout.updated` — sufficient surface for
   #53's stop/results and possible auto-trigger approximations
   (`worktree.*`, `pane_exited`).

## CLI equivalents

`herdr --session <name> workspace|tab|pane …` mirrors the socket surface
(`pane run` = `send_input` text+Enter; `pane wait-output`,
`pane process-info`, `plugin pane open`). `HERDR_SESSION` did not
retarget the CLI in testing — pass `--session` or `HERDR_SOCKET_PATH`.

## Reproduction artifacts

`/var/tmp/herdr-spike/`: `schema.json` (full API schema), `rpc.py`
(socket helper), `sub2.py` (subscribe test), `testplugin/` (manifest
pane fixture), herdr server log. Ephemeral — regenerate via
`herdr api schema` on herdr ≥ 0.9.5 if needed.

## Conclusion

Pane-based execution is **feasible on herdr 0.9.5 today** with thin
client wrappers; residual gaps (no argv at creation, no exit-status
channel, no ownership token, event casing) are documented in ADR-0010
and recorded as upstream issue candidates, not blockers.
