# Spec: Inbox plugin (`rebuildup.inbox`)

Port of T3 Code's thread inbox / settle / snooze / pin / archive / manual
ordering semantics to standalone herdr plugins, per `rebuildup/herdr-t3`
issue #173, `docs/design/info-architecture.md` §6.2, and herdr-plugins
issues #33/#176 (upstream refs `docs/user/thread-sidebar.md`,
`docs/user/triage.md` @ `9cc4018c`).

## Sources

- T3 Code: `packages/client-runtime/src/state/threadInbox.ts`,
  `threadSettled.ts` (upstream `pingdotgg/t3code` @ `9cc4018c`).
- herdr-t3 §6.2: settle/snooze are UI-layer state keyed by pane identity +
  generation signal; herdr state is untouched; auto-restore on generation
  advance.
- herdr socket API: `session.snapshot`, `pane.report_metadata`,
  `events.subscribe` (`pane.agent_status_changed` only — output-level events
  are not hook-eligible).

## Model

Organize state is per-pane, user-owned, and stored in the plugin state dir.
Each entry carries:

- hide-kind marks — `settled`, `snoozed`, `archived` — mutually exclusive
  (applying one clears the others):
  - `seq` — `state_change_seq` at organize time (generation signal)
  - `agent_session` — fingerprint `{agent, kind, value}` when available
  - `at` / `until` — wall-clock timestamps (`until` on snooze only)
- `pinned` — a generation-guarded mark (`at`/`seq`/`agent_session`) that
  sorts the pane first in `list` output. Pin is a placement flag, never a
  hide-kind: it does not affect `in_inbox`.
- `order` — a manual rank (integer, lower sorts first) written by the
  `order` command. A layout hint scoped to the pane id: it is NOT
  generation-guarded (reordering is meaningless to withhold from a new
  agent generation on the same pane) and is cleared by `restore`,
  `pane.closed`, and retention pruning like every other field.

`settled`/`snoozed`/`archived` are hide-kinds: they remove the pane from
the default inbox view (`in_inbox: false`) until resolved. `archived` is
the T3 "filed away" state — semantically distinct from `settled` but
mechanically identical in v1 (same generation guard, same attention
override). `pin`/`order` are orthogonal and survive hide-kind changes;
`unpin`/`unarchive` clear only their own field, `restore` clears
everything.

### Resolution (read-side, deterministic)

On every read (`list`, `reconcile`, event hook) each mark is resolved:

1. **Snooze expiry** — `until <= now` → mark cleared.
2. **Agent-session mismatch** — recorded fingerprint differs from the live
   `agent_session` → mark cleared (stale organize state never applies to a
   different agent generation).
3. **Generation advance** — live `state_change_seq > mark.seq` → mark
   cleared (auto-restore, per herdr-t3 §6.2).

If every mark is cleared the entry is deleted (entries that still carry a
pin or an order rank are retained). Marks recorded without an
`agent_session` fingerprint (non-agent panes, older herdr) fall back to
seq comparison only.

### Attention invariant

`agent_status == "blocked"` (and future attention statuses) forces
`in_inbox: true` regardless of organize marks — including `archived`.
An archived pane whose agent reports attention stays in the inbox while
keeping its `archived` mark, so it returns to the archived view once
attention clears; a generation advance clears the mark entirely (auto-
restore). In practice a transition to `blocked` bumps `state_change_seq`,
which already clears marks; the flag is a defense-in-depth guarantee, not
the primary mechanism.

### What organize state is NOT

- It never mutates herdr agent/pane execution state. `archive` in
  particular only hides the pane from the default inbox view — it never
  closes the pane, stops the agent, or touches the PTY (contract-tested:
  organize commands emit only `session.snapshot` reads and
  `pane.report_metadata` projections).
- It never fabricates statuses from PTY text. T3 Code's richer signals
  (pending approval, user input request, subagent request) have no herdr
  equivalent; `blocked` is the only attention signal used. This gap is
  explicit: panes waiting on approval that herdr reports as `working`/`idle`
  cannot be distinguished and are treated as ordinary work.

### State bounds

Organize entries for panes absent from the session snapshot are retained for
up to 24h (they may reappear), then pruned by `reconcile`/`watch`. A hard cap
of 500 entries evicts the oldest `updated_at` first. `pane.closed` event
hooks delete the entry immediately. Live panes are never pruned — their
marks expire via resolution instead.

## List ordering

`list` sorts items: `pinned` first, then `attention`, then `order` rank
ascending (unordered items last, `pane_id` tiebreak). `order` ranks are
dense integers scoped to the moved pane's display group (same
`attention`/`pinned` flags); `order <pane> --first|--last|--before <p>|
--after <p>` rewrites the whole sibling group's ranks under the state
lock, so concurrent clients cannot interleave corrupt ranks. Ordering a
hidden pane is rejected — restore/unarchive first.

## Snooze deadline materialization

Expiry is resolved lazily at every read, and materialized promptly by
four complementary paths:

- on any CLI invocation (`list`, `settle`, `snooze`, `restore`, `pin`,
  `unpin`, `archive`, `unarchive`, `order`, `reconcile`)
- on every `pane.agent_status_changed` / `pane.closed` event hook
- once at server start via the manifest `startup` hook (`reconcile`)
- a detached one-shot `_wake` process spawned by `snooze`: it sleeps on a
  single timer until the deadline, runs one `reconcile` pass, and exits
  (ADR-0005). No polling; lifetime is bounded by the snooze duration.
- while `inbox watch` runs (subscription events + `--interval` tick,
  default 60s) — opt-in only

Between invocations an expired snooze remains stored but is already resolved
as expired at read time, so no client ever observes a stale "snoozed" state.
`_wake` failure or absence only delays metadata-token refresh; the contract
stays correct. `reconcile` re-projects tokens for every organized pane,
which is the repair path for partial projection failures.

## Pane and session identity

State entries are keyed by `pane_id` **within a session namespace**. The
session key is `hostname + canonical socket path` (the socket API exposes
no session name; pane ids like `w1:p1` repeat across sessions, so an
unscoped key would leak organize marks between sessions). Consequences:

- Each named/default session on a host gets an isolated entry map inside
  the shared `state.json`.
- A state file shared across hosts (synced home directory) cannot merge
  marks: the hostname component differs.
- A forwarded remote socket used from another machine resolves to a
  different socket path, so it forms a separate local namespace — which is
  why the contract requires running the CLI **on the herdr host** (see
  `docs/contracts/inbox-v1.md` → Remote hosts).
- State schema v2 (`sessions` map). v1 files are discarded on load;
  pre-release, no migration.

## Metadata projection

On organize/restore/reconcile the plugin writes pane metadata tokens via
`pane.report_metadata`:

- `inbox_state` = `settled` | `snoozed` | `archived`; cleared (null) when
  no hide-kind survives
- `inbox_snoozed_until` = ISO deadline (snoozed only)
- `inbox_pinned` = `"true"` while a pin mark survives; cleared otherwise

Tokens are namespaced `inbox.*` and merged by herdr; other plugins' tokens
are untouched.

## Agent View

Not used in v0.1. `agent.view.set` is a single global slot; claiming it
would conflict with other plugins and herdr-t3's own views. See ADR-0004.

## Event hooks and startup

- `[[events]] pane.agent_status_changed` → `src/hook.ts`: resolves the
  affected pane against a fresh snapshot, persists cleared marks, refreshes
  metadata tokens.
- `[[events]] pane.closed` → `src/hook.ts`: deletes the pane's organize
  entry (closed panes must not accumulate state or leak onto reused ids).
- `[[startup]]` → `cli.ts reconcile`: one pass at server start to
  materialize expirations and repair tokens after restarts.

Hook failures are logged to the plugin command log and never affect herdr.

## Manifest actions

`settle`, `restore`, `snooze`, `pin`, `unpin`, `archive`, `unarchive`
actions operate on the context pane
(`HERDR_PANE_ID` / `HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id`). `snooze`
with no `--until` uses `defaultSnooze` from the plugin `config.json`.
`order` is CLI-only (it needs placement arguments).

## Out of scope

- TUI inbox pane / Agent View projection (herdr-t3 consumes the contract).
- Multi-session namespacing beyond socket selection.
- `pane.output_matched`-driven attention inference.
- Checkpoint/handoff features (separate plugins/issues).
- Work groups / side-chat semantics: mapped onto herdr workspace/tab +
  `handoff-v1` lineage in ADR-0029; no `group` field is added to
  organize state, and side-chat presentation is herdr-t3 scope (#7).
- Remaining #33 scope: inbox search/PR linkage (#177) and PR-update
  attention return (#178) are tracked as separate tickets.
