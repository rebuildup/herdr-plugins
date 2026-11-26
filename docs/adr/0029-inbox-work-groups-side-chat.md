# ADR-0029: Work groups and side-chat semantics — herdr model mapping

## Status

Accepted (2026-11). Design-decision record for issue #179 (decomposition
T4 of #33, under program #22). No plugin implementation ships with this
ADR; follow-up tracking is filed separately.

## Context

Issue #33 requires investigating T3 Code's "work group / side chat"
semantics and mapping them onto the herdr model. The pinned upstream
reference is `pingdotgg/t3code` @ `9cc4018c75ff4c61be8e86a6391d49a6c2d79830`:

- `docs/user/thread-sidebar.md` — user-facing semantics of pins,
  sections, project grouping, and side chats.
- `docs/orchestration-v2/thread-lineage-and-context-transfer.md` — the
  lineage/context-transfer model side chats are built on.
- Implementation: `packages/contracts/src/orchestrationV2.ts`
  (`OrchestrationV2AppThreadLineage`, `isListedThreadLineage`,
  `thread.fork` command with `sideChat` flag),
  `apps/server/src/orchestration-v2/Orchestrator.ts` (side-chat fork
  handling), `apps/server/src/orchestration-v2/ProviderTurnStartService.ts`
  (side-chat context handoff injection).

### What "work groups" and "side chat" actually are upstream

**Work groups** in T3 Code are not a durable user-defined grouping
primitive. The sidebar's structure is:

- Sections (`Pinned`, `Active`, `Working`, `Snoozed`, `Settled`) —
  derived from thread state plus user organize actions (pin, settle,
  snooze, archive). `Working` is a computed fold of threads that are
  working or waiting on resumable work.
- "Group threads by project" (beta) — a **presentation-only** folder
  view keyed by project identity (`projectGrouping.ts` derives logical
  project keys across environments). It is per-device UI state, not
  stored thread semantics.
- `AppThreadLineage` (`parentThreadId`, `relationshipToParent`,
  `rootThreadId`, `sideChat`) — durable lineage, used for forks and
  subagents, not for arbitrary user grouping.

**Side chat** is a `thread.fork` variant: `thread.fork` with
`sideChat: true` creates a child `AppThread` whose lineage records
`parentThreadId` + `relationshipToParent: "fork"` + `sideChat: true`.
`isListedThreadLineage` excludes side chats (and subagents) from thread
lists — they "live inside their parent's view". Context transfer is the
standard lazy `ContextTransfer`/`ContextHandoff` machinery: the fork is
cheap at creation, and portable context materializes at first dispatch.
The side chat works in the same folder, cannot take messages while the
parent is busy in some flows, and "Add to chat" injects a lineage link
the parent agent can read. Deleting/archiving the parent cascades.

## herdr-side capabilities

- Execution hierarchy is **workspace → tab → pane** (`workspace.create`
  returns `{workspace, tab, root_pane}`; `tab.create`, `pane.split`;
  verified live in `docs/research/herdr-pane-execution-spike.md`). This
  is the durable, user-visible grouping surface — strictly richer than
  T3's project folders for organizing *running work*.
- Inbox organize state is per-pane user-side state
  (`settled`/`snoozed` marks keyed by pane identity + generation
  signals; `docs/specs/inbox.md`, `docs/contracts/inbox-v1.md`). It
  deliberately mirrors only T3's *durable* organize semantics, not its
  presentation projections.
- `herdr-plugins.handoff/v1` already implements the upstream lineage
  model: `relationship.kind` ∈ `fork | provider_handoff | merge_back |
  subagent_spawn | subagent_result`, `parent_id` links, `status`/
  `list` lineage views, and `execute` target selection
  (`--target-pane`, `--target-workspace`, `--new-workspace`,
  `--worktree`, `--remote`) that can place the child in the same
  workspace/tab or a worktree (`docs/contracts/handoff-v1.md`,
  ADR-0021).
- Sidebar-style presentation (hidden side-chat tabs inside a parent
  view, project folders, drag-to-settle) is **herdr-t3 UI scope**
  (issue #7), not plugin state.

## Decision

**Option (b): map to herdr's native primitives and existing contracts.
No `group` concept is added to inbox organize state; no side-chat
implementation ships in this repository now.**

Mapping table:

| T3 Code concept | herdr equivalent | Owner |
| --- | --- | --- |
| Thread | agent pane (inbox item) | herdr core |
| Sidebar sections (settled/snoozed/pinned/working) | inbox organize marks + attention invariant; working-fold is a `list` projection concern | `rebuildup.inbox` (settle/snooze shipped; pin/reorder tracked under #33 siblings) |
| Group-by-project folders | workspace (cwd/repo scope) + tab; already native | herdr core / herdr-t3 projection |
| `AppThreadLineage` fork/subagent | `handoff-v1` `relationship{kind,parent_id}` | `rebuildup.handoff` |
| Side chat (`thread.fork` + `sideChat`) | `handoff create --relationship fork` + `execute` into the same workspace/tab; hidden-in-parent presentation deferred to herdr-t3 (#7) | handoff contract exists; UI pending |
| Lazy `ContextTransfer`/`ContextHandoff` | `handoff-v1` portable_context/native_resume strategies + `payload_refs` | `rebuildup.handoff` |

Rationale for rejecting the alternatives:

- **(a) Inbox organize grouping** — rejected. T3 has no durable
  arbitrary "work group" primitive to port; its only grouping is
  presentation state (per-device sidebar projection) plus the native
  project→workspace mapping. Adding a `group` label to inbox state
  would duplicate what `workspace_id`/`tab_id` already carry on every
  `InboxItem`, create a second source of truth for grouping, and add
  resolution/pruning surface for zero demonstrated need. If a real
  cross-workspace grouping requirement emerges, it belongs as an
  additive optional field on `inbox-v1` items (contract permits
  additive fields), decided by a future ticket — not preemptively.
- **(c) Defer everything as upstream gap** — rejected as the primary
  answer because the *semantics* are fully mappable today: lineage and
  context transfer already exist in `handoff-v1`, and grouping already
  exists in herdr's workspace/tab model. What remains genuinely
  unimplemented is presentation (side-chat tab inside a parent view,
  `/side` composer command), which is herdr-t3's responsibility under
  #7, not an upstream herdr gap and not an inbox-plugin gap.

## Invariants preserved

- **Execution state separation**: nothing here mutates agent/pane
  execution state; organize state remains user-side UI-layer state.
- **Attention never hidden**: a side-chat or grouped pane is still an
  ordinary pane in `list`; `attention` (`blocked`) forces
  `in_inbox: true` regardless of any future grouping label.
- **Identity/generation safety**: any future group/lineage field must
  key off `pane_id` + `agent_session` + `state_change_seq` exactly like
  existing organize marks; stale grouping must not survive pane/agent
  generation reuse.
- **Honest unsupported**: side-chat *presentation* is reported as
  herdr-t3 scope, not silently approximated by plugin metadata.

## Consequences

- #33's "作業グループ・side chat の意味論を herdr のモデルへ対応付ける"
  acceptance item is satisfied by this record: the semantics are
  identified at the pinned revision, mapped onto herdr primitives, and
  the residual work is explicitly assigned (herdr-t3 UI under #7;
  contingent contract additions only on demonstrated need).
- `docs/contracts/inbox-v1.md` and `docs/specs/inbox.md` are unchanged;
  inbox v1 contract remains sufficient.
- A follow-up tracking issue records the contingent side-chat path
  (handoff `fork` lineage + same-workspace execute + herdr-t3 hidden
  view) so the decision is actionable when #7 scheduling reaches it.

## Alternatives considered

- **Inbox `group` field now**: rejected — speculative schema, duplicates
  `workspace_id`/`tab_id`, violates the minimal-state principle.
- **New `side_chat` relationship kind in handoff-v1 now**: rejected for
  now — `fork` already expresses the lineage; a distinct kind adds
  contract surface before any consumer (herdr-t3) exists. Revisit when
  #7 implements the UI and needs to distinguish side chats from user
  forks.
- **Upstream herdr ask for native thread grouping**: not warranted —
  workspace/tab already provide the grouping; recorded here so it is
  not re-litigated.
