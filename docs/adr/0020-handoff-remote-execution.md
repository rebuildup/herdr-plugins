# ADR-0020: Handoff cross-machine execution — saved-machine bridge + portable bundle

Status: Accepted (release-0-6-0 candidate, Issue #105 / parent #6 T3)

## Context

T1 (#103) fixed the record/payload contract and the Agent Router
boundary (ADR-0017); T2 (#104, ADR-0018) executes same-host handoffs.
T3 (#105) adds cross-machine handoff: deliver a handoff record's
execution to an agent session on a DIFFERENT host's herdr server.

The binding question was what herdr 0.9.5 (protocol 22) actually
exposes for remote control. Measured against the installed binary and
the vendored source (`src/remote*`, `src/cli/target.rs`,
`src/api/schema*`):

- `herdr --remote <ssh-target>` is an interactive TUI attach path —
  it cannot drive `agent.start`/`agent.prompt` headlessly.
- `server.ssh_agent.register` forwards the LOCAL ssh-agent socket into
  a remote session so remote agent CLIs can authenticate; it is not a
  remote control surface.
- **Saved machines ARE a programmatic remote path.** `herdr machine
  list --json` enumerates profiles (`id`/`label`/`target`/`session`),
  and `herdr --machine <label-or-id> <command>` routes any CLI
  subcommand through `SavedSshApiBridge`: SSH to the target, run
  `herdr --session <profile-session> remote-api-bridge` remotely,
  which forwards the remote API socket over stdio. Verified live:
  `herdr --machine <id> api snapshot`, `agent list`, `workspace list`
  all return the remote session's JSON envelopes (remote herdr 0.9.5,
  `session "default"`, live panes observed).

Because every API-backed CLI command prints the same
`{id, result|error}` envelope the socket API returns, the plugin can
execute the ENTIRE T2 pipeline remotely by shelling out per call —
no socket-protocol reimplementation, no Agent Router involvement.

Payload portability is the second constraint: handoff payloads are
references into `rebuildup.*` plugin state (conversations index,
checkpoints) that exists only on the source host. The remote agent
cannot resolve them unless identical plugin state exists there.

## Decision

1. **Remote transport = `herdr --machine` CLI bridge.** The plugin
   resolves saved machines via `herdr machine list --json` (id or
   case-insensitive label; ambiguous labels and unknown selectors are
   structured errors), probes capability via
   `herdr --machine <id> api snapshot`, and implements the existing
   `HandoffTransport` interface by spawning the official CLI per call
   (`workspace create`, `tab create`, `agent start|get|prompt|wait`,
   `pane close`). Each call re-establishes the SSH bridge — slow but
   stateless, upstream-owned, and honest about failure (nonzero exit,
   `{error}` envelopes, and timeouts all surface as RemoteError kinds).
   Ambient `HERDR_*` socket/pane env vars are stripped from spawned
   children so a plugin running inside a pane cannot leak session
   context into remote calls.
2. **Probe before mutation.** `execute --remote` resolves + probes the
   machine BEFORE the `ready` transition; unreachable, disabled,
   unknown, or bridge-less remotes are pre-mutation refusals and the
   record stays `pending`. `remote-probe` exposes the same detection
   as a standalone command (`list` / `probe` / `--all`).
3. **Remote identity is recorded, never assumed.** Target planning,
   surface creation, prompt injection, and observation all run against
   the REMOTE snapshot/transport; `execution.remote` persists
   `{machine_id,label,target,session,probed_at,server_version,
   protocol}` and agent generation signals (`agent_session`,
   `state_change_seq`) come from the remote snapshot — local state can
   never be mistaken for the remote generation. `status --remote`
   verifies `machine_id` before reconciling; without it a remote
   record reports `remote_target_requires_flag`.
4. **Portable bundle for payload portability.** Before `ready`,
   `execute --remote` writes `herdr-plugins.handoff/bundle/v1` to
   `<state>/bundles/<id>.json` (atomic tmp+rename): refs stay
   references, `plugin_state` refs are explicitly marked
   `resolvable_on_remote:false` (external_ref semantics on the remote
   host), external refs keep inline values, and the bounded excerpt +
   requirements travel inline. The injected prompt states the
   portability rule. `execution.bundle` records the path and ref
   counts. No transcript copies; no fabricated remote resolution.
5. **Failure discipline is unchanged.** Post-`ready` remote failures
   persist `status:"failed"` with the same `execution.error{step}`
   taxonomy; `--cleanup-on-failure` closes only plugin-created remote
   panes via the remote transport.

## Consequences

- Cross-machine handoff works today against any saved machine whose
  remote herdr supports `remote-api-bridge` (present in 0.9.5); older
  remotes report `unsupported_remote` honestly.
- Each remote API call costs one SSH bridge spawn; `--wait-ms`
  observations hold a bridge open for the wait duration. Acceptable
  for a human/agent-initiated transfer; a persistent bridge socket is a
  possible future optimization, not required for correctness.
- `native_resume` across machines depends on the provider session
  existing on the REMOTE host (e.g. `claude --resume` needs the session
  file there); the decision logic is unchanged and failures surface as
  `agent_start`/`prompt` errors, never fabricated resume.
- Upstream gap candidates (recorded, not worked around): a persistent
  remote API channel for plugins (the per-call SSH bridge is the only
  programmatic path), and remote-side payload ref resolution when
  sibling plugins are installed remotely.

## Alternatives considered

- **Speak the socket protocol over `ssh … remote-api-bridge` stdio
  directly** — rejected: requires replicating herdr's remote binary
  discovery, platform quoting (posix + windows-powershell), and bridge
  lifecycle that `SavedSshApiBridge` already owns; the CLI path gets
  the same coverage through the supported surface.
- **`herdr --remote` / interactive attach** — rejected: TUI-only, no
  headless agent control.
- **Inline payload instead of references for remote** — rejected:
  violates the reference-payload invariant; the portable bundle marks
  plugin-state refs as external_ref instead of copying transcripts.
