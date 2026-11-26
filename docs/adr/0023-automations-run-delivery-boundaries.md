# ADR-0023: Automations run delivery model, idempotency, and plugin boundaries

Status: Accepted (release-0-7-0 candidate, Issue #137 / parent #32 T1)

## Context

T3 Code scheduled tasks deliver each run's prompt into a thread whose
mode is `new_thread` | `continue` | `fresh_session`
(`ScheduledTaskThreadMode`, t3code @ `9cc4018c`). herdr has no
"thread" object; the durable identities are pane/agent/workspace/tab
(ADR-0021). This ADR fixes the v1 run-delivery model, the idempotency
and missed-run contract, the MCP surface decision, and the
responsibility boundaries versus #30 (MCP), #60 (project-scripts
auto-triggers), and #146/#147 (event/webhook triggers).

Measured herdr capability (installed herdr 0.9.5, protocol 22 —
same survey as ADR-0021):

- `agent.prompt` delivers text to a pane's RUNNING agent.
- `agent.start` launches an agent in an existing pane/surface;
  `workspace.create`/`tab.create`/`pane.split`/`worktree.create`
  provide surfaces (ADR-0010, ADR-0021).
- No API starts "a subagent of an agent"; provider-internal subagents
  are not herdr agents.

## Decision

### 1. Run destination model

A task's `destination` is one of:

- **`{kind: "pane", pane_id}`** — deliver via `agent.prompt` to the
  agent already running in that pane. Requires a live agent at fire
  time; a missing/closed pane fails the run honestly
  (`destination_unavailable`). This is the analogue of T3 `continue`.
- **`{kind: "launch", surface, agent, launch_args?}`** — create a
  fresh agent via `agent.start` (surface = existing
  `workspace_id`/`tab_id`/`pane_id` target or a new
  workspace/tab). Every run is a new agent with a fresh provider
  session — the analogue of T3 `new_thread` and `fresh_session`
  (herdr cannot bind a durable "thread", so `continue`-across-runs
  for launched agents is expressed by pointing `destination` at the
  `pane` the first run produced, an explicit user act).

T3 thread-mode mapping (documented, not schema-identical):

| T3 `threadMode` | herdr v1 expression |
| --- | --- |
| `new_thread` | `destination.kind = "launch"` (new agent per run) |
| `continue` | `destination.kind = "pane"` pinned to the bound agent's pane |
| `fresh_session` | `destination.kind = "launch"` (fresh provider session is inherent to `agent.start`) |

The prompt is prefixed with a structured provenance marker
(`[automations] task <task_id> run <run_id>` style, finalized in
#145) so automation-originated input is distinguishable from user
input — same intent as T3's `[T3 Code: scheduled task …]` tag.
Automations never inject into panes/agents they did not create or
explicitly target, and never scrape PTY text for success (AGENTS §4;
run status observes `agent_status`/API results only).

`agent.prompt` to a busy agent is left to herdr semantics (queued
input); the plugin does not gate on `agent_status` beyond existence —
recording the observed status at delivery time, not inventing one.

### 2. Invocation of `handoff` / `controls`

Consistent with ADR-0021 §6: automations own *when* a run happens;
handoff owns *context transfer*. A v1 `launch` destination MAY
specify an optional `handoff_record_id` that the run resolves through
`rebuildup.handoff`'s public CLI/contract before prompting — i.e. the
automation *invokes* handoff, it does not reimplement it, and there
is still no automatic handoff on provider failure or idle timeout
(that remains automation-scheduled explicit behavior only). If #145
finds the seam awkward, `via: "handoff-execute"` is the reserved
extension; the default `via` is `"direct"`.

### 3. Idempotency and missed runs (contract summary)

- **Idempotency key**: `task_id + scheduled_for`. `scheduled_for` is
  the occurrence instant computed by the *plugin* from the schedule
  (drivers never choose it). A `fire`/`tick` that finds an existing
  run record for the key in `scheduled | running | success | failed`
  returns that record — no duplicate execution. `missed | skipped |
  cancelled` records do not block a legitimate later fire of the same
  key only when the driver explicitly retries; v1 has no automatic
  retry.
- **Manual runs**: `run-now` creates a run with `trigger: "manual"`
  and `scheduled_for: null`; it never collides with scheduled
  occurrences.
- **Missed runs**: reads (`list`, `get`, `runs`) resolve occurrences
  that passed without a run record deterministically into `missed`
  entries (lazy resolution, ADR-0002 path 1). `misfire` policy per
  task: `skip` (default — mark missed, never run late) or
  `run_once` (next `tick` fires the most recent missed occurrence
  once, then resumes the schedule).
- **Offline**: herdr/socket unreachable at fire time → the fire
  fails with a transport error and NO run record is fabricated; the
  occurrence resolves as `missed` on next read. There is no store-
  and-forward queue in v1.
- **State**: `HERDR_PLUGIN_STATE_DIR/state.json`, single-writer
  file lock + atomic rename (ADR-0001); all mutations serialized.

### 4. MCP surface (#30 boundary)

**CLI-only in v1** — same decision shape as ADR-0021 §5 for handoff.
#30 (MCP for outside agents) owns whether/how `schedule_task`-style
tools wrap this CLI; the contract
(`herdr-plugins.automations/v1`) is the input it would consume.
Webhook-URL-class secrets, if ever exposed, follow the T3 rule that
only run-authorized callers see them — deferred to #147. The #30
dependency is a soft, non-blocking note in the feature ledger.

### 5. #60 project-scripts boundary

- project-scripts `runOnWorktreeCreate`/`runOnSettle`/`stopOnSettle`
  trigger **script execution** in dedicated panes (ADR-0010);
  automations trigger **agent prompts / agent launches**. They share
  the "external trigger source" problem but own different run
  targets — neither subsumes the other.
- A script CAN be an automation destination only indirectly (a
  `pane` destination pointing at a pane running the script is not
  supported; `launch` starts agents, not scripts). If a use case
  needs "run script X on schedule", the v1 answer is a thin user
  wrapper or a future `destination.kind = "script"` — recorded as a
  candidate, not built.
- The shared upstream gap (structured worktree/settle events) is
  recorded once in ADR-0022's gap list and applies to both plugins.

### 6. v1 scope confirmation (from #32 research)

| Upstream capability | v1 disposition |
| --- | --- |
| `interval` (≥ 60 s), `fixed_time`, `once` | **In scope** — contract schedule union |
| `webhook` (HMAC, filters, dedupe/coalesce) | **Reserved, not accepted** — schema reserved; `create` returns `unsupported_schedule` until #147 decides opt-in `serve` vs upstream gap |
| `event` triggers (`[[events]]` hooks) | **Reserved** — contract marks `event` schedule as planned for #146; not in the accepted v1.0 union |
| Multi-stage durable workflow / question-approval orchestration | **Out of v1** — T3's orchestrator (`delegate_task`, `task_status`, `task_cancel`) is a separate system; herdr composition uses handoff `delegate`/`merge-back` invoked explicitly. Revisit only if a concrete unmet requirement is shown (feature-ledger acceptance rule) |
| Issue/PR (forge) events | **Out of v1** — needs a polling clock (daemon conflict) or webhook inbound (upstream gap); revisit after #147 |
| pause/resume/run-now/delete, run history | In scope (#144) |
| MCP `schedule_task` surface | Out of v1 — CLI-only; #30 decides exposure later |

### 7. Upstream gap candidates (recorded, filing deferred to #147/T5)

1. **herdr timer/scheduled hook** — a first-class `[[events]]`-style
   timer or `plugin.schedule` registration would retire the OS/watch
   drivers. Candidate Issue on `herdrdev/herdr`.
2. **Inbound webhook HTTP path** — no inbound HTTP or tunnel
   equivalent of T3 Connect; blocks `webhook` schedules (#147).
3. **Structured worktree/settle events** — `events.subscribe`
   exposes pane lifecycle but not settle/worktree-created signals
   #60/#146 need; shared candidate Issue.

Filing is deferred to #147 so webhook feasibility and the event-gap
wording are decided once; this ADR is the pointer of record.

## Consequences

- Contract `herdr-plugins.automations/v1` carries `destination`,
  `misfire`, run `trigger`, and the `task_id + scheduled_for`
  idempotency key as normative fields (see contract doc).
- #144 (registry) implements records/state/CRUD against this
  contract; #145 implements `tick`/`fire`/drivers/delivery; #146 adds
  the `event` schedule (manifest-hook marks + lazy drain — ADR-0022
  addendum); #147 resolves `webhook`.
- No new upstream workaround is introduced: firing uses OS
  schedulers/watch (ADR-0002 path 3 family), delivery uses existing
  socket APIs only.
