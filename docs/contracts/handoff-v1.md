# Contract: `herdr-plugins.handoff/v1`

Versioned structured interface for the `rebuildup.handoff` plugin —
handoff/delegation records that bind a source pane/agent generation to a
payload of **references** (never transcript copies) plus a status
lifecycle. External clients (herdr-t3, agents, scripts) MUST depend only
on this contract, never on the plugin's internal state file format.

T1 scope (issue #103): `create` / `list` / `status` / `capability`.
Execution commands (`execute`, status transitions) are T2 (#104) and will
extend this contract additively within v1 where possible.

## Invocation and discovery

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/handoff
# pre-release / pinned: herdr plugin install rebuildup/herdr-plugins/plugins/handoff --ref <branch|tag|sha>
# development: herdr plugin link <repo>/plugins/handoff
```

An external client resolves the CLI as follows:

1. `herdr plugin list` → installed plugin entry with `plugin_root`.
2. Run `<plugin_root>/src/cli.ts` with `bun run` from any cwd.
3. `capability` returns machine-readable discovery:

```json
{
  "contract": "herdr-plugins.handoff/v1",
  "plugin": "rebuildup.handoff",
  "version": "0.1.0",
  "commands": ["create", "list", "status", "capability"],
  "actions": [],
  "events": [],
  "startup": [],
  "state_file": "…",
  "config_dir": "…",
  "socket": null,
  "execution": "not_implemented",
  "limits": {
    "max_excerpt_chars": 8192,
    "max_payload_refs": 32,
    "max_requirements": 32
  }
}
```

`execution: "not_implemented"` is explicit: T1 records intent only and
never creates panes, starts agents, or mutates herdr execution state.

## Target selection (Host / Session)

Same socket resolution as `herdr-plugins.inbox/v1`:

1. `--socket PATH`
2. `HERDR_SOCKET_PATH`
3. `--session NAME` / `HERDR_SESSION` → `<config>/sessions/<name>/herdr.sock`
4. default session socket `<config>/herdr.sock`

`create` **requires** a reachable snapshot (the source identity is read
from it); an unreachable socket is a handled error, never a fabricated
record. `list`/`status` degrade honestly: an unreachable snapshot yields
`transfer_check.state = "unchecked"` with reason
`snapshot_unavailable` — records are still returned.

Remote hosts: same rule as inbox — run the CLI on the herdr host. Cross-
machine handoff is T3 (#105) and will extend `transfer.host` semantics.

## Commands

| Command | Args | Description |
| --- | --- | --- |
| `create` | `pane_id` + flags | Build payload, persist record (`--dry-run` previews without writing). |
| `list` | `--status S --limit N` | Enumerate records, newest first. |
| `status` | `handoff_id` | Full record + staleness + per-ref resolution. |
| `capability` | — | Discovery document (above). |

Global flags (after the command): `--session NAME`, `--socket PATH`,
`--timeout MS`.

### `create` flags

- `--strategy native_resume|portable_context|checkpoint_ref|manual`
  (default `portable_context`).
- `--provider <hint>` — opaque provider/route hint recorded on
  `target.provider_hint`. **Never resolved or validated by the plugin**;
  it may be an Agent Router route id (`harness.provider`) for the
  executor/human to honor (ADR-0017).
- `--note <text>` — bounded excerpt (≤ `max_excerpt_chars`, truncated
  with `truncated: true`).
- `--requirement <text>` (repeatable, ≤ 32 items, ≤ 500 chars each) —
  explicit requirements/spec pointers.
- `--conversation <key>` (repeatable, ≤ 32 refs total) — conversations
  index session key `<provider>:<session-id>`.
- `--checkpoint <id>` (repeatable) — checkpoints plugin entry id.
- `--external <value>` (repeatable) — uri/path/issue pointer; `target`
  is auto-classified (`scheme://` → `uri`, `#123` → `issue`, else
  `path`).
- `--target-pane <id>` / `--target-workspace <id>` — desired destination
  recorded as intent; nothing is created.
- `--dry-run` — emit the would-be record; write nothing.

## Handoff record schema

```json
{
  "contract": "herdr-plugins.handoff/v1",
  "id": "ho-m2x-1a2b3c4d",
  "created_at": "2026-02-01T00:00:00.000Z",
  "updated_at": "2026-02-01T00:00:00.000Z",
  "status": "pending",
  "strategy": "portable_context",
  "transfer": {
    "host": "macbook",
    "herdr_session": "default",
    "session_key": "macbook /Users/x/.config/herdr/herdr.sock",
    "workspace_id": "w1",
    "tab_id": "w1:t1",
    "pane_id": "w1:p1",
    "cwd": "/repo",
    "provider_kind": "claude",
    "agent_session": { "agent": "claude", "kind": "session", "value": "<uuid>" },
    "state_change_seq": 7
  },
  "target": { "provider_hint": "claude.openrouter" },
  "payload": {
    "refs": [
      { "kind": "conversation_session", "plugin": "rebuildup.conversations",
        "session_key": "claude:<uuid>", "event_refs": ["u-1"] },
      { "kind": "checkpoint", "plugin": "rebuildup.checkpoints", "id": "m2x-…" },
      { "kind": "external", "target": "uri", "value": "https://…" }
    ],
    "excerpt": { "text": "…", "truncated": false, "source": "note" },
    "requirements": ["…"]
  }
}
```

Field semantics:

- `transfer` — source identity, captured from `session.snapshot` at
  create time. `session_key` (`hostname + canonical socket path`) is the
  internal namespace discriminator; `herdr_session` is the display name
  (`null` for the implicit default socket). `agent_session` and
  `state_change_seq` are the generation signals; both may be `null`
  when the pane has no reported agent.
- `target` — `null` until a destination is hinted; `pane_id` /
  `workspace_id` / `provider_hint` are **recorded intent only**.
- `payload.refs` — discriminated union:
  - `conversation_session` → `rebuildup.conversations` session record
    key; optional `event_refs` select events (v1 verifies the session
    record only — event-level checks are consumer-side via
    `conversations show`).
  - `checkpoint` → `rebuildup.checkpoints` entry id.
  - `external` → `uri | path | issue` pointer, never fetched.
- `payload.excerpt` — bounded inline context (`source: "note"` in v1).
- `status` — `pending | ready | delivered | done | failed | superseded`.
  T1 only ever writes `pending`; later tickets drive transitions.
- `strategy` — `native_resume | portable_context | checkpoint_ref |
  manual` (T3 ContextHandoff strategies, simplified).

## `list` output

```json
{
  "contract": "herdr-plugins.handoff/v1",
  "command": "list",
  "total": 3,
  "count": 3,
  "truncated": false,
  "items": [
    {
      "id": "ho-…", "status": "pending", "strategy": "portable_context",
      "created_at": "…", "updated_at": "…",
      "transfer": { "…": "TransferIdentity" },
      "target": null,
      "ref_count": 2, "has_excerpt": true,
      "transfer_check": { "state": "ok" }
    }
  ],
  "state_file": "…",
  "generated_at": "…"
}
```

`transfer_check` per item: `{"state":"ok"}`,
`{"state":"stale","reason":"pane_missing|agent_session_changed|
generation_regressed"}`, or `{"state":"unchecked","reason":
"snapshot_unavailable|other_session"}`. `other_session` means the record
was created against a different herdr session/socket — pane ids are only
unique per session, so foreign snapshots prove nothing and the record is
never judged stale (or applicable) from them.

## `status` output

```json
{
  "contract": "herdr-plugins.handoff/v1",
  "command": "status",
  "handoff": { "…": "full HandoffRecord" },
  "transfer_check": { "state": "ok" },
  "payload_resolution": [
    { "ref": { "…": "PayloadRef" }, "state": "resolved",
      "detail": "session claude:<uuid> present in conversations index" }
  ],
  "missing_refs": 0,
  "state_file": "…",
  "generated_at": "…"
}
```

`payload_resolution[].state`:

- `resolved` — owner plugin's public CLI confirms the object exists.
- `missing_ref` — owner answered and the object is **absent** (deleted,
  never created, GC'd). Structured and countable via `missing_refs`.
- `unchecked` — owner answered but cannot prove absence (truncated
  listing).
- `error` — owner plugin/CLI unreachable or malformed output. **Never**
  reported as `missing_ref`; a failed check is not evidence of absence.
- `external` — uri/path/issue refs; never fetched or verified.

`--no-resolve-refs` skips owner CLI calls and returns
`payload_resolution: null`, `missing_refs: null`.

Ref resolution consumes owner plugins **only through their public CLI
contracts** (`conversations sessions --offline`, `checkpoints list
--limit 1000`), located via the sibling `plugins/<name>` directory or
`herdr plugin list --json` — the same discovery pattern as
`rebuildup.usage` (ADR-0013). Owner state files are never read directly.
Owner CLIs are invoked with `HERDR_PLUGIN_STATE_DIR`/`_CONFIG_DIR`/`_ID`
pinned to the owner's own dirs.

## Staleness semantics (invariant)

`checkTransfer(record, snapshot, sessionKey)` — evaluated at read time,
never persisted:

1. No snapshot → `unchecked/snapshot_unavailable`.
2. `record.transfer.session_key !== current session_key` →
   `unchecked/other_session`.
3. Source pane absent → `stale/pane_missing`.
4. Recorded `agent_session.value` set and live value differs (incl.
   `null`) → `stale/agent_session_changed` — pane-id reuse / new agent
   generation.
5. Live `state_change_seq` < recorded → `stale/generation_regressed`.
6. Otherwise `ok`. A live seq **ahead** of the recorded one is still
   `ok`: the handoff covers the recorded point; later source work is
   simply uncovered (T3 `coveredRunOrdinals` semantics).

Downstream executors (#104+) MUST refuse to apply a record whose
`transfer_check.state` is not `ok`. T1 performs no application, so the
guarantee is contractual: `status`/`list` surface the verdict and no
command mutates anything outside plugin state.

## Output contract

- Success: exactly one JSON document on stdout (pretty-printed).
- Failure: one JSON object on **stderr**,
  `{"contract","ok":false,"error":{"code":"usage"|"error","message"}}`,
  exit `2` (usage) or `1` (handled error: pane not found, handoff not
  found, unreachable socket on `create`, lock timeout).
- Socket/transport failures on `create` are errors — never an empty or
  fabricated record.

## State and config locations

- State: `<plugin state dir>/state.json` — same layout rule as inbox
  (`HERDR_PLUGIN_STATE_DIR`, else `<state-herdr>/plugins/
  rebuildup.handoff/state.json`). Schema v1; records are **not**
  session-namespaced (the transfer identity carries `session_key`).
  Hard cap 500 records; terminal statuses (`done`/`failed`/`superseded`)
  evict before live ones, oldest `created_at` first.
- Writes: single-writer lock file + tmp+rename (same discipline as
  inbox/projects/checkpoints).
- Config: `<plugin config dir>/` reserved; v1 reads no config file.

## Versioning

`contract` is `herdr-plugins.handoff/vN`. Additive optional fields may
appear within v1; breaking changes bump the version. `capability` exposes
`commands`/`execution`/`limits` for feature detection.
