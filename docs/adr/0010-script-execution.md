# ADR-0010: Project script execution via dedicated herdr panes

Status: Accepted (release-0-3-0, Issue #52 spike → #53 implementation)

## Context

Upstream T3 Code runs project scripts (`t3.json` `scripts[]`) by
injecting the command into the thread worktree's terminal and detecting
completion with a sentinel (`ProjectSetupScriptRunner`). Issue #52 asked
whether `rebuildup.projects` can offer the same "execute inside a herdr
pane" experience, given that `packages/herdr-client` originally exposed
no pane spawn/input surface.

The updated #52 directed verification against the **official Socket
API** rather than the client's current surface. A live spike against
herdr 0.9.5 (isolated session, protocol 22) confirmed the required
methods exist and behave as documented — evidence in
`docs/research/herdr-pane-execution-spike.md`.

## Decision

**Option (b): execute scripts in dedicated herdr panes created through
the Socket API**, with a small set of new `herdr-client` wrappers. No
detached-process fallback and no upstream change is required for the
manual run/stop/results surface (#53).

### Execution surface

- `workspace.create {cwd, label}` creates a dedicated workspace+tab+root
  pane in one call — the default execution target for `scripts run`.
  `tab.create`/`pane.split` are the in-place alternatives; #53 picks per
  UX. The plugin **never** sends input to panes it did not create, and
  never injects into shells or agent panes already in use (agent panes
  are distinguishable via `agent.list`/snapshot).
- Panes always start a shell (no `command`/`argv` on create APIs), so
  commands are injected with `pane.send_input {text, keys:["Enter"]}`.
  Long commands are written to a script file first and invoked by short
  path to stay under line-input limits.

### Completion and exit status

- `pane.wait_for_output` with `source:"recent_unwrapped"` and a
  per-run unique marker detects completion: the wrapper appends
  `; echo "__HERDR_DONE_<run-id>__=$?"` and matches regex
  `__HERDR_DONE_<run-id>__=(-?\d+)`. The echoed command line cannot
  match (it contains `$?`, not digits), and the run-id nonce prevents
  cross-run collisions — the sentinel-alone weakness upstream has is
  closed by capturing the exit code, not just output.
- `pane.process_info` (foreground ≠ `shell_pid`) is the secondary
  signal for "still running" and for detecting a command that died
  without printing the marker.
- `pane_exited`/`pane_closed` subscription events cover crash/close
  detection; a run whose pane vanished before the marker is recorded
  `result_unknown`, never fabricated as success (AGENTS §4).

### Stop

`scripts stop` sends `pane.send_keys {keys:["ctrl+c"]}` to the owned
pane, waits briefly, then `pane.close`. Only the pane_id recorded in
the run's state record is targeted — stop can never hit another pane.

### State and ownership

- The plugin persists `{run_id → pane_id, workspace_id, repo, argv,
  cwd, started_at, marker}` in its state dir; pane ids are never reused
  by herdr, and `pane.get` is re-checked before every action.
- Socket-created panes have **no server-side ownership token** (only
  `plugin.pane.*` panes do). Ownership is therefore client-side
  discipline: the plugin only ever addresses pane_ids it recorded at
  creation. Recorded as an upstream hardening candidate, not a blocker.

### herdr-client additions

Thin wrappers (~50 lines) over the existing `request`/`subscribe`:
`workspaceCreate`, `paneSendInput`, `paneSendKeys`,
`paneWaitForOutput`, `paneProcessInfo`, `paneClose`, plus subscription
types for `pane_exited`/`pane_closed`/`pane.output_matched`. No new
daemon, no PTY reimplementation — herdr remains sole execution
authority.

### Auto triggers (runOnWorktreeCreate / runOnSettle / stopOnSettle)

`events.subscribe` exposes `worktree.*` and pane lifecycle events, so
approximations are possible, but the mapping to upstream semantics
(worktree creation events, settle detection) is #53's design problem.
If a trigger cannot be mapped faithfully it is recorded as an upstream
gap and only manual `scripts run` ships — per #53's acceptance rule.

## Alternatives rejected

- **(a) Detached child process** — no herdr visibility, weaker as a dev
  server surface, duplicates lifecycle management the pane already
  provides. Rejected.
- **(c) Upstream pane API request + defer** — unnecessary: the official
  Socket API already covers creation, input, wait, close, and process
  inspection on the pinned herdr 0.9.5. Deferred only if #53 uncovers
  a concrete gap.
- **`plugin.pane.open` for scripts** — manifest-bound entrypoints, not
  arbitrary commands; rejected for execution (remains available for a
  future plugin UI pane).

## Consequences

- Script output is visible in a real herdr pane — matches upstream UX
  and gives users a surface to inspect/interrupt.
- Completion is structured (exit code via marker regex), satisfying
  #53's "no fabricated success" rule; `result_unknown` covers the
  pane-vanished path.
- Upstream gaps recorded for future issues: no `command`/`argv` at pane
  creation, no exit-status channel, no ownership token on
  socket-created panes, inconsistent event-name casing
  (`pane_created` vs `pane.agent_status_changed`).

## Addendum (#68): completion recovery mechanism

`events.subscribe` `pane.output_matched` (per-pane match subscriptions)
was evaluated as an event-driven complement to
`pane.wait_for_output` and **rejected**: it requires a persistent
subscription connection that a one-shot CLI cannot hold after exit,
pushed events are not replayed to late subscribers, and ADR-0002
forbids a plugin daemon. Instead the completion marker doubles as a
**durable receipt**: `__HERDR_DONE_<run-id>__=<code>` persists in pane
scrollback, so `scripts results`/`logs` lazily re-scan it via one
bounded `pane.read` (`recent_unwrapped`) after ownership
re-validation — no polling loop, exit code still parsed from marker
digits only.
