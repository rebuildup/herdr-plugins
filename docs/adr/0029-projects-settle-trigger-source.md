# ADR-0029: Projects settle triggers consume an inbox organize-transition log

Status: Accepted (release-0-9-0 candidate, Issue #181 / parent #60 T2,
implementation ticket #182)

## Context

`t3.json` script flags `runOnSettle` / `stopOnSettle` ask projects to
start (or stop) a script when the owning work "settles". #180 shipped
`runOnWorktreeCreate` end-to-end via the `worktree.created` herdr hook
event + lazy `pending_triggers` drain (ADR-0022 addendum shape). The
settle pair has no herdr event source: herdr 0.9.5
`PLUGIN_HOOK_EVENT_KINDS` is `pane.agent_status_changed` /
`pane.closed` / `worktree.*` only, and **settle is not an execution
event at all** — it is `rebuildup.inbox`'s user-side organize state
(`settle`/`snooze`/`restore`, `docs/contracts/inbox-v1.md`,
`docs/specs/inbox.md`). #181 must decide whether a faithful trigger
source exists before #182 implements anything.

The four questions #181 poses, answered against the code:

1. **Is there a true event source?** Not from herdr — but inbox owns
   the state, so inbox can *publish* its own transitions. Every
   organize mutation already happens inside `updateState`'s
   single-writer lock (`plugins/inbox/src/cli.ts` `cmdOrganize`,
   `plugins/inbox/src/hook.ts`, `resolveEntry` clears in
   `plugins/inbox/src/model.ts`). Appending a bounded transition record
   inside those same mutations yields a faithful, ordered log — this
   is the plugin disclosing state it owns, not a fabricated event.
2. **Can `agent_status_changed` substitute?** No. `pane.agent_status_changed`
   reports the *agent execution* lifecycle (working/idle/done/blocked);
   inbox `settle` is a *user organize* decision recorded against
   `state_change_seq` + `agent_session` generation signals
   (`plugins/inbox/src/model.ts` `markExpiredOrAdvanced`). Mapping
   "agent went idle" onto "user settled the thread" would fabricate
   upstream T3 semantics and would also fire on every routine status
   flip. Rejected; the distinction is contract-level, not cosmetic.
3. **Automations boundary?** Automations' `event` schedules subscribe
   only to herdr hook events delivered via manifest `[[events]]`
   (`docs/contracts/automations-v1.md` §Event triggers). Bridging inbox
   transitions into automations would need a second cross-plugin
   contract for no v1 consumer. Projects reads the inbox surface
   directly — the shallowest dependency (same ADR-0013 pattern usage→
   conversations already uses). A future automations `inbox.*` event
   source can reuse the same surface without contract change.
4. **stopOnSettle kill path?** Reuses the ADR-0010 runner: `runs.json`
   already records `repo.root`, `pane_id`, `result`, and (since #180)
   `trigger`. `stopRuns` (`plugins/projects/src/runner.ts`) already
   implements the honest stop sequence — `ctrl+c` → grace → bounded log
   capture → `pane.close` → `result:"stopped"`, `pane gone` →
   `"unknown"`, never a fabricated success. What is new is only the
   *selection* of which running runs a settle stops (below).

## Decision

**Option (a): `herdr-plugins.inbox/v1` gains an additive
organize-transition read surface; `rebuildup.projects` consumes it
through the public CLI (ADR-0013 pattern) and lazy-drains it inside the
existing `scripts` command family.** Settle triggers are implementable
in release-0-9.0; #182 proceeds.

### Inbox side (contract addition, implemented by #182)

- `InboxState` gains an optional per-session log:
  `transitions?: Record<sessionKey, { seq: number; dropped: number; items: InboxTransition[] }>`.
  `seq` is a per-session monotonic counter — the cursor. `items` is
  capped (500/session, oldest dropped, `dropped` counted) matching the
  existing entry-cap discipline.
- `InboxTransition` records, at mutation time inside the same
  `updateState` critical section: `{ seq, at, kind, pane_id,
  workspace_id?, cwd?, agent_status?, state_change_seq?,
  agent_session?, cause? }` where `kind` is `settled` | `snoozed` |
  `restored` | `cleared`. `cleared.cause` ∈ `expired` |
  `generation` | `session_mismatch` | `pane_closed` | `pruned`.
  `cwd`/`workspace_id`/`agent_status`/`state_change_seq`/
  `agent_session` are captured from the pane+agent snapshot already
  loaded by the mutating command — no extra socket calls, no PTY text.
- New read-only command **`transitions`**:
  `inbox transitions [--after <seq>] [--limit <n>] [--session|--socket]`
  → `{contract, command:"transitions", session_key, head_seq,
  oldest_seq, dropped, transitions[]}`. `--after` is exclusive;
  default returns the newest page. `head_seq`/`oldest_seq` let the
  consumer detect a cursor older than retention (`cursor_expired`)
  instead of silently missing transitions. Read-only: it resolves
  expirations via the same `resolveState` path as `list` but mutates
  nothing it does not already mutate on any read.
- `capability.commands`/`events` unchanged in shape; `commands` gains
  `transitions`. Additive within v1 per the versioning clause.

### Projects side (consumer, implemented by #182)

- New lazy drain `drainSettleTriggers`, invoked at the top of
  `scripts tick|run|stop|results|logs` next to
  `drainWorktreeTriggers` (same no-daemon discipline, ADR-0002).
- **Source resolution (ADR-0013):** locate the inbox plugin root via
  `--inbox-root`/config override → sibling `../inbox` →
  `herdr plugin list --json`; spawn `bun run <root>/src/cli.ts
  transitions` with `HERDR_PLUGIN_STATE_DIR`/`_CONFIG_DIR` pinned to
  the *inbox* dirs and `HERDR_PLUGIN_ID=rebuildup.inbox` — the ambient
  projects env must never redirect inbox state (same env-pinning as
  `plugins/usage/src/source.ts`). Inbox absent/unrunnable → the drain
  reports `inbox_unavailable` and consumes nothing; it is never an
  error that fails the `scripts` command.
- **Cursor:** projects state gains
  `settle_cursors: Record<inboxSessionKey, seq>`. The `transitions`
  response's `session_key` is stored verbatim — projects never
  recomputes inbox's `hostname + canonical socket` key itself.
  Draining covers the session the CLI invocation resolves (same
  `--session`/`--socket`/default-socket options as the command); other
  sessions' logs drain on invocations targeting them. Documented v1
  limitation, same laziness class as `pending_triggers`.
- **Per `settled` transition:**
  - Collapse check *within the drained batch*: if a later `cleared`
    (any cause) or `restored` for the same `pane_id` appears after the
    `settled`, the net effect is un-settled → skip with reason
    `settle_superseded`. Transitions are ordered by `seq`, so this is
    deterministic.
  - Resolve `cwd` → `resolveRepo` → worktree root + `git-common-dir`
    → `matchProject` (the #180 path, `plugins/projects/src/triggers.ts`).
    Non-git/unreachable → skip `not_a_repo`/`repo_unreachable`;
    unregistered → `repo_not_registered`; ambiguous →
    `ambiguous_project`.
  - Script resolution: #50 layered resolution on the resolved worktree
    root, `runOnSettle === true` scripts fire via the unchanged
    `startRun`; `repoRoot` = the settled pane's worktree root
    (upstream runs the script in the settled thread's checkout).
    `ScriptRun.trigger` gains kind `"inbox.settled"` carrying
    `{pane_id, transition_seq, transition_at}` — additive, same audit
    role as `worktree.created`.
  - **Idempotency:** before firing, skip if a run already exists with
    `trigger.kind === "inbox.settled"` and the same
    `transition_seq` (covers crash-between-execute-and-cursor-advance).
    The cursor advances to `head_seq` only after the batch is
    processed; a mid-batch crash replays at most the un-acked tail,
    absorbed by the run-record dedupe above.
- **stopOnSettle:** for each `settled` transition (same
  supersede/collapse and repo-resolution rules), find `running` runs
  whose recorded `repo.root` canonicalizes to the *same worktree root*
  as the settled pane's `cwd` resolution **and** whose script —
  re-resolved via the #50 layers for that repo root — has
  `stopOnSettle === true`. Stop them through the existing `stopRuns`
  sequence (ctrl+c → grace → bounded log → pane close → `stopped`;
  pane gone → `unknown`). There is no `stop_unconfirmed` state and
  none is added: `unknown`/`stopped`/`already_finished`/`pane_gone`
  already are the honest outcomes (#182's wording maps onto these).
  Runs of *other* worktrees in the same repo group are NOT stopped —
  settle is per-thread/per-checkout, matching upstream semantics;
  stopping the whole repo group would kill sibling threads' scripts.
- All skips/fires report in the payload's `triggers` block alongside
  the worktree drain, with `source: "inbox.settled"` distinguishing
  them. `capability` advertises the new trigger kinds.

### Why not the alternatives

- **(b) CLI reads only, no contract addition:** `list` exposes current
  organize state but has no history or cursor — polling cannot
  distinguish "settled at T" from "was already settled", and cannot
  order settle→clear pairs. A transition log *is* required; delivering
  it via the public CLI keeps (b)'s no-state-sharing property. (a)
  subsumes (b).
- **Direct state-file reads** of `inbox/state.json`: forbidden —
  cross-plugin durable-state reads are not an integration mechanism
  (ADR-0013 context; AGENTS §4 config/state boundary).
- **`agent_status_changed` as settle:** conflates execution state with
  user organize state (§Context Q2). Rejected outright.
- **(c) infeasible / won't-do:** rejected — every required primitive
  (single-writer mutation point, bounded log, cursor read, ADR-0013
  source resolution, ADR-0010 runner stop path) already exists.

## Invariants check

- Execution state stays herdr-owned; organize state stays
  inbox-owned. Transitions are inbox's own publication — no herdr
  event is fabricated and `agent_status_changed` is never reinterpreted.
- Attention is never hidden: the log is read-only w.r.t. inbox view;
  `attention`/`in_inbox` semantics untouched.
- Single-writer discipline: transitions append inside the existing
  `updateState` lock + tmp+rename; projects cursors/runs use their own
  locks. No cross-plugin state file is opened.
- Unsupported/stale is honest: `cursor_expired`, `inbox_unavailable`,
  `settle_superseded`, `session_unreachable`-class skips are reported,
  never silent; run results keep the existing truthful enum.

## Consequences

- #182 implements: inbox `transitions` log + command + contract/spec
  update; projects `drainSettleTriggers` + `inbox.settled` trigger
  kind + stopOnSettle selection + tests. Both plugins version-bump
  compatibly (additive only).
- Automations can later add an `inbox.*` event source over the same
  `transitions` surface without contract change — explicitly out of
  scope here.
- v1 limitation: drain covers only the session the invoking CLI
  resolves; multi-session hosts drain per-target-session invocation.
- `cleared`/`snoozed`/`restored` kinds are recorded for surface
  completeness even though projects v1 consumes only `settled`; they
  are the honest record of organize mutations, cheap at write time.
