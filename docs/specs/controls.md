# Controls plugin (`rebuildup.controls`) — specification

Scope: agent operation core over herdr's `agent.*` socket API —
send / command (provider slash passthrough) / wait / interrupt /
read / rename / start (launch-time
controls). Contract: `herdr-plugins.controls/v1`
(`docs/contracts/controls-v1.md`). Design: ADR-0017, ADR-0018,
ADR-0019. Decomposition of #27 Provider Controls/Composer: T1 core
(#99), T2 launch-time controls (#100), T3 slash passthrough +
queue/steer verdict (#101), T4 structured-dialog upstream gap +
contract finalization (#102); #6 handoff destination control and
#29 textgen generation-pane control are intended consumers of this
surface.

## Purpose

Give agents, the TUI, the CLI, and external clients (herdr-t3) one
versioned way to operate detected agents — submit prompts, await
status transitions, interrupt, inspect scrollback, and rename —
without any plugin reimplementing PTY handling or inventing agent
state. herdr remains the sole execution authority.

## Identity and resolution

- `<target>` is a herdr agent target (pane id or agent name) passed
  verbatim to `agent.get` / the `agent.*` methods; herdr resolves it.
- Before every operation the CLI resolves the target via `agent.get`
  and echoes the full identity: host, herdr session, workspace/tab/
  pane ids, `agent` kind, `agent_session` ref, `state_change_seq`,
  `agent_status`, `interactive_ready`, `launch_pending`.
- Optional per-invocation guards `--expect-pane`,
  `--expect-state-seq`, `--expect-agent-session` pin the generation
  the caller observed (same signals inbox/checkpoints use for
  organize-state staleness). A mismatch aborts with
  `stale_generation` before the `agent.*` mutation is sent — control
  operations are never applied to a reused pane id or a different
  agent session.
- The plugin keeps **no durable state**: there is nothing to go stale
  between invocations, and every guard is evaluated against a live
  `agent.get`.

## Commands

| Command | Upstream API | Mutating? | Notes |
| --- | --- | --- | --- |
| `capability` | — (offline) | no | Contract/version/command discovery, per-operation API mapping, provider matrix, upstream gaps. |
| `send <target> <text...>` | `agent.prompt` | yes | `--wait`/`--wait-until`/`--timeout-ms` map to `wait{until[],timeout_ms}`. `blocked` target → `requires_interactive_input`, prompt never sent. |
| `command <target> <slash-cmd> [args...]` | `agent.prompt` | yes | Provider slash-command passthrough: submits literal `/name args` text (bracketed paste + Enter). Fragile/provider-TUI dependent; advisory per-provider command table in `capability.providers[].commands`. |
| `wait <target>` | `agent.wait` | no | `--until` repeatable, `--timeout-ms`; upstream default until = idle/done/blocked. |
| `interrupt <target>` | `agent.send_keys` | yes (PTY) | PTY-level keys only — default `esc`; `--key`/`--keys` customize. No structured interrupt exists upstream. |
| `read <target>` | `agent.read` | no | Scrollback (`--source`, `--lines`, `--format`, `--no-strip-ansi`); not structured history — see `rebuildup.conversations`. |
| `rename <target>` | `agent.rename` | yes | `--name NAME` or `--clear`. |
| `start <pane_id>` | `agent.start` | yes | `--agent KIND` required; `--name` (default `<kind>-<rand>`), `--model`, `--reasoning`, `--permission-mode`, `--resume`/`--resume-from`, `--arg`, `--timeout-ms` (startup readiness wait), optional `--wait*` post-launch `agent.wait`. |

## Semantics and honest limits

- **No fabricated state.** `agent_status`, `state_change_seq`, and
  `agent_session` come only from herdr (`agent.get` / snapshot). The
  plugin never parses PTY text into statuses.
- **Blocked send.** herdr 0.9.5 `agent.prompt` rejects an already
  `blocked` agent with `agent_blocked` before input is sent (verified
  upstream, `src/app/api/agents.rs`). The CLI additionally pre-checks
  via `agent.get` and returns `requires_interactive_input` without
  calling `agent.prompt` — identical outcome, structured earlier, and
  guaranteed not to report success.
- **Interrupt is PTY-level.** `agent.send_keys` injects key names into
  the terminal; effect depends on the provider's keybindings. The
  result marks `pty_level: true`.
- **Read is scrollback.** `agent.read` returns terminal text
  (`visible|recent|recent_unwrapped|detection`, `text|ansi`), not a
  structured event history. Conversation history is
  `rebuildup.conversations`' job (#5).
- **Unsupported is explicit.** Unknown/unresolvable targets surface
  the upstream RPC error code as `error.kind`; unreachable sessions
  surface `session_unreachable`; upstream gaps are enumerated in
  `capability.upstream_gaps` (structured interrupt, queue/steer,
  structured approval/question dialogs, structured history,
  `agent_session_path` for claude/codex).
- **Launch options are provider-verified.** `start` maps
  model/reasoning/permission-mode/resume to provider CLI args through
  an explicit per-kind table (`plugins/controls/src/launch.ts`).
  Providers without a verified mapping fail
  `unsupported_launch_option` before `agent.start` — the plugin never
  fabricates flags or relies on implicit provider defaults. Resume
  argv mirrors herdr's own `agent_resume.rs` plan; `--resume-from`
  reuses the reported `agent_session` (id/path kind checked).
- **`--arg` is screened, not blind.** Passthrough args reject control
  characters and a privilege-escalation denylist (bypass/never-ask/
  danger-full-access flags); `--unsafe-args` is the explicit,
  result-echoed opt-out (ADR-0018).
- **`command` is text passthrough, not a command API.** herdr 0.9.5
  `agent.prompt` encodes `text` as bracketed-paste bytes plus an
  Enter key (`src/app/api_helpers.rs::encode_api_submission_parts`,
  `src/app/api/agents.rs::submit_agent_prompt` →
  `queue_user_input_submission` — an input-submission queue, not a
  message queue). `send_keys` is *not* the mechanism. The built text
  always starts with `/name` because provider commands only run at
  message start (T3 Code `docs/user/composer.md`); whether the
  provider TUI honors it is unverified and version-dependent, so
  results echo `fragile: true` and `known_command` from the advisory
  table (`plugins/controls/src/commands.ts`). Unknown commands are
  still forwarded — the table is a hint, not a gate.

## Queue/steer feasibility verdict (Issue #101)

T3 Code follow-up behavior has two modes: **queue** (persist the
message for a later turn; editable, ordered, survives stop/restart)
and **steer** (inject into the running turn immediately). Verified
against herdr 0.9.5 (`herdr api schema` protocol 22 +
`src/app/api/agents.rs`):

- **No queue/steer API exists upstream.** The `agent.*` surface has
  no queued-message or steer method; `agent.prompt`'s only
  admission gate is `agent_status == blocked` → `agent_blocked`.
  A `working` agent accepts `agent.prompt` — the text is typed into
  the PTY and the *provider TUI* decides what to do with it.
- **Steer is emergent, not guaranteed.** Whether a prompt submitted
  mid-turn steers the running turn, queues provider-side, or is
  rejected is provider behavior (e.g. Claude Code queues follow-ups
  natively). herdr exposes no signal distinguishing these outcomes;
  `agent.wait` observes only coarse `agent_status` transitions.
- **Queue is an upstream gap.** Faithful queue semantics (durable
  order, edit-in-place, resume-after-stop, offline hold) cannot be
  built on `agent.prompt` alone — there is no admission receipt tied
  to a turn, no edit/remove of a submitted message, and no
  cross-restart durability upstream.
- **Decision: defer plugin-side queue; record as upstream gap.** A
  plugin-state queue under `HERDR_PLUGIN_STATE_DIR` could persist
  intents, but it could not guarantee ordering vs. provider-native
  queueing or survival semantics, and would fabricate turn
  association herdr does not expose — violating the "never report
  unsupported as success" invariant. Consumers needing queue/steer
  should treat `send`-during-`working` as best-effort steer and
  detect `agent_status` transitions via `wait`. This verdict feeds
  the T4 upstream-gap ADR and candidate herdrdev/herdr issues
  (queued message / steer session concept — alongside the existing
  structured-dialog and `agent_session_path` gaps).

## Structured dialogs — upstream gap verdict (Issue #102 / ADR-0019)

herdr exposes **no structured dialog surface**: no approval/question
events, no option/answer channel, no attachment or goal-state API,
no subagent-approval aggregation. `agent.prompt` rejects `blocked`
agents (`agent_blocked`), and upstream issues document prompt text
being submitted *as an open dialog's answer* (#6081, #5263; closed
#2788) — so "type the answer" is not a safe fallback.

- **Upstream request filed**: herdrdev/herdr#6196 (structured dialog
  events + wait/respond API; attachments as file-path references;
  subagent aggregation as follow-up scope). Queue/steer is tracked
  separately as herdrdev/herdr#6197 per the #101 verdict.
  `agent_session_path` was filed as herdrdev/herdr#6191 and closed
  upstream NOT_PLANNED — path-kind resume for claude/codex stays
  unavailable by upstream decision.
- **Provider-native protocol (ACP) path rejected**: a plugin speaking
  provider protocols directly would bypass herdr's PTY authority and
  could not honestly report `agent_status`/`blocked`; it edges toward
  the forbidden "independent provider execution foundation". Revisit
  only if upstream sanctions a plugin-facing structured channel.
- **v1 declares dialogs `unsupported`**: `capability.dialogs` lists
  `approval`, `question`, `attachments`, `goals`,
  `subagent_approvals` — all `unsupported` with reasons — plus
  `interactive_fallback` (`pty_level`: `interrupt` + `read`) as the
  labeled, fragile PTY path for driving dialogs by hand.
- **Attachments/goals partial coverage**: file-path references inside
  prompt text via `send`/`command` are the only v1 route (provider
  TUI decides; unverified). Goal *state* is unsupported; `/goal`-style
  commands pass through `command` as fragile text. GUI composer
  features remain herdr-t3 scope.

## Upstream gaps (recorded, not worked around)

From the #27 feasibility research (herdr 0.9.5, protocol 22):

1. No structured interrupt API — PTY keys only.
2. No queued-message / steer session concept (see the #101 verdict
   above: steer is provider-emergent, queue deferred to upstream;
   request filed as herdrdev/herdr#6197).
3. No structured approval/question events or responses; `blocked`
   agents reject `agent.prompt` (shared root with #8 attention
   granularity; request filed as herdrdev/herdr#6196, ADR-0019).
4. `agent.read` is scrollback; `agent_session_path` is discarded by
   claude/codex adapters upstream (#6191, closed not-planned), so
   path-kind resume is unavailable for them.

## Testing

`tests/controls.test.ts`, `tests/controls-launch.test.ts`, and
`tests/controls-command.test.ts` run the
real CLI against a fake herdr socket (`net.createServer` speaking the
NDJSON protocol): identity echo, wait-option forwarding,
blocked-send rejection without an `agent.prompt` call,
key/read/rename parameter passthrough, all three generation guards,
`agent_not_found`, invalid-argument usage errors, and
`session_unreachable`; plus `start` coverage — per-provider arg
mapping, unsupported-option rejection before `agent.start`, resume
(`--resume`/`--resume-from` incl. session-kind and provider-mismatch
checks), the `--arg` privilege denylist and `--unsafe-args` opt-out,
control-character/flag-smuggling rejection, timeout bounds,
post-launch `agent.wait`, and upstream `agent.start` error codes;
plus `command` coverage — `/name args` text construction, wait-option
forwarding, known/unknown provider command reporting, blocked-send
rejection, usage validation, generation guards, and the capability
command surface; plus `capability.dialogs` asserting every structured
dialog is `unsupported` with the `pty_level` interactive fallback
(ADR-0019).
