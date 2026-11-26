# ADR-0021: Handoff delegation lineage, worktree targets, and #30/#32 boundaries

Status: Accepted (release-0-6-0 candidate, Issue #106 / parent #6 T4 —
final ticket of the #6 decomposition)

## Context

T1–T3 (#103/#104/#105) shipped the handoff record, payload contract,
same-host execution, and cross-machine execution. T4 (#106) adds the
remaining #6 scope: delegation / subtask / parent-child lineage,
worktree handoff, and the responsibility boundary versus #30 (MCP) and
#32 (automations).

Upstream model under study: T3 Code's thread relationships
(`fork` / `provider_handoff` / `merge_back` / `subagent_spawn` /
`subagent_result`,
`docs/orchestration-v2/thread-lineage-and-context-transfer.md` @
`9cc4018c`). T3 hangs these off persistent thread/run entities with
`ContextTransfer`/`ContextHandoff` records and app-owned tool dispatch
for subagent runs. herdr has no durable "thread" object — the handoff
record itself must be the lineage node (the #6 decomposition decision).

Measured herdr capability (installed herdr 0.9.5, API protocol 22,
`herdr api schema --json`):

- `worktree.create` / `worktree.open` / `worktree.list` /
  `worktree.remove` exist on the socket API and return
  `{workspace, tab, root_pane, worktree}` — a worktree-backed workspace
  with a root pane, same shape as `workspace.create`. The `herdr
  worktree` CLI subcommands wrap the same methods and work through the
  `--machine` SSH bridge like every other API-backed command.
- `agent.prompt` delivers text to a pane's RUNNING agent; there is no
  API to "start a subagent of an agent" — provider-internal subagents
  (e.g. claude tasks) are the provider's own concern and are NOT
  observable as herdr agents.
- No herdr API expresses pane parentage; lineage is plugin state by
  design, not an upstream gap.

## Decision

1. **Lineage = `record.relationship{kind, parent_id, note?}`.** The
   five T3 relationship kinds are kept verbatim. `parent_id` names the
   record this one derives from or reports on; children are never
   stored — `list`/`status` derive them by scanning
   `relationship.parent_id`. Additive optional field: contract stays
   `herdr-plugins.handoff/v1`.
2. **`delegate` = subagent_spawn child + normal execute.** The child's
   transfer identity is the DELEGATING agent's pane (parent record's
   `execution.target.pane_id`, falling back to `transfer.pane_id`),
   resolved live from the snapshot — never from stale ids. Execution
   reuses the unchanged `executeHandoff` pipeline: a NEW agent via
   `agent.start` in a fresh surface. Same-session only in v1:
   cross-session parents and remote-executed parents are refused
   (`other_session` / `unsupported_lineage`).
3. **`merge-back` = subagent_result / merge_back via `agent.prompt`.**
   The result record's `relationship.parent_id` is the CHILD record it
   reports on; the delivery pane is resolved through the child's own
   `parent_id` (the delegator). Delivery is `agent.prompt` to the
   parent agent's EXISTING pane — `agent.start` is never called on a
   pane that already runs an agent (`parent_agent_missing` refusal when
   no agent is live). Result kind: `merge_back` for `fork` children,
   `subagent_result` otherwise. The payload always carries a
   `handoff_record` ref to the child (new self-owned payload ref kind,
   resolved against `state.json` — no external CLI).
4. **Worktree handoff = `execute --worktree`.** Target plan kind
   `worktree` calls herdr `worktree.create` through the transport
   (socket `request` locally; `herdr --machine … worktree create` for
   `--remote`). `execution.worktree{path, branch, is_linked_worktree,
   workspace_id}` records what herdr reported. `--worktree-branch` /
   `--worktree-base` map to the API params. Merge-back of the checkout
   to the source worktree is git/forge business — the plugin carries
   context only (issue requirement). Transports without
   `worktree.create` refuse pre-mutation (`worktree_unsupported`).
5. **#30 MCP boundary: handoff stays CLI-only in v1.** MCP is the
   surface for EXTERNAL agents to operate herdr/plugins; handoff is the
   plugin's own context-transfer record/execute surface. Whether to
   expose handoff operations as MCP tools is #30's decision — this
   contract (`herdr-plugins.handoff/v1`) is the input it would consume.
   No MCP server, tool, or manifest action is added here.
6. **#32 automation boundary: no scheduled/triggered handoff.**
   Automations own cron/webhook/durable workflows; handoff is an
   explicit, operator/agent-initiated context transfer. Automatic
   handoff on provider failure or idle timeout is automation territory
   and is NOT provided — a future automation may *invoke* `handoff
   create`/`execute` through this CLI like any other client.
7. **No new upstream issues filed.** Every capability T4 needs exists
   upstream (`worktree.*`, `agent.prompt`, snapshot identity signals).
   Provider-internal subagent visibility and pane parentage are
   provider/herdr-core concerns outside this plugin's contract; the
   existing upstream issue survey (#6191 agent_session_path —
   not-planned; #6196 dialogs; #6197 queue/steer — both not-planned)
   already records the relevant gaps and none block lineage.

## Consequences

- Lineage is queryable: `status` returns a `lineage` block (own
  relationship, parent id/status, derived children); `list` items carry
  `relationship` + `child_count`.
- `delegate`/`merge-back` failures persist `failed` with the same
  `execution.error{step}` taxonomy; merge-back delivery failure step is
  `prompt`.
- A `merge_back`/`subagent_result` record must NOT be run through
  `execute` — its target pane already runs the parent agent and
  `requireUsablePane` refuses busy panes honestly.
- Cross-machine lineage (delegating to a remote machine's agent, or a
  remote child reporting back) is deferred: `unsupported_lineage` is
  the honest v1 answer; remote *execution* of a spawn record still works
  via `execute --remote` since the child record is session-local.
- Contract v1 is declared stable at plugin v0.6.0 (release-0-6-0
  train); the Versioning section of `handoff-v1.md` records the rule.
