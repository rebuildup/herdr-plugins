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
T3 scope (issue #105): cross-machine execution — `execute --remote`
(saved-machine SSH bridge), `status --remote`, `remote-probe`, and the
portable bundle (`herdr-plugins.handoff/bundle/v1`). Remote fields are
additive optional members of v1.
T4 scope (issue #106): delegation lineage — `delegate` (subagent_spawn
child + execute), `merge-back` (subagent_result / merge_back result
records delivered via `agent.prompt` to the parent's existing pane),
`create --parent/--relationship`, the `handoff_record` payload ref
kind, `execute --worktree` (herdr `worktree.create` targets), and the
`status`/`list` lineage views. All T4 fields are additive optional
members of v1; **v1 is stable** at plugin v0.6.0 (see Versioning).

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
  "version": "0.6.0",
  "commands": ["create", "list", "status", "execute", "resume-info", "remote-probe", "delegate", "merge-back", "capability"],
  "actions": [],
  "events": [],
  "startup": [],
  "state_file": "…",
  "config_dir": "…",
  "socket": null,
  "execution": "same_host_and_remote_saved_machines",
  "lineage": {
    "kinds": ["fork", "provider_handoff", "merge_back", "subagent_spawn", "subagent_result"],
    "model": "record.relationship{kind,parent_id}; children derived by scan",
    "scope": "same-session only in v1; remote lineage refused (unsupported_lineage)"
  },
  "execution_surface": {
    "strategies": ["native_resume", "portable_context"],
    "target_selection": ["--target-pane", "--target-workspace", "--new-workspace", "--worktree [--worktree-branch B] [--worktree-base R]", "--remote <machine>"],
    "agent_api": ["workspace.create", "tab.create", "worktree.create", "agent.start", "agent.prompt", "agent.wait"],
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

`execution: "same_host_and_remote_saved_machines"` means `execute`
performs same-host handoffs AND cross-machine handoffs onto herdr saved
SSH machines. In both cases target surfaces are created exclusively
through herdr's own API surface — the local socket API for same-host,
the `herdr --machine <label-or-id>` CLI bridge (SSH → remote
`remote-api-bridge`) for remote; the plugin never owns a PTY and never
invokes the Agent Router launcher. `execution: "not_implemented"` (T1)
meant records were intent-only.

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
| `delegate` | `parent_id` + flags | subagent_spawn: child record + execute (see "Delegation lineage"). |
| `merge-back` | `child_id` + flags | subagent_result/merge_back: result record + `agent.prompt` delivery. |
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
- `--handoff <id>` (repeatable) — `handoff_record` payload ref to
  another record in this plugin's state (lineage evidence).
- `--parent <id>` + `--relationship <kind>` — lineage link; `kind` ∈
  `fork | provider_handoff | merge_back | subagent_spawn |
  subagent_result`. Both flags are required together; the parent must
  exist in state. `--link-note <text>` annotates the link.
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
  "relationship": { "kind": "subagent_spawn", "parent_id": "ho-…", "note": "…" },
  "payload": {
    "refs": [
      { "kind": "conversation_session", "plugin": "rebuildup.conversations",
        "session_key": "claude:<uuid>", "event_refs": ["u-1"] },
      { "kind": "checkpoint", "plugin": "rebuildup.checkpoints", "id": "m2x-…" },
      { "kind": "handoff_record", "plugin": "rebuildup.handoff", "id": "ho-…" },
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
  - `handoff_record` → another record in this plugin's own state
    (`rebuildup.handoff`); resolved against `state.json` — `resolved` /
    `missing_ref` only, never `error` for a missing file (unreadable
    state → `error`).
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
- `relationship` — optional `HandoffRelationship{kind, parent_id,
  note?}` lineage link (#106). `kind` ∈ `fork | provider_handoff |
  merge_back | subagent_spawn | subagent_result`; `parent_id` is the
  record this one derives from (spawn/fork/provider_handoff) or reports
  on (subagent_result/merge_back). Children are derived by scanning —
  never stored on the parent.

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

`status` also returns a `lineage` block (#106):

```json
"lineage": {
  "relationship": { "kind": "subagent_spawn", "parent_id": "ho-…", "note": "…" },
  "parent": { "id": "ho-…", "status": "delivered", "missing": false },
  "parent_missing": false,
  "children": [
    { "id": "ho-…", "status": "done", "kind": "subagent_result",
      "created_at": "…" }
  ]
}
```

`parent`/`parent_missing` report the record named by
`relationship.parent_id` (`null`/`false` for root records;
`parent_missing: true` when the linked record was evicted);
`children` lists records whose `relationship.parent_id` is this id,
ordered by `created_at`. `list` items carry `relationship` (or `null`)
and `child_count` for the same derived view.

## `execute`

```
handoff execute <handoff-id>
  [--target-pane ID | --target-workspace ID | --new-workspace | --worktree
   [--worktree-branch B] [--worktree-base R]]
  [--provider HINT] [--model M]
  [--wait-ms MS] [--cleanup-on-failure] [--dry-run]
  [--remote MACHINE]
  [--session NAME] [--socket PATH] [--timeout MS]
```

Runs the handoff end-to-end (same-host by default; `--remote` selects a saved machine — see "Remote execution"):

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
   `worktree.create` (`--worktree [--worktree-branch B]
   [--worktree-base R]`, cwd inherited from `transfer.cwd`; works
   locally and via `--remote`), or `workspace.create` (default /
   `--new-workspace`, cwd inherited from `transfer.cwd`). Only
   plugin-*created* surfaces set `execution.target.created: true`.
   The four target selectors are mutually exclusive; a transport
   without `worktree.create` refuses pre-mutation
   (`worktree_unsupported`).
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

## Delegation lineage (T4, #106)

```
handoff delegate <parent-handoff-id>
  [--task TEXT] [--strategy STRATEGY] [--provider HINT] [--model M]
  [--worktree [--worktree-branch B] [--worktree-base R]]
  [--target-pane ID | --target-workspace ID | --new-workspace]
  [--wait-ms MS] [--cleanup-on-failure] [--link-note TEXT]
  [payload flags as create] [--no-execute] [--dry-run]

handoff merge-back <child-handoff-id>
  [--task TEXT] [--wait-ms MS] [--link-note TEXT]
  [payload flags as create] [--no-execute] [--dry-run]
```

- **`delegate`** creates a child record with
  `relationship{kind:"subagent_spawn", parent_id:<parent>}` whose
  transfer identity is the delegating agent's pane (the parent record's
  executed target, else its source pane — resolved live, never from
  stale ids), then runs the normal `execute` pipeline: a NEW agent via
  `agent.start` in a fresh surface. `--no-execute` records intent only;
  `--dry-run` previews the child record without persisting.
- **`merge-back`** creates a result record with
  `relationship{kind:"subagent_result"|"merge_back", parent_id:<child>}`
  (`merge_back` when the child is a `fork`, else `subagent_result`)
  whose transfer identity is the child's pane, and delivers it via
  `agent.prompt` to the DELEGATING agent's existing pane — resolved
  through the child's own `parent_id`. `agent.start` is never called on
  a pane that already runs an agent; a parent pane without a live agent
  is refused (`parent_agent_missing`). The payload always includes a
  `handoff_record` ref to the child record.
- Both are **same-session only in v1**: cross-session parents and
  remote-executed parents/children are refused
  (`other_session` / `unsupported_lineage`). `delegate --remote` is a
  usage error.
- A result record must not be run through `execute` — its delivery
  pane already runs the parent agent and `requireUsablePane` refuses
  busy panes honestly.
- Boundary (ADR-0021): #30 MCP may expose these commands as tools —
  that is #30's decision; this contract is the surface it consumes.
  #32 automations may *invoke* `delegate`/`merge-back`/`execute`, but
  scheduled or failure-triggered handoff is automation scope, not this
  plugin's.

## Remote execution (T3, #105)

```
handoff execute <handoff-id> ... --remote <machine-label-or-id>
handoff status  <handoff-id> [--remote <machine-label-or-id>]
handoff remote-probe [<machine-label-or-id> | --all]
```

Remote transport is herdr's **saved machines** path: `herdr machine
list --json` profiles (`id`/`label`/`target`/`session`), and
`herdr --machine <id> <cli>` which bridges over SSH to the remote
host's `remote-api-bridge` and exposes the same API surface the local
socket provides. The plugin shells out per call — each invocation
re-establishes the bridge; correct but not free. `herdr --remote`
(interactive TUI attach) and `server.ssh_agent.register` (ssh-agent
forwarding into a remote session) are **not** remote control surfaces
and are never used.

- **Probe** — `remote-probe` with no argument lists saved machines;
  with a selector (or `--all`) it resolves the machine, requires
  `enabled`, and fetches the remote `session.snapshot` via
  `herdr --machine <id> api snapshot`. Results report
  `{state:"reachable", machine_id, label, target_host, session,
  server_version, protocol, panes, agents}` or
  `{state:"error", kind, message}` with `kind` ∈
  `machine_not_found | machine_ambiguous | machine_disabled |
  remote_unreachable | unsupported_remote | remote_timeout |
  remote_command_failed | remote_malformed | remote_<server-code>`.
- **`execute --remote`** — the source staleness gate still reads the
  LOCAL snapshot (the source pane is local). The remote probe runs
  BEFORE any mutation: unreachable/disabled/unknown machines are
  pre-mutation refusals and the record stays `pending`. On success the
  remote snapshot drives target planning (`--target-pane`,
  `--target-workspace`, default new remote workspace — pane/workspace
  ids live in the remote session bound to the machine profile).
  Surface creation, `agent.start`, prompt injection, `agent.wait`, and
  failure cleanup all go through the remote CLI transport. A
  **portable bundle** (`herdr-plugins.handoff/bundle/v1`) is written
  to `<state dir>/bundles/<handoff-id>.json` before the `ready`
  transition; its path and ref portability counts are recorded in
  `execution.bundle`.
- **Portable bundle** — payload refs keep their reference form;
  `conversation_session`/`checkpoint` refs are marked
  `portability:"plugin_state", resolvable_on_remote:false` (they name
  objects in rebuildup.* state on the SOURCE host — external_ref on the
  remote host), `external` refs keep their inline value. The bounded
  excerpt and requirements travel inline; the injected prompt states
  the portability rule explicitly. No transcript copies, no fabricated
  remote resolution.
- **`status --remote`** — probes the machine, verifies
  `execution.remote.machine_id` matches (mismatch →
  `remote_check.state:"unchecked", reason:"remote_mismatch"`),
  reconciles `delivered → done` via the remote transport's `agent.get`,
  and evaluates `target_check` against the REMOTE snapshot. A remote
  record checked WITHOUT `--remote` reports
  `target_check.reason:"remote_target_requires_flag"` — local pane-id
  coincidences are never reported as the remote target.
- **Remote identity** — `execution.remote` records `{machine_id,
  label, target, session, enabled, probed_at, server_version, protocol}`
  from the saved-machine profile + probe; `agent_session` /
  `state_change_seq` generation signals come from the REMOTE snapshot,
  so local state can never be mistaken for the remote generation.

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
                "checked_at": "…" },
  "remote": { "machine_id": "m1", "label": "Lab Box",
              "target": "lab.example.com", "session": "agents",
              "enabled": true, "probed_at": "…",
              "server_version": "0.9.5", "protocol": 22 },
  "bundle": { "contract": "herdr-plugins.handoff/bundle/v1",
              "path": "…/bundles/ho-….json", "refs": 3,
              "plugin_state_refs": 2, "external_refs": 1 },
  "worktree": { "path": "/repo-wt", "branch": "handoff/x",
              "is_linked_worktree": true, "workspace_id": "w9" }
}
```

`remote`/`bundle` are present only for `execute --remote` runs;
`worktree` is present only for `execute --worktree` runs and records
what herdr `worktree.create` reported (`path`, `branch`,
`is_linked_worktree`, `workspace_id`).

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

**v1 is stable** as of plugin v0.6.0 (release-0-6-0 train, issue #106):
the record schema, status lifecycle, payload ref kinds (including
`handoff_record`), lineage (`relationship`), worktree targets, and all
commands above are the frozen v1 surface. Within v1 only additive
optional fields may appear; any semantic change to existing fields,
status transitions, ref resolution verdicts, or command behavior
requires `herdr-plugins.handoff/v2`.
