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
  "version": "0.4.0",
  "commands": [
    "list", "settle", "snooze", "restore",
    "pin", "unpin", "archive", "unarchive", "order",
    "link", "unlink", "links",
    "reconcile", "transitions", "watch", "capability"
  ],
  "actions": ["settle", "restore", "snooze", "pin", "unpin", "archive", "unarchive"],
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
| `list` | `[--attention] [--organize K] [--search T] [--workspace ID]` | Inbox snapshot (below); filters are read-side only. |
| `settle` | `pane_id?` | Hide pane until generation change. |
| `snooze` | `pane_id? --until <spec>` | Hide pane until deadline; early wake on generation change. |
| `restore` | `pane_id?` | Clear all organize state (marks, pin, order). |
| `pin` | `pane_id?` | Mark pane pinned: sorts at the top of the inbox. Never hides. |
| `unpin` | `pane_id?` | Clear the pin mark. |
| `archive` | `pane_id?` | Hide pane as archived until generation change/attention/`unarchive`. Never touches the agent or pane. |
| `unarchive` | `pane_id?` | Clear the archive mark; other organize state is kept. |
| `order` | `pane_id? --first\|--last\|--before <pane>\|--after <pane>` | Set manual order rank within the pane's display group. |
| `link` | `pane_id? --pr <repo>#<n>` or `--issue <repo>#<n>` `[--verify]` | Declare a user-owned tracker link on the pane. |
| `unlink` | `pane_id? --pr <repo>#<n>` or `--issue <repo>#<n>` | Remove one declared link. |
| `links` | `pane_id?` | Read the pane's declared links (staleness resolved). |
| `reconcile` | — | Resolve expirations/generation changes, prune stale entries, repair metadata. |
| `transitions` | `--after <seq>` `--limit <n>` | Read-only page over the per-session organize-transition log (below). |
| `watch` | `--interval SEC` | JSONL event stream + periodic reconcile (below). |
| `capability` | — | Discovery document (above). |

Global flags (after the command): `--session NAME`, `--socket PATH`,
`--timeout MS` (per-request timeout, default 10000).

`--until` accepts ISO 8601, `+30m`/`+2h`/`+1d`, or bare `30m`. Without
`--until`, `snooze` reads `defaultSnooze` from the plugin config dir's
`config.json` (used by the manifest `snooze` action, which takes no args).

`order` requires exactly one placement flag. Ordering is scoped to the
moved pane's display group — items sharing its `attention` and `pinned`
flags — because `list` sorts by those flags before `order`. The reference
pane of `--before`/`--after` must be a visible inbox item in the same
group; hidden panes cannot be ordered (restore/unarchive first).

`list` filters combine freely and never mutate state:

- `--attention` — only items with `attention: true`.
- `--organize settled|snoozed|archived|none` — items whose `organize.kind`
  matches; `none` selects items with no hide-kind mark (pin/order do not
  count). Hidden items remain visible to filters — filtering does not
  change `in_inbox`.
- `--search <text>` — case-insensitive substring over `title`, `cwd`, and
  `pane_id`.
- `--workspace <id>` — exact `workspace_id` match.

## Tracker links (`link` / `unlink` / `links`)

`link`/`unlink`/`links` manage **user-declared** associations between a
pane and a known forge item (`<repo>#<n>`, repo = `owner/name` or a deeper
forge path). They are explicit references stored in plugin state — never
derived from forge events (no webhook/auto-linking; PR-update attention
restore is a separate concern). `link` requires the pane to exist in the
session snapshot; re-linking the same `kind+repo+number` re-stamps the
identity fingerprint and is the explicit re-validation path. `--verify`
additionally runs `gh <kind> view` as an opt-in existence check; any
failure (offline, unauthenticated, not found) is reported in `warnings`
and the link is still recorded.

Links follow the same identity discipline as organize marks **minus timed
expiry**: they survive routine `state_change_seq` advances (status
transitions — a link describes work, not a transient status) but are
dropped when the `agent_session` fingerprint changes or the recorded seq
regresses (pane/agent identity recycled), on `pane.closed`, and by
retention pruning. `restore` clears organize state but preserves links.

`link` emits `{contract, command:"link", pane_id, link, links, warnings}`;
`unlink` emits `{contract, command:"unlink", pane_id, removed, links,
warnings}` (`removed` is the public link view); `links` emits
`{contract, command:"links", pane_id, links, warnings}`. All three use
only `session.snapshot` — no metadata projection, no execution surfaces.

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
  "filters": { "attention": false, "organize": null, "search": null, "workspace": null },
  "counts": { "total": 0, "inbox": 0, "attention": 0, "organized": 0, "pinned": 0, "archived": 0, "linked": 0 },
  "items": [ { "pane_id": "…", "…": "…" } ]
}
```

`session.name`/`session.socket` echo the resolved target (explicit flag or
env); they are `null` when the default socket was used implicitly.
`filters` echoes the effective filter set (`null`/`false` = unset).

`counts` fields (all additive within v1) describe the **emitted**
(post-filter) items: `total` items reported, `inbox` items with
`in_inbox: true`, `attention` items flagged `attention: true`, `organized`
items carrying any hide-kind (`settled`/`snoozed`/`archived`), `pinned`
items with a live pin, `archived` items whose `organize.kind` is
`archived`, `linked` items carrying at least one tracker link.

Item fields: `organize` is `{kind, since, until?}` where `kind` is
`settled` | `snoozed` | `archived` (`until` on snoozed only); `pinned` is
a boolean; `order` is a number rank or absent; `links` is an array
(possibly empty) of `{kind, repo, number, ref, at}` — `kind` is `pr` |
`issue`, `ref` is the canonical `<repo>#<number>` display string, `at` the
ISO declaration time. `attention` (`blocked`) forces `in_inbox: true`
regardless of marks, and items for panes absent from the snapshot carry
only identity/organize/link fields with `in_inbox: false` (absent-pane
items are reported when they carry an organize view **or** links).

`items` sort order: `pinned` first, then `attention`, then `order`
ascending (items without `order` sort after ordered ones), then `pane_id`.
`order` is a layout hint only — it never hides an item and is not
generation-guarded; it is cleared by `restore`, `pane.closed`, and
retention pruning like every other organize field.

## Organize/mutate output

`settle`/`snooze`/`restore`/`pin`/`unpin`/`archive`/`unarchive` emit
`{contract, command, pane_id, agent_status, state_change_seq, organize,
pinned, order, warnings}`; `organize` is `null` when no hide-kind mark
survives (`archived` is a hide-kind and appears here), `pinned`/`order`
echo the pane's surviving pin mark and order rank. `order` emits
`{contract, command, pane_id, order, placement, warnings}` where
`placement` echoes the requested placement. `warnings` lists non-fatal
issues (e.g. metadata projection failure) — the state mutation itself
already succeeded; a later `reconcile`/`watch` repairs projections.
`restore` preserves declared tracker links (see Tracker links).

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
  organized panes get `inbox_state`/`inbox_snoozed_until`/`inbox_pinned`,
  cleared panes get tokens cleared. Re-running `reconcile` is the repair
  path for any partial projection failure.

## `transitions` output (ADR-0029, #182)

Inbox records every real organize transition in a per-session log inside
the plugin state file (`transitions` key — internal, not part of this
contract). `transitions` is the read-only drain surface external consumers
use to observe settle/restore/clear activity; it never fabricates herdr
events and never exposes the state file directly.

```json
{
  "contract": "herdr-plugins.inbox/v1",
  "command": "transitions",
  "generated_at": "…",
  "session_key": "hostname:socket-path",
  "head_seq": 42,
  "oldest_seq": 7,
  "dropped": 3,
  "transitions": [ { "seq": 8, "…": "…" } ]
}
```

- `session_key` echoes the session namespace the page belongs to.
- `head_seq` is the per-session monotonic head (0 when no log exists);
  `oldest_seq` is the smallest retained `seq` (`null` when empty); `dropped`
  counts transitions evicted by the 500-per-session retention cap. A
  consumer whose stored cursor is below `oldest_seq`/`seq - dropped`
  window MUST treat it as expired — transitions were lost — rather than
  assume a gapless history.
- `transitions` items carry `{seq, at, kind, pane_id}` plus context fields
  captured from the same snapshot the mutating command already loaded:
  `workspace_id`, `cwd`, `agent_status`, `state_change_seq`,
  `agent_session` (fingerprint or `null`). `kind` is `settled` | `snoozed`
  | `restored` | `cleared`; `cleared` items add `cause`:
  `expired` | `generation` | `session_mismatch` | `pane_closed` | `pruned`.
- Flags: `--after <seq>` is an **exclusive** cursor (only `seq > after`);
  omit it to read the newest page (`--limit`, default 200, max 500). A
  consumer drains by storing `head_seq` after each batch; replaying a
  partially-processed batch is safe because `seq` is unique per session.
- `transitions` is read-only: expiry/generation resolution is the same
  deterministic in-memory path as `list`; nothing is persisted that `list`
  would not already resolve identically. Pin/order changes are layout
  hints and do **not** produce transitions.

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
and new command names may appear within v1 — including new `organize.kind`
values (`archived` was added this way; consumers must tolerate unknown
kinds). Breaking changes bump the version and clients must feature-detect
via `capability`/`contract`.
