# ADR-0020: textgen agent-task guards and next-prompt watch

Status: Accepted (release-0-6-0 candidate, Issue #109 / parent #29 T3)

## Context

T1 (#107) built the generation core and T2 (#108) the git/forge input
adapter; both `review_guide` and `next_prompt` were already registered
as agent-only tasks but had no dedicated execution semantics. #109
requires:

- `review_guide`: read-only multi-step repository investigation — the
  largest subscription cost of any task (upstream parity: agent
  required, text-generator API unsupported).
- `next_prompt`: predicted next composer prompt after a turn completes —
  needs an `agent_status` transition trigger, not a one-shot CLI call.
- Cheap preconditions before spawning an agent pane: provider
  availability and optional quota signals.
- Timeout / interrupt / cleanup honesty for long-running agent tasks.

Constraints from #29 and repo invariants: opt-in and cost caps must be
structural (ADR-0018 discipline); herdr remains sole PTY authority;
plugins must not hard-depend on sibling plugins (ADR-0013 pattern);
unsupported/stale data is never reported as success.

## Decision

1. **Task-level opt-in for expensive generation.** `TaskSpec` gains
   `requiresOptIn`; `review_guide` sets it. `generate` runs
   `checkGenerationGuards` after provider resolution and before any
   transport call: the task fails with `task_not_opted_in` (`policy`)
   unless `guards.expensiveTaskOptIn` is `true` in config.json or the
   caller passes `--allow-expensive`. Opt-in is per-invocation
   overridable but never implied.
2. **Availability guard, fail-open.** When `server.agent_manifests` was
   reachable, the resolved agent kind must appear in it — otherwise
   `provider_unavailable` (`unavailable`) before a workspace is
   created. When manifests are unreachable the call proceeds with an
   `agent_availability_unverified` warning: `agent.start` remains the
   authority on whether a kind exists, so this guard can only prevent
   known-bad spawns, never invent availability.
3. **Quota guard, opt-in and soft.** `guards.quota.enabled` probes
   `rebuildup.usage`'s read-only `quota --provider <kind>` command
   through the sibling-plugin CLI contract (`herdr-plugins.usage/v1`,
   env-scrubbed child pinned to the usage plugin dirs — same pattern as
   the git adapter). A reported window at/above
   `guards.quota.maxUsedPercent` (default 95) blocks with
   `quota_exceeded`. Every probe failure — plugin absent, non-zero
   exit, contract mismatch, non-`ok` provider status, transport error —
   degrades to a `quota_check_unavailable` warning. The usage plugin is
   never required, and the api path never probes (it bills per-token
   under ADR-0018, a different cost model).
4. **Per-task default timeouts.** Agent-only tasks default their
   `agent.prompt` wait to `TaskSpec.defaultTimeoutMs`
   (`review_guide` 600 s, `next_prompt` 120 s) instead of the generic
   `agent.promptTimeoutMs`; `--timeout` always wins. Cleanup is
   unchanged: the executor's `finally` always attempts
   `workspace.close`, and warnings are surfaced.
5. **`watch-next-prompt` is a CLI subscription, not a hook.** The
   command subscribes to `pane.agent_status_changed` via
   `events.subscribe` for one `--pane`, seeds last-known statuses from
   `session.snapshot`, and generates `next_prompt` only on an observed
   `working → idle|done` transition. Context is the pane's recent
   scrollback (`pane.read`) or a static `--input` payload. Each
   generation reuses the full `generate` pipeline — guards, provider
   resolution, markers, output validation, workspace cleanup — so a
   watch trigger is exactly as honest as a manual `generate`.
   Results are recorded as pane metadata token `textgen_next_prompt`
   and JSONL stdout events; composer insertion and notifications are
   the caller's/herdr-t3's responsibility (generation + record only).
   Generations are sequential, debounced (`--debounce-ms`), and bounded
   by `--once`/`--max-triggers`/per-task timeout; per-trigger failures
   emit `next_prompt.error` and never kill the watch. SIGINT/SIGTERM
   closes the subscription; an in-flight generation finishes within
   its timeout and its workspace is still cleaned up.

## Consequences

- `review_guide` cannot fire accidentally: no opt-in, no pane, no cost.
- Quota protection is available without coupling releases: enabling it
  against an older `rebuildup.usage` simply warns.
- `watch-next-prompt` is interruptible and leaves no pane residue; the
  dedicated generation workspace is short-lived and always closed.
- A watcher that attaches mid-turn (snapshot seed ≠ `working`) does not
  fire on the next settle — an accepted false-negative over a
  false-positive.
- If a future need arises for richer quota signals (per-window policy,
  cost estimates), they extend `guards.quota` without contract changes.
