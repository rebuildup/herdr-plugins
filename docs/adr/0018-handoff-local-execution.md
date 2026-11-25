# ADR-0018: Handoff local execution — surfaces, strategy, and honest status

Status: Accepted (release-0-6-0 candidate, Issue #104 / parent #6 T2)

## Context

T1 (#103, ADR-0017) fixed the handoff record, payload contract, and the
Agent Router boundary but executed nothing. T2 (#104) adds same-host
execution: given a `pending`/`ready` record, create or reuse a target
surface, start the provider agent, inject the bounded payload, and track
`pending → ready → delivered → done/failed/superseded`.

Constraints inherited unchanged: herdr is the sole execution authority;
stale identity is never applied; unsupported/unverifiable outcomes are
never reported as success; the Agent Router is a boundary, not a
dependency.

## Decision

1. **Surfaces via herdr API only.** Target resolution order:
   explicit flags > `record.target` hints > dedicated `workspace.create`
   (cwd inherited from `transfer.cwd`). `--target-workspace` maps to
   `tab.create`; `--target-pane` reuses an existing pane and is refused
   (`target_busy`) when herdr already reports an agent on it. The plugin
   never opens a PTY (ADR-0010 precedent: `plugins/projects` runner).
2. **`agent.start` is the only launch path.** `kind` is the first
   `.`-segment of the provider hint (`claude.openrouter` → `claude`) or
   `transfer.provider_kind`; `provider_hint` remains an opaque label —
   no `agents.toml` reads, no `agent` launcher invocation, no route
   resolution (ADR-0017 §3). `args` carries resume argv and the
   `--model` mapping only.
3. **Strategy: resume preferred, fallback recorded.** `native_resume`
   executes only when the provider table (`resume-info`) reports
   `supported` AND `transfer.agent_session.value` exists; otherwise the
   record falls back to `portable_context` with `execution.decision`
   recording why — the T3 provider-switching rule ("resume + delta,
   fresh + summary on failure") applied proactively at decision time.
   `checkpoint_ref`/`manual` stay recorded intent and are refused.
4. **Payload injection = first `agent.prompt`.** Both strategies deliver
   the same bounded preamble (refs + requirements + excerpt, ≤
   `max_prompt_chars` = 65536, overflow is `payload_too_large` not
   silent truncation). Provider-native context injection is deferred to
   the controls capability surface (#100/#27).
5. **Status is observed, never assumed.** `ready` is persisted before
   any mutation; `delivered` requires `agent.start` + `agent.prompt`
   acceptance; `done` requires `agent_status === "done"` or `"idle"`
   with `state_change_seq` beyond the pre-prompt baseline (captured via
   `agentGet` after start, before prompt). `status` lazily reconciles
   `delivered → done` from snapshot evidence and persists
   `execution.observed` — a missing target pane is reported
   (`target_check.state: "pane_missing"`), not auto-failed, because a
   user closing the pane after completion is indistinguishable from a
   crash.
6. **Failures persist `failed` with a step.** Post-`ready` errors write
   `execution.error{step,message,at}` (`surface`/`agent_start`/`prompt`)
   and exit 1 with `execution_failed`; pre-mutation refusals (stale
   source, busy pane, unreachable socket, unsupported strategy) leave
   the record untouched. `--cleanup-on-failure` closes ONLY
   plugin-created panes (`execution.target.created`); reused panes and
   the source agent are never closed or judged.
7. **Supersede is atomic with delivery.** When a record reaches
   `delivered`, sibling `pending`/`ready` records for the same
   `session_key`+`pane_id` become `superseded` in the same write —
   a newer execution replaces stale intent for the same source point.
8. **Resume capability is a seed table.** `resume-info` exposes
   per-provider `native_resume` support (`claude`, `codex` documented;
   everything else `unknown`). `rebuildup.controls` T2 (#100) owns the
   full provider option table; unlisted providers fall back rather than
   guess. `agent_session_path`-dependent resume stays unsupported until
   the upstream gap (#5 survey, #89) closes.

## Consequences

- `execute` is idempotent-safe only within `pending`/`ready`; `failed`
  is terminal for that attempt — retry means a new `create` (documented
  in the contract; avoids double surface creation).
- A `ready` record whose surface was created but `agent.start` failed
  leaves an orphan pane unless `--cleanup-on-failure` was passed; the
  pane id IS recorded in `execution.target`, so users can inspect it.
- `done` is a heuristic verdict for providers reporting `idle` at turn
  end; `agent_status === "done"` is authoritative. Consumers should
  read `execution.observed.agent_status` for the raw signal.
- T3 (#105) extends `transfer.host`/`session_key` semantics for remote
  targets; the `execution` record shape is host-agnostic already.
- T4 (#106) can hang delegation lineage off `record.id` without schema
  changes.
