# ADR-0017: Controls as a thin agent.* operation layer

Status: Accepted (release-0-6-0 candidate, Issue #99 / parent #27 T1)

## Context

Issue #27 (Provider Controls/Composer) needs agent operations —
send / wait / interrupt / read / rename — shared by #6 (handoff
destination control), #29 (textgen generation-pane control), and
external clients. The #27 feasibility research (herdr 0.9.5 API
schema protocol 22 + `src/app/api/agents.rs`) established that herdr
already exposes the needed surface: `agent.prompt`, `agent.wait`,
`agent.send_keys`, `agent.read`, `agent.rename`, `agent.get`.

The binding constraints come from AGENTS.md §4 and the #27 findings:

- herdr is the sole execution authority; plugins must not fabricate
  agent state or parse PTY text into invented statuses.
- `agent.prompt` rejects a `blocked` agent with `agent_blocked`
  before any input is sent — a plugin that reports success anyway
  violates "unsupported … is never reported as success".
- `agent.send_keys` is PTY-level key injection; there is no
  structured interrupt, queue/steer, or approval/question dialog API
  upstream.
- `agent.read` returns scrollback, not structured history.
- Control operations must never apply stale organize/control state
  to a different agent generation (pane-id reuse,
  `agent_session`/`state_change_seq` guards — same convention as
  inbox organize marks and checkpoints auto-capture (#74)).

## Decision

**New plugin `rebuildup.controls`** implementing
`herdr-plugins.controls/v1` as a *thin, stateless* layer:

- **1:1 mapping onto `agent.*` methods.** `send`→`agent.prompt`,
  `wait`→`agent.wait`, `interrupt`→`agent.send_keys`,
  `read`→`agent.read`, `rename`→`agent.rename`. Wrappers in
  `packages/herdr-client/src/agents.ts` pass parameters through and
  unwrap results tolerantly; nothing is invented.
- **Resolve-before-operate.** Every command calls `agent.get` first:
  unknown/non-agent targets fail with the upstream RPC code before
  any mutation, and the resolved identity (host/session/workspace/
  tab/pane + `agent_session` + `state_change_seq`) is echoed in every
  result.
- **Per-invocation generation guards.** `--expect-pane`,
  `--expect-state-seq`, `--expect-agent-session` abort with
  `stale_generation` before the mutating call. No durable state is
  kept, so there is no stored generation to go stale.
- **Blocked send is an explicit error.** `send` pre-checks
  `agent_status == "blocked"` via `agent.get` and returns
  `requires_interactive_input` without calling `agent.prompt` —
  matching upstream `agent_blocked` semantics while guaranteeing the
  structured kind callers can branch on.
- **PTY-level vs structured is declared, not hidden.** `interrupt`
  results carry `pty_level: true`; `read` results carry
  `scrollback: true`; `capability.upstream_gaps` enumerates the four
  upstream gaps so consumers (#6/#29/T3) can feature-detect instead
  of assuming.

## Consequences

- Consumers get one contract for agent operations; provider-specific
  input semantics remain herdr/provider business, out of scope.
- Structured approval/question handling, queue/steer, and turn
  tracking remain upstream gaps — candidates for herdrdev/herdr
  issues (tracked under #27 T4 / #8 attention granularity).
- A future `start`/`resume`/`command` surface (research T2/T3) can
  extend the same contract version or mint v2 without breaking v1
  consumers.
