# Contract: `herdr-plugins.handoff/v1`

Versioned structured interface for the `rebuildup.handoff` plugin —
handoff/delegation records that bind a source pane/agent generation to a
payload of **references** (never transcript copies) plus a status
lifecycle. External clients (herdr-t3, agents, scripts) MUST depend only
on this contract, never on the plugin's internal state file format.

T1 scope (issue #103): `create` / `list` / `status` / `capability`.
T2 scope (issue #104): `execute` (same-host target creation + `agent.start`
+ payload injection + status transitions) and `resume-info`, plus `status`
extensions (`target_check`, lazy `delivered → done` reconciliation).
Cross-machine execution is T3 (#105) and will extend this contract
additively within v1 where possible.

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
  "version": "0.2.0",
  "commands": ["create", "list", "status", "execute", "resume-info", "capability"],
  "actions": [],
  "events": [],
  "startup": [],
  "state_file": "…",
  "config_dir": "…",
  "socket": null,
  "execution": "same_host",
  "execution_surface": {
    "strategies": ["native_resume", "portable_context"],
    "target_selection": ["--target-pane", "--target-workspace", "--new-workspace"],
    "agent_api": ["workspace.create", "tab.create", "agent.start", "agent.prompt", "agent.wait"],
    "failure_cleanup_flag": "--cleanup-on-failure",
    "observation_flag": "--wait-ms",
    "provider_hint": "opaque label; first '.'-segment is used as the agent.start kind only"
  },
  "limits": {
    "max_excerpt_chars": 8192,
    "max_payload_refs": 32,
    "max_requirements": 32,
    "max_prompt_chars": 65536
  }
}
```

`execution: "same_host"` means `execute` performs same-host handoffs only:
target surfaces are created exclusively through herdr's socket API
(`workspace.create` / `tab.create` + `agent.start` / `agent.prompt` /
`agent.wait`); the plugin never owns a PTY and never invokes the Agent
Router launcher. `execution: "not_implemented"` (T1) meant records were
intent-only.

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
| `status` | `handoff_id` | Full record + staleness + target check + per-ref resolution. |
| `execute` | `handoff_id` + flags | Run the same-host handoff (see below). |
| `resume-info` | `--provider KIND` | Provider native-resume capability table. |
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
  `create` writes `pending`; `execute` drives the rest (below).
- `strategy` — `native_resume | portable_context | checkpoint_ref |
  manual` (T3 ContextHandoff strategies, simplified). `execute` honors
  `native_resume`/`portable_context`; `checkpoint_ref`/`manual` are
  recorded intent and refused with `unsupported_strategy`.
- `execution` — optional `HandoffExecution` object present once
  `execute` has run (see "Execution record" below). Absent on records
  created before T2.

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
      "target_pane_id": null,
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

`status` also returns `target_check` and performs **lazy
reconciliation**: when the record is `delivered` and has an execution
target, the target pane's raw `agent_status`/`state_change_seq` inside
the current session's snapshot is evaluated and `execution.observed` is
persisted; `delivered → done` is applied only when the done verdict
holds (`agent_status === "done"`, or `"idle"` with seq advanced past
the pre-prompt baseline). `--no-reconcile` skips the write.

`target_check`:

```json
{ "state": "ok", "reason": null, "agent_status": "working",
  "pane_present": true, "agent_session": { "…": "AgentSessionRef" },
  "state_change_seq": 9 }
```

`state` is `ok` (target pane present), `pane_missing` (target pane gone —
reported, NOT auto-failed: a user may have closed it after completion),
or `unchecked` with `reason` ∈ `not_executed | snapshot_unavailable |
other_session`.

## `execute`

```
handoff execute <handoff-id>
  [--target-pane ID | --target-workspace ID | --new-workspace]
  [--provider HINT] [--model M]
  [--wait-ms MS] [--cleanup-on-failure] [--dry-run]
  [--session NAME] [--socket PATH] [--timeout MS]
```

Runs the same-host handoff end-to-end:

1. **Gate** — record must be `pending`/`ready`; a live
   `session.snapshot` is mandatory; `checkTransfer` must be `ok`
   (stale/`other_session`/unreachable → structured error, record
   untouched, nothing created).
2. **Plan** — strategy decision + prompt build + target resolution are
   all read-only. `--dry-run` returns `{plan, decision, prompt_text}`
   and mutates nothing.
3. **`ready`** — payload built; `execution` persisted with
   `strategy_used`, `provider_kind`, `decision`, `resume_args`.
4. **Surface** — target pane reuse (`--target-pane`, must be agent-free),
   `tab.create` (`--target-workspace` / `record.target.workspace_id`),
   or `workspace.create` (default / `--new-workspace`, cwd inherited
   from `transfer.cwd`). Only plugin-*created* surfaces set
   `execution.target.created: true`.
5. **`agent.start`** — `kind` = first `.`-segment of the provider hint
   (opaque label → kind only; Agent Router is never invoked);
   `args` = resume argv (`native_resume`) + optional `--model` mapping.
6. **Prompt** — `agent.prompt` injects the bounded payload preamble
   (`max_prompt_chars` 65536; exceeding is `payload_too_large`, never
   truncated silently).
7. **`delivered`** — target pane/agent identity + `state_change_seq`
   baseline + prompt metadata persisted; sibling `pending`/`ready`
   records for the same source identity become `superseded` in the same
   write.
8. **Observation** — `--wait-ms MS` runs a bounded `agent.wait`
   (`idle|done|blocked`) then re-observes; timeout stays `delivered`.
   `done` requires the observed verdict above.

Outcome semantics:

- stdout JSON `{command:"execute", outcome:"delivered"|"done",
  handoff}` on success (exit 0).
- `outcome:"failed"` → stderr `execution_failed` error (exit 1) **and**
  the record persists `status:"failed"` with
  `execution.error{step,message,at}` — steps: `surface`, `agent_start`,
  `prompt`. Success is never fabricated.
- Pre-mutation refusals (stale source, busy/missing target pane,
  `unsupported_strategy`, `provider_unknown`, unreachable socket,
  invalid state) → structured stderr error, record unchanged.
- `--cleanup-on-failure` closes the target pane ONLY when
  `execution.target.created === true`; reused panes are never closed.
  The source session's lifecycle is never judged or touched.

### Strategy decision

`record.strategy` requests; `execution.strategy_used` records reality:

- `portable_context` → fresh session + payload as first prompt.
- `native_resume` → requires provider `native_resume: "supported"` in
  the resume table AND `transfer.agent_session.value`; otherwise falls
  back to `portable_context` with `execution.decision` recording why.
- `checkpoint_ref` / `manual` → `unsupported_strategy` error.

Provider kind resolution: `--provider` flag > `target.provider_hint` >
`transfer.provider_kind`; a `harness.provider` hint contributes its
first `.`-segment as the `agent.start` kind.

### `resume-info`

```
handoff resume-info [--provider KIND]
```

Returns the provider native-resume capability table:
`{kind, native_resume: supported|unsupported|unknown,
session_id_source, resume_args_template, model_flag, notes}`.
`unknown` is honest non-support — `execute` falls back rather than
guessing. The table is the handoff-side seed of the provider capability
surface `rebuildup.controls` T2 (#100) is expected to own; until then
unlisted providers report `unknown`.

## Execution record (`execution` field)

```json
"execution": {
  "decided_at": "…",
  "strategy_used": "native_resume",
  "provider_kind": "claude",
  "decision": "provider \"claude\" supports native resume; …",
  "resume_args": ["--resume", "<session-id>"],
  "target": { "pane_id": "w9:p1", "workspace_id": "w9", "tab_id": "w9:t1",
              "created": true },
  "agent": { "name": "handoff ho-…", "kind": "claude", "pane_id": "w9:p1",
             "agent_session": { "…": "AgentSessionRef" },
             "state_change_seq": 5, "agent_status": "working" },
  "prompt": { "delivered_at": "…", "chars": 4210, "waited": true },
  "error": null,
  "cleaned_up": false,
  "observed": { "agent_status": "done", "pane_present": true,
                "checked_at": "…" }
}
```

`agent.state_change_seq` is the **pre-prompt baseline** used by the done
verdict; `observed.agent_status` is always the raw herdr value.

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

Downstream executors MUST refuse to apply a record whose
`transfer_check.state` is not `ok` — `execute` enforces this as a
pre-mutation gate (T2, #104). `status`/`list` surface the verdict; the
only mutations `execute` performs outside plugin state are the herdr API
calls described above, and only after the gate passes.

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
