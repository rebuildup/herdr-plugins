# ADR-0026: Automations webhook triggers — upstream gap, not opt-in `serve`

Status: Accepted (release-0-7-0, Issue #147 / parent #32 T5)

## Context

T3 Code webhook automations accept inbound HTTP deliveries, verify
HMAC-SHA256 signatures, apply filters, dedupe/coalesce, and template
the body into a prompt (`apps/server/src/scheduledTasks/webhook*.ts`
@ `9cc4018c`). herdr 0.9.5 / protocol 22 has **no inbound HTTP
surface**: plugins get outbound socket RPC plus `[[events]]` /
`[[startup]]` manifest hooks only. ADR-0023 reserved the `webhook`
schedule type and deferred the feasibility call to this ticket.

Constraints (AGENTS §4, ADR-0002):

- No resident daemon, no HTTP server. A long-lived listener is a
  daemon regardless of who starts it; ADR-0002's sanctioned
  exceptions are bounded one-shot processes (`_wake`, inbox `watch`,
  automations `watch`/`schedule tick`).
- "Unsupported ... is never reported as success" — a webhook surface
  that cannot receive deliveries must not pretend to.

## Decision

**`webhook` schedules are unsupported in v1.0 — permanently for this
contract version — and are recorded as an upstream gap. No
`automations serve` command ships.**

Rejected options, per #147's menu:

- **(b) opt-in foreground `serve`** — rejected. A user-started HTTP
  listener is still a resident server the plugin owns: it re-opens
  the ADR-0002 question for every install, needs its own auth/TLS/
  rate-limit story (HMAC alone does not bound body size, replay, or
  DoS on a localhost-bound port reachable via tunnels the user may
  not intend), and duplicates what T3 delegates to its managed
  relay. The marginal value over `event` schedules + OS `schedule`
  drivers does not justify a second lifecycle model in the same
  release. If a concrete requirement appears, it is a new ADR, not a
  quiet add.
- **(c) saved-machine / Tailscale path** — rejected for v1. It is a
  deployment topology, not a protocol: without an inbound endpoint
  there is still nothing to receive the webhook. Revisit only if
  herdr or a sibling plugin gains an inbound path.
- **(a) upstream gap** — adopted. `webhook` stays schema-reserved:
  stored records may carry it, `create`/`update` reject with
  `unsupported_schedule` (contract §Error model), and the run
  `trigger:"webhook"` enum value remains reserved.

### Offline/missed semantics (recorded, not implemented)

herdr is not always-on; there is no store-and-forward queue. Any
future inbound path inherits the contract's existing honesty rules:
requests that arrive while nothing is listening are the sender's
problem (sender-side retry, e.g. GitHub Redeliver), never silently
buffered or fabricated into runs.

## Upstream gap filing decision

ADR-0023 §7 listed three candidates (timer hook, inbound webhook,
structured worktree/settle events). **No Issues are filed in this
release.** Rationale: prior herdrdev/herdr feature requests —
including #6199 "remote MCP / inbound HTTP" and #6196/#6197/#6200 —
were closed by the rate-limit bot without maintainer review, so
filing is currently futile and would add noise. The gaps stay
recorded here and in the feature ledger as *known-declined*: revisit
filing when the upstream repo shows maintainer engagement again, or
when a concrete blocked use case is demonstrated (feature-ledger
acceptance rule). This ADR is the pointer of record.

## Consequences

- Contract `herdr-plugins.automations/v1` finalizes as **STABLE**
  with `webhook` permanently out of the accepted schedule union;
  `serve` is absent from `planned_commands`.
- Spec/README state the unsupported classification and the
  resolution condition: herdr gains an inbound HTTP/tunnel API (or
  an equivalent plugin webhook hook), at which point `webhook`
  schedules can be designed against it without a contract break —
  the reserved schema slot remains.
- Feature ledger records the webhook sub-feature as
  `upstream-blocked`; the automations feature itself stays
  `plugin`.
- MCP note (ADR-0023 §4) is moot for v1: with no webhook endpoint
  there is no webhook-URL secret class to expose; a future #30
  `schedule_task` surface wraps only the accepted schedule types.
