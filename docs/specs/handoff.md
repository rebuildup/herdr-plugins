# Spec: Handoff plugin (`rebuildup.handoff`)

Handoff / delegation foundation for herdr — issues #103 (T1: contract +
state) and #104 (T2: same-host execution), decomposition of #6. Ports
the *contract and state* half of T3 Code's ContextHandoff
model (`docs/internals/context-handoffs.md`,
`docs/orchestration-v2/thread-lineage-and-context-transfer.md`,
`provider-switching-and-context.md` @ `9cc4018c`) to standalone herdr
plugins, simplified for herdr's weaker "thread" concept: the handoff
record itself is the lineage node (T1–T3: #103/#104/#105; lineage +
worktree + #30/#32 boundaries: T4 / #106 — see ADR-0021).

## Sources

- T3 Code ContextHandoff: `fromProviderThreadIds → toProviderThreadId`,
  strategy (`delta_since_target_last_seen` / `full_thread_summary` /
  `checkpoint_summary` / `manual_context`), status
  (pending/ready/failed/superseded), token budget — "budgeted selection,
  not an agent-written summary; the agent reads history on demand".
- herdr socket API: `session.snapshot` (panes + agents with
  `agent_session` / `state_change_seq`), `pane.report_metadata`.
- Sibling plugin contracts: `herdr-plugins.conversations/v1` (normalized
  event index, session record keys `<provider>:<id>`),
  `herdr-plugins.checkpoints/v1` (hidden git refs, entry ids).
- Agent Router boundary: dotfiles `script/agent/*` + `config/agents.toml`
  — surveyed read-only; see ADR-0017.

## Model

A **handoff record** binds:

- **transfer** (source): Host + herdr session + Workspace/Pane +
  `agent_session` + `state_change_seq` generation + cwd + provider kind.
- **target** (destination hint): optional pane/workspace ids and an
  opaque `provider_hint`. `execute` resolves it into a concrete surface;
  until then it is recorded intent only.
- **payload**: `refs[]` (conversation sessions, checkpoints, external
  uri/path/issue) + bounded `excerpt` + `requirements[]`.
- **status**: `pending | ready | delivered | done | failed | superseded`.
  `create` writes `pending`; `execute` drives the lifecycle (below).
- **strategy**: `native_resume | portable_context | checkpoint_ref |
  manual` — recorded at create; `execute` honors the first two.
- **execution** (optional, T2+): the observed execution record —
  `strategy_used`, resolved `provider_kind`, `decision` reason,
  `resume_args`, target pane (`created` flag), post-start agent
  generation baseline, prompt metadata, structured `error`, `observed`
  target-agent status.

### Payload budget and reference principle

Payloads are **references + bounded excerpt**, never full transcript
copies (T3 parity: budgeted selection; the receiving agent pulls history
on demand through the referenced indexes). Budgets are contract
constants: excerpt ≤ 8192 chars, ≤ 32 refs, ≤ 32 requirements × 500
chars. Exceeding them is a usage error (exit 2), not silent truncation —
except the excerpt itself, which truncates with `truncated: true`.

### Reference resolution (read-side)

`status` resolves each ref through the **owning plugin's public CLI**
(`conversations sessions --offline`, `checkpoints list --limit 1000`),
located via sibling `plugins/<name>` or `herdr plugin list --json`.
Owner state files are never read. Verdicts:

- `resolved` / `missing_ref` — only when the owner answered
  successfully; `missing_ref` means proven absence.
- `unchecked` — owner answered but cannot prove absence (truncated page).
- `error` — owner unreachable/malformed; **never** downgraded to
  `missing_ref`.
- `external` — never fetched.

Event-level refs (`conversation_session.event_refs`) are recorded but
verified session-level only in v1; consumers resolve events via
`conversations show`.

### Staleness (invariant)

`checkTransfer` compares the record's `transfer` against a live
`session.snapshot`, gated by `session_key` (hostname + canonical socket
path — same convention as inbox). Pane-id reuse and agent-generation
mismatch (`agent_session.value` differs, or `state_change_seq`
regresses) yield `stale` with a structured reason; foreign-session and
unreachable snapshots yield `unchecked`. Stale records are reported,
never applied — `execute` enforces `checkTransfer === ok` as a
pre-mutation gate (T2). A live seq ahead of the
recorded one stays `ok` (handoff covers the recorded point).

### What a handoff is NOT

- It never owns a PTY or reimplements herdr execution: target surfaces
  come only from `workspace.create` / `tab.create` and agents only from
  `agent.start` / `agent.prompt` / `agent.wait` (ADR-0010 precedent,
  ADR-0017 boundary).
- It never invokes the Agent Router launcher nor resolves
  `provider_hint` beyond taking its first `.`-segment as the
  `agent.start` kind — routing, quota, and preflight stay in
  dotfiles/pc-setup.
- It never mutates the *source* agent's lifecycle and never judges
  whether the source session should end (issue requirement:
  移管元の終了・成功を勝手に判断しない).
- It never reports unsupported/missing refs as resolved, and never
  reports an unverifiable check as `missing_ref`.
- It never fabricates delivery: `delivered` requires `agent.start` +
  `agent.prompt` acceptance; `done` requires an observed target-agent
  verdict (`agent_status === "done"`, or `idle` with
  `state_change_seq` past the pre-prompt baseline). Everything else
  stays `delivered` with `execution.observed` reporting the raw status.

## State

`<plugin state dir>/state.json`, schema v1: `{version, handoffs:
{id → record}}`. Single-writer lock + tmp+rename. Records are global
(not session-namespaced — cross-session transfer is the point); each
record self-describes its `session_key`. Cap 500; terminal statuses
evict first, then oldest `created_at`.

## Commands

`create <pane_id>` (snapshot required; `--dry-run` previews),
`list [--status] [--limit]`, `status <id> [--no-resolve-refs]
[--no-reconcile]`, `execute <id>`, `delegate <parent-id>`,
`merge-back <child-id>`, `resume-info [--provider]`,
`capability`. See `docs/contracts/handoff-v1.md` for the full I/O
contract.

## Execution (T2, #104)

`execute` runs the same-host handoff:

1. Gate: `pending`/`ready` only, live snapshot mandatory,
   `checkTransfer === ok` — refusals mutate nothing.
2. Read-only plan: strategy decision (`native_resume` preferred when the
   provider table says `supported` AND `agent_session.value` exists;
   otherwise `portable_context` fallback recorded in `decision`),
   prompt build (≤ `max_prompt_chars`), target resolution
   (`--target-pane` reuse of an agent-free pane > `--target-workspace`
   tab > `--new-workspace`/default dedicated workspace).
3. `ready` persisted, then herdr mutations: surface creation →
   `agent.start(name, kind, pane_id, args)` where `kind` is the provider
   hint's first `.`-segment and `args` carries resume argv + optional
   `--model` → `agentGet` baseline → `agent.prompt` payload injection →
   `delivered` (+ sibling `pending`/`ready` records for the same source
   become `superseded` atomically).
4. `--wait-ms` adds a bounded `agent.wait` observation; `status`
   reconciles `delivered → done` lazily from snapshot evidence.

Failure discipline: post-`ready` failures persist `status:"failed"`
with `execution.error{step,message}` (`surface`/`agent_start`/`prompt`);
`--cleanup-on-failure` closes only plugin-created panes
(`execution.target.created`), never a reused `--target-pane`. The
source agent's lifecycle is never touched.

`resume-info` exposes the provider native-resume table — a handoff-side
seed of the capability surface `rebuildup.controls` T2 (#100) is
expected to own; unlisted providers report `unknown` and fall back.

## Cross-machine execution (T3, #105)

`execute --remote <machine>` runs the same pipeline against a herdr
**saved SSH machine**. Upstream verdict (measured, herdr 0.9.5 /
protocol 22): remote agent control IS available — `herdr --machine
<label-or-id> <cli>` bridges over SSH to the remote host's
`remote-api-bridge` and exposes the full CLI/API surface
(`api snapshot`, `workspace/tab create`, `agent start|get|prompt|wait`,
`pane close`) with the same `{id,result|error}` JSON envelopes.
`herdr --remote` is TUI-attach only and `server.ssh_agent.register` is
ssh-agent forwarding — neither is a control surface; the plugin uses
neither.

- `remote-probe [selector|--all]` lists machines or probes capability:
  machine resolution (`herdr machine list --json`, id or case-insensitive
  label), `enabled` gate, remote `session.snapshot` fetch. Errors are
  structured (`machine_not_found`, `machine_ambiguous`,
  `machine_disabled`, `remote_unreachable`, `unsupported_remote`,
  `remote_timeout`, `remote_command_failed`, `remote_malformed`,
  `remote_<server-code>`).
- The source staleness gate still reads the LOCAL snapshot; the remote
  probe is a pre-mutation gate — unreachable machines leave the record
  `pending`. Target planning/creation/prompt/observation run against the
  REMOTE snapshot+transport; `execution.remote` records
  `{machine_id,label,target,session,probed_at,server_version,protocol}`.
- **Portable bundle** `herdr-plugins.handoff/bundle/v1` is written to
  `<state>/bundles/<id>.json` before `ready`: refs stay references,
  `plugin_state` refs are marked `resolvable_on_remote:false`
  (external_ref on the remote host), excerpt+requirements travel inline,
  and the prompt states the portability rule. Recorded as
  `execution.bundle{contract,path,refs,plugin_state_refs,external_refs}`.
- `status --remote` verifies `execution.remote.machine_id`, reconciles
  `delivered→done` via remote `agent.get`, and evaluates `target_check`
  on the remote snapshot; without `--remote` a remote record reports
  `remote_target_requires_flag` — never a local pane-id coincidence.

## Delegation lineage and worktree handoff (T4, #106)

Lineage kinds port T3 Code's thread relationships verbatim
(`fork` / `provider_handoff` / `merge_back` / `subagent_spawn` /
`subagent_result`) onto the handoff record itself — herdr has no
durable "thread" object (ADR-0021).

- `record.relationship{kind, parent_id, note?}` — optional lineage
  link. `parent_id` names the record this one derives from (spawn /
  fork / provider_handoff) or reports on (`subagent_result` /
  `merge_back`). Children are **derived** by scanning
  `relationship.parent_id` — never stored on the parent.
- `create --parent <id> --relationship <kind> [--link-note <text>]`
  attaches a link at create time; both flags are required together and
  the parent must exist in state. `--handoff <id>` adds a
  `handoff_record` payload ref (self-owned kind, resolved against this
  plugin's state — no external CLI).
- `delegate <parent-id>` creates a child record
  (`subagent_spawn`, parent = the delegating record) whose transfer
  identity is the delegating agent's pane (the parent record's executed
  target, falling back to its source pane — resolved live from the
  snapshot), then runs the unchanged `execute` pipeline. Same-session
  only: cross-session or remote-executed parents are refused
  (`other_session` / `unsupported_lineage`); `delegate --remote` is a
  usage error. `--no-execute` records intent without running.
- `merge-back <child-id>` creates a result record
  (`subagent_result`, or `merge_back` for `fork` children) whose
  transfer identity is the child's pane, and delivers it via
  `agent.prompt` to the DELEGATING agent's EXISTING pane — resolved
  through the child's own `parent_id`. `agent.start` is never called
  on a pane that already runs an agent; no live agent on the parent
  pane is refused (`parent_agent_missing`). The payload always carries
  a `handoff_record` ref to the child. Delivery failure step is
  `prompt`.
- Result records must not be run through `execute` — the delivery pane
  already runs the parent agent and `requireUsablePane` refuses busy
  panes honestly.
- `execute --worktree [--worktree-branch B] [--worktree-base R]` adds a
  `worktree` target plan: herdr `worktree.create` through the transport
  (socket `request` locally; `herdr --machine … worktree create` for
  `--remote`) yields `{root_pane, worktree}` — a worktree-backed
  workspace with a root pane, same shape as `workspace.create`.
  `execution.worktree{path,branch,is_linked_worktree,workspace_id}`
  records what herdr reported. Mutually exclusive with the other
  target selectors; transports without `worktree.create` refuse
  pre-mutation (`worktree_unsupported`). Checkout merge-back to the
  source worktree is git/forge business — the plugin carries context
  only.
- `list` items carry `relationship` + `child_count`; `status` returns a
  `lineage` block (own relationship, parent id/status, derived
  children).

## Out of scope (v1 / T2+T3+T4)

- `checkpoint_ref`/`manual` execution (recorded intent only).
- Event-level payload ref verification; provider-native resume
  capability beyond the seed table (`resume-info`; #100 owns the full
  table).
- Manifest actions/hooks: none (CLI-only surface).
