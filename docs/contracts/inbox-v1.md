# Contract: `herdr-plugins.inbox/v1`

Versioned structured interface for the `rebuildup.inbox` plugin. External
clients (herdr-t3, agents, scripts) MUST depend only on this contract, never
on the plugin's internal state file format.

## Invocation and discovery

The plugin is installed through the official herdr plugin mechanism:

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/inbox
# pre-release / pinned: herdr plugin install rebuildup/herdr-plugins/plugins/inbox --ref <branch|tag|sha>
# development: herdr plugin link <repo>/plugins/inbox
```

The default ref is the repository's default branch; before the first release
merge, pass `--ref release-0-1-0` (or a commit SHA) explicitly.

An external client resolves the CLI as follows:

1. `herdr plugin list` (or the plugin registry) → installed plugin entry
   with `plugin_root` (managed checkout `…/checkout/plugins/inbox`, or the
   linked directory).
2. Run `<plugin_root>/src/cli.ts` with `bun run` from any cwd — imports are
   relative and self-contained within the checkout.
3. Alternatively invoke manifest actions (`settle`/`restore`/`snooze`) via
   `plugin.action.invoke` for focused-pane operations without arguments.

`capability` returns machine-readable discovery:

```json
{
  "contract": "herdr-plugins.inbox/v1",
  "plugin": "rebuildup.inbox",
  "version": "0.1.0",
  "commands": ["list", "settle", "snooze", "restore", "reconcile", "watch", "capability"],
  "actions": ["settle", "restore", "snooze"],
  "events": ["pane.agent_status_changed", "pane.closed"],
  "startup": ["reconcile"],
  "state_file": "…",
  "socket": null
}
```

## Target selection (Host / Session)

The CLI always talks to **the herdr server owning the socket it resolves**.
Resolution order:

1. `--socket PATH` (explicit; local socket path — see Remote hosts)
2. `HERDR_SOCKET_PATH`
3. `--session NAME` / `HERDR_SESSION` → `<config>/sessions/<name>/herdr.sock`
4. default session socket `<config>/herdr.sock`

Operating-system rules match herdr: unix socket on macOS/Linux, named pipe
`\\.\pipe\<path>` on Windows (handled inside the client).

**Remote hosts**: the socket API is local-only (unix socket / named pipe),
and plugin hooks, actions, and durable state always live on the herdr host.
The supported way to operate a remote herdr host is to run this CLI **on
that host** — locally in a shell, via the user's existing SSH/device routes,
or through `herdr --remote` / `herdr --machine` when the client supports
remote command execution. The CLI itself adds no remote transport, and
`--socket`/`HERDR_SOCKET_PATH` are intended for local sockets only.

Operating a remote host through a forwarded socket (`ssh -L`, `socat`) is
**not a supported path**: the state file is host-local, so a local CLI
pointed at a forwarded remote socket would resolve a separate organize
namespace keyed by the forwarded path — invisible to the remote plugin's
hooks and metadata projection, and split from the state the remote plugin
actually owns. Clients that need remote inbox data must execute the CLI on
the target host (or consume `watch` output relayed from it). `--session`
must name a session that exists **on the target host**; session names are
not globally unique.

## Commands

| Command | Args | Description |
| --- | --- | --- |
| `list` | — | Inbox snapshot (below). |
| `settle` | `pane_id?` | Hide pane until generation change. |
| `snooze` | `pane_id? --until <spec>` | Hide pane until deadline; early wake on generation change. |
| `restore` | `pane_id?` | Clear organize state. |
| `reconcile` | — | Resolve expirations/generation changes, prune stale entries, repair metadata. |
| `watch` | `--interval SEC` | JSONL event stream + periodic reconcile (below). |
| `capability` | — | Discovery document (above). |

Global flags (after the command): `--session NAME`, `--socket PATH`,
`--timeout MS` (per-request timeout, default 10000).

`--until` accepts ISO 8601, `+30m`/`+2h`/`+1d`, or bare `30m`. Without
`--until`, `snooze` reads `defaultSnooze` from the plugin config dir's
`config.json` (used by the manifest `snooze` action, which takes no args).

## Output contract

- Success: exactly one JSON document on stdout (pretty-printed, except
  `watch` which is JSONL — one compact object per line).
- Failure: one JSON object on **stderr**,
  `{"contract","ok":false,"error":{"code":"usage"|"error","message"}}`,
  plus exit code `2` (usage) or `1` (handled error). Socket/transport
  failures are errors — never an empty inbox.
- `pane_id` may be omitted when `HERDR_PANE_ID` or
  `HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id` is set (manifest actions,
  event-hook contexts).

## `list` output

```json
{
  "contract": "herdr-plugins.inbox/v1",
  "generated_at": "2026-01-10T12:00:00.000Z",
  "session": { "name": "default", "socket": null },
  "state_file": "/abs/path/state.json",
  "counts": { "total": 0, "inbox": 0, "attention": 0, "organized": 0 },
  "items": [ { "pane_id": "…", "…": "…" } ]
}
```

`session.name`/`session.socket` echo the resolved target (explicit flag or
env); they are `null` when the default socket was used implicitly. Item
fields and `organize`/`attention`/`in_inbox` semantics are unchanged from
v1 draft: `organize.kind` is `settled`|`snoozed` (`until` on snoozed),
`attention` (`blocked`) forces `in_inbox: true`, and items for panes absent
from the snapshot carry only identity/organize fields with
`in_inbox: false`.

## Organize/mutate output

`settle`/`snooze`/`restore` emit `{contract, command, pane_id,
agent_status, state_change_seq, organize, warnings}`; `organize` is `null`
after `restore`. `warnings` lists non-fatal issues (e.g. metadata
projection failure) — the state mutation itself already succeeded; a later
`reconcile`/`watch` repairs projections.

## `reconcile` output

```json
{
  "contract": "herdr-plugins.inbox/v1",
  "command": "reconcile",
  "resolved_at": "…",
  "cleared": ["pane-id"],
  "pruned": ["pane-id"],
  "projected": ["pane-id"],
  "warnings": []
}
```

- `cleared`: organize marks removed by expiry/generation/identity resolution.
- `pruned`: state entries dropped because their pane has been absent from
  the snapshot beyond the retention window (24h) or the entry cap (500).
- `projected`: panes whose metadata tokens were (re)written this pass —
  organized panes get `inbox_state`/`inbox_snoozed_until`, cleared panes get
  tokens cleared. Re-running `reconcile` is the repair path for any
  partial projection failure.

## `watch` output and stop conditions

JSONL on stdout:

- `{"contract","type":"watch.started","at"}` once subscribed.
- `{"contract","type":"watch.reconcile","trigger":"event"|"interval",
  "event"?, "resolved_at","cleared","pruned","projected","warnings"}` per
  pass — on every `pane.agent_status_changed` subscription event and every
  `--interval` seconds (default 60).
- `{"contract","type":"watch.error","trigger","error"}` on a failed pass
  (watch keeps running).
- `{"contract","type":"watch.stopped","reason","at"}` on exit;
  `reason` is `signal` (SIGINT/SIGTERM, exit 0) or `stream_end`
  (subscription closed unexpectedly, exit 1).

`watch` is opt-in; nothing resident runs by default. Snooze expiry is
resolved lazily at every read anyway, so contract clients never observe a
stale "snoozed" state. Independently, each `snooze` detaches a one-shot
`_wake` process (internal, not part of this contract) that sleeps until the
deadline and runs one reconcile — this keeps pane metadata tokens fresh on
the herdr host without user action (ADR-0005). `watch`/startup reconcile
remain the repair paths for any missed wake.

## State and config locations

- State: `<plugin state dir>/state.json` — `HERDR_PLUGIN_STATE_DIR` under
  plugin runtime; `<state-herdr>/plugins/rebuildup.inbox/state.json` for
  external clients (`~/.local/state/herdr/...`, `$XDG_STATE_HOME` aware).
  Schema v2 namespaces entries per `hostname + canonical socket path`;
  organize state never crosses sessions or hosts.
- Config: `<plugin config dir>/config.json` (`defaultSnooze`).
- Updates preserve both: they live outside the installed checkout.

## Versioning

`contract` is semver-ish `herdr-plugins.inbox/vN`. Additive optional fields
may appear within v1; breaking changes bump the version and clients must
feature-detect via `capability`/`contract`.
