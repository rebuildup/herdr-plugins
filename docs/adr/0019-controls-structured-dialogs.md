# ADR-0019: Structured dialogs (approval/question/attachments/goals) are an upstream gap — v1 ships `unsupported`, PTY keys are the interactive fallback

Status: Accepted (release-0-6-0 candidate, Issue #102 / parent #27 T4)

## Context

Issue #102 is the final decomposition ticket of #27
(Provider Controls/Composer). The #27 feasibility research and the
merged T1–T3 implementation established the facts this ADR binds:

- herdr has **no structured dialog API**. `agent.prompt` rejects a
  `blocked` agent with `agent_blocked` before input is sent
  (`src/app/api/agents.rs`, verified against vendored herdr 0.9.5);
  `pane.report_agent`'s `message` field is a status annotation, not a
  structured approval/question channel.
- There are no structured events for approval requests, questions,
  attachment requests, goal state, or subagent-approval aggregation —
  the same root as #8 attention granularity. Screen-manifest detection
  of dialogs is itself fragile upstream (dozens of open
  misclassification issues, e.g. herdrdev/herdr#6063, #6141, #4668).
- Typing into an open dialog via `agent.prompt`/`send_keys` is not a
  safe fallback: upstream issues document prompt text being submitted
  *as the dialog answer* (herdrdev/herdr#6081, #5263; closed #2788).
- The #101 verdict already deferred plugin-side queue/steer because
  herdr exposes no message-admission contract.

The issue asks for three candidate paths to be judged:

- (a) request a structured dialog API from herdr upstream;
- (b) have the plugin speak provider-native protocols (e.g. ACP)
  directly;
- (c) declare the surface `unsupported` in v1 and keep PTY-level key
  injection as a clearly separated interactive fallback.

## Decision

**All three, in this order: (a) file the upstream request, (b)
reject, (c) ship.**

1. **Upstream request filed.** herdrdev/herdr#6196 requests structured
   dialog events plus a wait/respond API (`agent.dialog.wait` /
   `agent.dialog.respond` shape, `pane.agent_dialog_changed` event,
   file-path attachment references, subagent-approval aggregation as
   follow-up scope). The adjacent message-admission gap is filed
   separately as herdrdev/herdr#6197 (queued message / steer session
   concept) per the #101 verdict. `agent_session_path` exposure was
   already filed as herdrdev/herdr#6191 and closed upstream
   NOT_PLANNED — recorded here so consumers know path-kind resume for
   claude/codex stays unavailable by upstream decision, not by plugin
   omission.

2. **Provider-native protocol path rejected for v1.** A plugin that
   spoke ACP (or any provider protocol) directly would create a second
   provider execution channel beside herdr's PTY authority: it could
   not honestly report `agent_status`/`blocked` (herdr observes the
   TUI, not the side channel), would bypass herdr's detection,
   session-report, and lifecycle model, and edges toward the
   "independent provider execution foundation" the #27 scope
   forbids. Revisit only if upstream sanctions a plugin-facing
   structured channel; until then ACP details stay provider business.

3. **v1 contract declares structured dialogs `unsupported`.**
   `capability` gains a `dialogs` table —
   `approval`, `question`, `attachments`, `goals`,
   `subagent_approvals` — each `status: "unsupported"` with a reason
   and the upstream reference. `send`/`command` keep failing blocked
   targets with `requires_interactive_input`; nothing reports dialog
   success that herdr cannot observe.

4. **PTY interaction is the documented interactive fallback, not a
   dialog API.** `interrupt` (`agent.send_keys`, `pty_level: true`)
   and `read` (`agent.read` scrollback, `scrollback: true`) are the
   sanctioned tools for a human or agent driving a dialog by hand.
   The contract and `requires_interactive_input` hints point callers
   there explicitly; the fallback is fragile by nature (screen-layout
   and keybinding dependent) and is never labeled structured.

5. **Attachments and goals get honest partial coverage, not new
   surface.** Images/binary attachments have no provider-agnostic
   structured path — v1 supports file-path *references* inside prompt
   text via `send`/`command` only (provider TUI decides whether it
   attaches anything; unverified). Goal state tracking is unsupported;
   provider slash commands such as `/goal` pass through `command` as
   fragile text, same as `/model`/`/clear`. GUI composer features
   (quote chips, stash UI, composer decoration) remain herdr-t3
   scope — confirmed out of bounds here.

## Consequences

- `herdr-plugins.controls/v1` is final: command surface, identity
  guards, error `kind` taxonomy, launch table, provider command table,
  and the dialogs capability table are the stable contract (plugin
  v0.6.0, release-0-6-0 train).
- Consumers (#6 handoff, #29 textgen, herdr-t3) can feature-detect
  dialog support via `capability.dialogs` instead of probing; when
  herdrdev/herdr#6196 lands, a v2 (or additive minor) contract can
  expose it without breaking v1.
- The interactive fallback is a deliberate, labeled degradation —
  better than silent PTY scraping, and strictly better than the
  upstream-documented hazard of prompt text landing inside an open
  dialog.
- Upstream tracking: #6196 (dialogs), #6197 (queue/steer), #6191
  (session path, declined). #8 attention granularity remains the
  shared root for detection-side gaps.
