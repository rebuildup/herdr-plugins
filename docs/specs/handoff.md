# Spec: Handoff plugin (`rebuildup.handoff`)

Handoff / delegation foundation for herdr — issue #103, decomposition T1
of #6. Ports the *contract and state* half of T3 Code's ContextHandoff
model (`docs/internals/context-handoffs.md`,
`docs/orchestration-v2/thread-lineage-and-context-transfer.md`,
`provider-switching-and-context.md` @ `9cc4018c`) to standalone herdr
plugins, simplified for herdr's weaker "thread" concept: the handoff
record itself is the lineage node (full lineage lands in T4 / #106).

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
  opaque `provider_hint`. Recorded intent only — T1 creates nothing.
- **payload**: `refs[]` (conversation sessions, checkpoints, external
  uri/path/issue) + bounded `excerpt` + `requirements[]`.
- **status**: `pending | ready | delivered | done | failed | superseded`.
  T1 writes only `pending`; transitions belong to #104+.
- **strategy**: `native_resume | portable_context | checkpoint_ref |
  manual` — recorded at create, honored by the executor later.

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
never applied — and T1 applies nothing at all. A live seq ahead of the
recorded one stays `ok` (handoff covers the recorded point).

### What a handoff is NOT

- It never mutates herdr agent/pane execution state, never judges the
  source session's lifecycle (issue requirement: 移管元の終了・成功を
  勝手に判断しない).
- It never reimplements Agent Router routing, quota, preflight, or
  review — `provider_hint` is an opaque label (ADR-0017).
- It never reports unsupported/missing refs as resolved, and never
  reports an unverifiable check as `missing_ref`.

## State

`<plugin state dir>/state.json`, schema v1: `{version, handoffs:
{id → record}}`. Single-writer lock + tmp+rename. Records are global
(not session-namespaced — cross-session transfer is the point); each
record self-describes its `session_key`. Cap 500; terminal statuses
evict first, then oldest `created_at`.

## Commands

`create <pane_id>` (snapshot required; `--dry-run` previews),
`list [--status] [--limit]`, `status <id> [--no-resolve-refs]`,
`capability`. See `docs/contracts/handoff-v1.md` for the full I/O
contract.

## Out of scope (v1 / T1)

- `execute` and status transitions beyond `pending` (#104).
- Cross-machine/remote handoff, portable bundles (#105).
- Delegation, parent/child lineage, worktree handoff, `#30`/`#32`
  boundaries (#106).
- Event-level payload ref verification; provider-native resume
  capability table (`resume-info`, #104).
- Manifest actions/hooks: none in T1 (CLI-only surface).
