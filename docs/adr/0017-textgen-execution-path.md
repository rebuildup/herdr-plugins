# ADR-0017: textgen execution path — dedicated agent pane, no headless CLI

Status: Accepted (release-0-6-0 candidate, Issue #107 / parent #29 T1)

## Context

Issue #107 implements the generation core of `rebuildup.textgen`
(parent #29, T3 Code `apps/server/src/textGeneration/` reference).
Upstream offers two generator families: **agent sessions** (a provider
agent investigates/generates inside a session) and **API text
generators** (single-shot HTTP calls to OpenAI/Anthropic/OpenRouter/
OpenAI-compatible endpoints). #29's research left the execution surface
as the key design decision:

- **agent-pane**: `herdr agent.start` a provider in a dedicated pane →
  `agent.prompt --wait` → `agent.read`. Visible, interruptible,
  consistent with herdr's PTY authority.
- **headless CLI**: spawn `claude -p` / `codex exec` etc. as a plugin
  subprocess. Lightweight but creates a second, invisible execution
  surface.
- **API generator**: direct HTTPS call; credential boundary needed
  (ADR-0018).

Repo invariants in play: "herdr is the only source of truth for
execution state"; "plugins own only feature-specific state"; "no
ambient secret inheritance"; pane execution via the Socket API is
already proven (#52 spike → ADR-0010, #67 projects runner uses
`workspace.create` → `pane.send_input`). The herdr Socket API exposes
`agent.start` (name/kind/pane_id/args/timeout), `agent.prompt`
(target/text/wait-until), `agent.wait`, `agent.read`, `agent.send_keys`
— verified against `herdr api schema` protocol 22.

Agent Router was investigated as the preferred route per #29, but its
interface is owned by dotfiles/pc-setup machine setup and is not part of
this repository's public contract; there is no documented, stable
interface this plugin can depend on. That gap is recorded here rather
than worked around silently.

## Decision

1. **Primary path: dedicated agent pane.** Agent-family generation runs
   inside a workspace/pane the plugin creates per invocation
   (`workspace.create` → `agent.start` → `agent.prompt --wait` →
   `agent.read` → `workspace.close` cleanup, always attempted). The
   provider CLI is launched *by herdr* inside its PTY, so:
   - herdr remains the sole authority for the process and its state;
   - generation is visible to the user and interruptible
     (`agent.send_keys`, pane close);
   - no second execution authority is introduced.
   Provider identity for this path is `agent:<kind>` where `<kind>` is a
   herdr agent kind (`claude`, `codex`, …). Task×path compatibility is
   declared in the task registry; `review_guide`/`next_prompt` are
   agent-only (upstream parity).
2. **Headless CLI subprocess: rejected for v1.** Spawning provider CLIs
   directly would bypass herdr's PTY authority (invisible execution,
   no `agent_status` signal, no interruption surface) and would inherit
   the plugin's ambient environment — including provider credentials —
   with no supervision boundary. The path is reserved in the contract
   (`path: "cli"`, always reported `unsupported`) so a future ADR can
   admit it with explicit justification; it is not implemented.
3. **API generators are a separate, opt-in path** (`api:<id>`),
   governed by ADR-0018. They are never a silent fallback: a task with
   no reachable agent provider and no enabled+credentialed API generator
   fails with a structured error, and manual specification by the caller
   always remains possible (generation/execution separation).
4. **Provider resolution order**: explicit `--provider` →
   `config.defaultProvider` → herdr `server.agent_manifests` order →
   known agent kinds → enabled API generators. Agent path is preferred
   over API when both are available, because agent providers bill against
   the user's existing subscription CLI rather than per-token API
   charges. When manifests are unreachable the known-kind list is used
   and `agent.start` remains the authority on whether the kind exists.
5. **Prompt transport**: the task prompt is submitted as agent prompt
   text with explicit `<<<TEXTGEN_RESULT>>>`/`<<<TEXTGEN_END>>>`
   markers; the executor extracts the last marked region from
   `agent.read` output. Unmarked output is an `output_unmarked` error —
   never a best-effort guess at noisy terminal text.

## Consequences

- Generation cost defaults to subscription usage already paid for;
  per-token API billing requires deliberate opt-in (ADR-0018).
- Every generation leaves a visible, short-lived workspace; cleanup is
  best-effort and warnings are surfaced, never hidden.
- `next_prompt`/event-driven triggers (#109) reuse the same pane path.
- If Agent Router publishes a stable interface later, it can be added
  as another `agent`-family transport without contract changes.
