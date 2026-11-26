# ADR-0018: Launch-time controls — provider arg mapping and the `--arg` privilege boundary

Status: Accepted (release-0-6-0 candidate, Issue #100 / parent #27 T2)

## Context

Issue #100 adds `start` to `rebuildup.controls`: launch a detected
agent kind in an existing shell pane via herdr `agent.start`, mapping
model / reasoning / permission-mode / resume onto provider CLI flags.

Upstream facts (herdr 0.9.5, protocol 22; `src/app/agents.rs`,
`src/agent_resume.rs`, `herdr agent start --help`):

- `agent.start{name, kind, pane_id, args?, timeout_ms?}` prepends the
  kind's canonical executable to `args`, shell-encodes the argv, and
  waits for interactive readiness (`timeout_ms` ∈ (3000, 300000],
  default 30000). Control characters in args are rejected upstream
  (`invalid_agent_argument`).
- herdr already knows how to resume every supported provider:
  `agent_resume.rs::plan()` maps a reported `agent_session` to the
  provider's resume argv (e.g. claude `--resume <id>`, codex
  `resume <id>`, pi `--session <path|id>`). That mapping is the
  canonical upstream answer to "how do you resume this agent".
- Permission modes have no herdr-level concept; they exist only as
  provider CLI flags with divergent vocabularies (T3 Code's four modes:
  supervised / auto-accept-edits / auto / full-access).
- `agent_session_path` is not exposed for claude/codex
  (herdrdev/herdr#6191), so path-kind resume is unavailable there.

The binding constraint is AGENTS.md §4 plus the issue requirement:
plugin-side arg validation must prevent *unlimited* passthrough of
privilege-escalation flags, and unsupported provider/flag pairs must be
explicit — never an implicit provider default, never a fabricated
capability.

## Decision

**`start` is a thin `agent.start` wrapper with a plugin-owned launch
table** (`plugins/controls/src/launch.ts`):

- **Structured options only where verified.** `--model`,
  `--reasoning`, `--permission-mode`, `--resume`/`--resume-from` map
  through `LAUNCH_SPECS`, an explicit per-kind table. Flag shapes were
  verified against installed provider CLIs (claude 2.1.330, codex
  0.171.0, opencode 2.3.2, pi 1.6.0) or official CLI references
  (gemini, cursor-agent); resume argv mirrors `agent_resume.rs`
  verbatim. A provider/option pair without a verified mapping fails
  `unsupported_launch_option` before any RPC. `capability.providers[]
  .launch` publishes the same table so consumers feature-detect.
- **The four T3 modes map honestly, including their gaps.** claude and
  codex map all four modes; gemini lacks a classifier-review `auto`;
  cursor and opencode map only `full-access` (`--force` / `--auto`,
  the latter still honoring deny rules); pi has no permission-mode
  launch flag at all. Where a mode has no flag, it is unsupported —
  not silently approximated.
- **Resume reuses the reported session.** `--resume <value>` is
  validated (no control chars, no leading `-`) and mapped per provider;
  `--resume-from <target>` resolves `agent_session` via `agent.get`
  and enforces provider match (`resume_session_mismatch`) and
  id/path session-kind compatibility. This consumes the same
  `agent_session` report path every other controls command echoes.
- **`--arg` passthrough is screened.** Args reject control characters
  and empty values; a denylist rejects privilege-escalation flags —
  bypass-permission/bypass-approval/danger-full-access/never-ask
  flags and their `=value` or next-argv forms, provider-scoped where a
  flag name is ambiguous (`-a`, `-s`, `-f`, `-y`, `--auto`,
  `--force`). Denied args fail `unsafe_agent_argument` before
  `agent.start`. `--unsafe-args` is the explicit, result-echoed
  (`launch.applied.unsafe_args`) opt-out for operators who accept the
  risk; structured options remain the only *sanctioned* path to
  bypass semantics, and even they only emit what the provider's own
  CLI documents (e.g. codex full-access →
  `--dangerously-bypass-approvals-and-sandbox`, claude full-access →
  `--permission-mode bypassPermissions`).
- **No durable state, no secrets.** `start` is stateless like the rest
  of the plugin; nothing is written to `HERDR_PLUGIN_CONFIG_DIR`
  because there is no setting to persist. Args are never sourced from
  the environment, so credentials cannot leak into argv/logs through
  this surface.
- **Launch confirmation is upstream's.** `agent.start`'s
  `timeout_ms` readiness wait is the launch gate; `--wait*` optionally
  adds `agent.wait` until `idle|working` with a structured timeout.
  A post-launch wait failure reports `launched: true` + identity in
  the error extras — a timed-out observation never masquerades as a
  failed or succeeded launch.

## Consequences

- Consumers (#6 handoff, #29 textgen, herdr-t3) can launch agents
  with explicit, versioned launch semantics instead of re-deriving
  provider flags; `capability` tells them exactly what each provider
  supports.
- The denylist is a policy floor, not a sandbox: a determined caller
  can always pass `--unsafe-args`, and providers evolve flags faster
  than the table. The ADR makes the boundary explicit and auditable
  rather than pretending passthrough can be made safe.
- New providers or newly verified flags extend `LAUNCH_SPECS`; until
  then they honestly report `unsupported`. Resume coverage tracks
  herdr's `agent_resume.rs` — when upstream adds a provider there,
  the plugin table should follow.
- `agent_session_path` remaining hidden for claude/codex caps resume
  at id-kind sessions for those providers until herdrdev/herdr#6191
  lands.
