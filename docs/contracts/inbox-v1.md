# Contract: `herdr-plugins.inbox/v1`

Versioned structured interface for the `rebuildup.inbox` plugin. External
clients (herdr-t3, agents, scripts) MUST depend only on this contract, never
on the plugin's internal state file format.

## Invocation

```bash
<plugin-cli> <command> [--session NAME] [--socket PATH] [--timeout MS]
```

- `<plugin-cli>` resolves to `bun run src/cli.ts` inside the plugin root for
  development, or the manifest action/hook context (`HERDR_PANE_ID`,
  `HERDR_PLUGIN_CONTEXT_JSON`) for TUI actions.
- All commands print exactly one JSON document to stdout. Diagnostics go to
  stderr. Exit codes: `0` success, `1` handled error, `2` usage error.

## Commands

| Command | Args | Description |
| --- | --- | --- |
| `list` | — | Inbox snapshot (below). |
| `settle` | `pane_id?` | Hide pane until generation change. |
| `snooze` | `pane_id? --until <spec>` | Hide pane until deadline; early wake on generation change. |
| `restore` | `pane_id?` | Clear organize state. |
| `reconcile` | — | Materialize expirations/generation changes against live snapshot. |
| `watch` | `--interval SEC` | Long-running reconcile on agent events + interval. |
| `capability` | — | Machine-readable capability discovery. |

`--until` accepts ISO 8601, `+30m`/`+2h`/`+1d`, or bare `30m`. Without
`--until`, `snooze` reads `defaultSnooze` from the plugin config dir's
`config.json`.

## `list` output

```json
{
  "contract": "herdr-plugins.inbox/v1",
  "generated_at": "2026-01-10T12:00:00.000Z",
  "session": { "name": "..." },
  "state_file": "/abs/path/state.json",
  "counts": { "total": 0, "inbox": 0, "attention": 0, "organized": 0 },
  "items": [
    {
      "pane_id": "pane-1",
      "workspace_id": "ws-1",
      "tab_id": "tab-1",
      "title": "agent title",
      "cwd": "/path",
      "agent_status": "done",
      "state_change_seq": 42,
      "agent_session": { "agent": "claude", "kind": "session", "value": "..." },
      "organize": { "kind": "settled", "since": "..." },
      "attention": false,
      "in_inbox": false
    }
  ]
}
```

- `organize` is absent when the pane is not organized. `kind` is `settled`
  or `snoozed`; snoozed adds `until` (ISO 8601).
- `attention` is true when herdr reports a status that requires user
  attention (`blocked`). Attention items are ALWAYS `in_inbox: true` —
  organize state never hides them.
- `in_inbox` is false only when organize state hides a non-attention pane.
- Items for panes missing from the live snapshot may appear with only
  `pane_id`/`organize`/`in_inbox:false` (retained organize state for closed
  panes); clients must not treat them as live work.

## Organize/mutate output

`settle`/`snooze`/`restore` emit:

```json
{
  "contract": "herdr-plugins.inbox/v1",
  "command": "settle",
  "pane_id": "pane-1",
  "agent_status": "done",
  "state_change_seq": 42,
  "organize": { "kind": "settled", "since": "..." },
  "warnings": []
}
```

`organize` is `null` after `restore`. `warnings` carries non-fatal issues
(e.g. metadata projection failure) — never treat warnings as success/failure
of the state mutation itself; check `organize`.

## Error contract

Handled errors print `inbox: <message>` to stderr with exit 1; usage errors
exit 2. Unsupported/disconnected herdr surfaces as a socket error, never as
an empty inbox. There is no "success" response for a pane that does not
exist in the session snapshot (`pane not found`).

## Session selection

`--session NAME` selects a named herdr session
(`~/.config/herdr/sessions/<name>/herdr.sock`). `--socket PATH` overrides
everything. `HERDR_SOCKET_PATH` / `HERDR_SESSION` are honored when flags are
absent — matching herdr's own precedence.
