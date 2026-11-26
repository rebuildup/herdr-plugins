# Spec: Inbox plugin (`rebuildup.inbox`)

Port of T3 Code's thread inbox / settle / snooze / pin / archive / manual
ordering semantics to standalone herdr plugins, per `rebuildup/herdr-t3`
issue #173, `docs/design/info-architecture.md` §6.2, and herdr-plugins
issues #33/#176/#177 (upstream refs `docs/user/thread-sidebar.md`,
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
- `links` — user-declared tracker references (`pr`/`issue`,
  `<repo>#<number>`) written by `link`/`unlink`. See "Explicit tracker
  links" below; they are work associations, not organize state.

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
hooks delete the entry immediately — including declared links. Live panes
are never pruned — their marks expire via resolution instead. Entries that
carry only links (no organize state) are retained and pruned by the same
rules.

## Search and filters

`list` accepts read-side filters that narrow the emitted `items` (and the
`counts`, which describe the emitted set) without touching state:

- `--attention` — only `attention: true` items.
- `--organize settled|snoozed|archived|none` — hide-kind match; `none`
  means no hide-kind mark (pin/order/links do not count).
- `--search <text>` — case-insensitive substring over `title`, `cwd`,
  `pane_id`.
- `--workspace <id>` — exact `workspace_id` match.

Filters compose and apply to the full item set, including hidden items —
a settled pane is still findable via `--organize settled`. The effective
filter set is echoed in the output's `filters` field.

## Explicit tracker links

`link <pane> --pr <repo>#<n>` / `--issue <repo>#<n>` records a
user-declared association between a pane and a known forge item;
`unlink` removes one; `links <pane>` reads them. Multiple links per pane
are allowed; re-linking the same `kind+repo+number` re-stamps the identity
fingerprint (the explicit re-validation path).

Boundary with the git plugin (#174): inbox owns **pane-scoped work
associations** — "this pane is working on X" — stored in inbox state and
projected via `list`/`links` for consumers such as herdr-t3's Linked
items. The git plugin owns **repo-scoped tracker operations** (`pr`/`issue`
list/view/create/edit/comment) and any forge-side linkage it chooses to
record. The two never share state: inbox links are declarations, not
event-derived facts, and carry no tracker metadata beyond the ref.

Links are explicit-only: there is no webhook or forge-event ingestion
(webhook delivery is an upstream gap, ADR-0026). `--verify` optionally runs
`gh <kind> view` at link time; any failure is a `warnings` entry and the
link is still recorded — verification never blocks an explicit user
declaration. PR-update-driven attention return is implemented by the
opt-in `watch-pr` command (see "PR update watcher" below, #178).

Stale discipline mirrors organize marks **minus timed expiry**: a link is
dropped at read/reconcile time when the pane's `agent_session` fingerprint
changes or the recorded `state_change_seq` regresses (identity recycled).
Forward seq advances — routine status transitions — never expire a link,
because the association describes the work, not a transient status. Links
on panes absent from the snapshot are tolerated (the fingerprint may be
temporarily unreportable) and die with the entry on `pane.closed` or
retention pruning. `restore` preserves links; `unlink` and `pane.closed`
are the removal paths. A link whose guard went stale is never silently
re-applied to a new identity — the user re-links explicitly.

## PR update watcher (`watch-pr`, #178)

`watch-pr` is an opt-in process that polls declared `pr` links and returns
attention (clears hide-kind organize marks) when the forge reports a
qualifying transition. It mirrors the T3 Code `watch_pull_request` model
(2-minute polling detecting check failure / review / comment / conflict /
merge-close) adapted to herdr's no-daemon constraint (ADR-0002) and the
webhook upstream gap (ADR-0026): polling `gh` through the git plugin's
public CLI is the legitimate event source — real observed data, with
freshness contracted explicitly.

- **No resident daemon, no webhook.** `watch-pr` is started explicitly
  (`watch-pr [pane_id] [--interval SEC] [--once] [--git-root PATH]`);
  nothing polls unless the user runs it. `--once` performs a single pass
  — the "CLI invocation" poll path. When not running, PR updates are not
  observed and no automatic attention return is promised.
- **Poll path**: `rebuildup.git` public CLI only — `git pr view` (state,
  mergeStateStatus, reviews), `git pr comments` (issue + line comments),
  `git pr checks` (per-check buckets). Plugin root resolution follows the
  ADR-0013 pattern (`--git-root` → `config.json gitPluginRoot` → sibling
  `../git` → `herdr plugin list --json`); the child env is scrubbed of
  this plugin's `HERDR_PLUGIN_*` and pinned to the git plugin's dirs.
  gh is never spawned by inbox for watching and no tokens are handled.
- **Scope**: `kind === "pr"` links only. `issue` links are not watched —
  the git plugin has no public issue-read command (recorded limitation;
  a `git issue view` surface is a follow-up candidate). Only links that
  pass the normal staleness rules and whose pane is live are polled;
  absent panes are reported in `watch-pr.tick.absent_panes` and their
  links keep the watch alive (a temporarily missing pane may return).
- **Observation model**: each successful poll produces a normalized
  `LinkWatchObservation` (state, draft, mergeStateStatus, mergeable,
  updatedAt, PR author, failing check names, review/comment signature
  sets with the PR author's own activity excluded — the author is the
  self proxy since viewer-login detection would cost an extra call per
  tick). The full observation is stored under `state.watch[session]
  [pane][ref]` together with `first_seen_at`, `last_checked_at`,
  `last_error`, `consecutive_failures`, `terminal`, `next_poll_at`.
- **Diff → triggers** (baseline = last *successful* observation):
  - `merged`/`closed`: lifecycle transition; the link becomes `terminal`
    and is never polled again (T3 "watch ends on merge/close").
  - `check_failed`: a check name newly appears in a failing bucket
    (`fail`/`cancel`).
  - `merge_conflict`: `mergeStateStatus` transitions into `DIRTY`.
    Other `mergeStateStatus` values are volatile and intentionally do not
    wake (BLOCKED/UNSTABLE/BEHIND/CLEAN churn would flap).
  - `review`/`comment`: new non-self review or comment signatures.
  - First observation is a silent baseline — an already-merged/closed PR
    records `terminal` without attention, so linking finished work cannot
    fabricate a wake.
- **Attention return**: a qualifying diff clears `settled`/`snoozed`/
  `archived` under the state lock (pin/order/links preserved) and
  re-projects metadata — restore-direction semantics. If the pane has no
  hide-kind marks the event still fires with `cleared: []` (already
  visible; a no-op, not an error). Attention statuses (`blocked`) are
  untouched — they were never hidden.
- **Dedupe**: the baseline is updated in the same commit as the organize
  clear, so a persistent diff cannot re-trigger; terminal links stop
  polling. A failed poll never mutates the observation, so forge
  flakiness cannot fabricate transitions.
- **Failure honesty & backoff**: any poll failure (git plugin missing,
  pane cwd not a repo, gh missing/unauthenticated/rate-limited/timeout)
  emits `watch-pr.error` with `consecutive_failures`, `next_poll_at`
  (`interval × 2^failures`, cap 30 min), and the last good
  `last_checked_at` — explicit state, never silent staleness. Deferred
  links are skipped until `next_poll_at`.
- **Stop conditions**: SIGINT/SIGTERM (`signal`), `--once` (`once`, or the
  computed reason when nothing remains), `no_links` (no declared PR links
  in scope), `all_terminal` (every declared PR link is terminal — or its
  pane is gone). The watch exits rather than idling when there is nothing
  left to observe.
- **Lifecycle**: `unlink` and `pane.closed` drop the link's watch
  baseline; `watch-pr` ticks also prune baselines for refs that are no
  longer live declared links, so baselines cannot leak or resurrect for
  recycled identities. `state.watch` is additive optional state (schema
  stays v2) and is internal bookkeeping — not part of the read contract.
- **automations (#32) boundary**: the watcher only flips organize state;
  it never starts agents, delivers notifications, or runs user
  automations. Bridging forge events into automations schedules is a
  follow-up, not this ticket.

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

## Target selection and ambient isolation

Socket targeting follows `docs/contracts/inbox-v1.md` → Target selection
(implemented in `packages/herdr-client` `resolveTarget`):

- Explicit `--socket`/`--session` beat ambient `HERDR_SOCKET_PATH`/
  `HERDR_SESSION`; any explicit↔ambient or ambient↔ambient contradiction
  fails closed with `target_conflict` — an ambient `HERDR_SOCKET_PATH`
  exported for session A can never silently redirect an explicit
  `--session B` invocation (issue #83).
- Mutating commands (`settle`/`snooze`/`restore`/`reconcile`/`watch`/
  `_wake`, and the event hooks which run with `mutation: true`) require
  an explicit or consistent ambient target; the implicit default socket
  is rejected with `target_required`.
- Ambient pane identity (`HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`,
  `HERDR_TAB_ID`, `HERDR_PLUGIN_CONTEXT_JSON`) is verified against the
  resolved session's snapshot before metadata writes
  (`ambient_identity_mismatch`); an explicit positional pane id bypasses
  the ambient check but must exist in the target session.

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

## Organize-transition log and `transitions` command (#182, ADR-0029)

Every real organize mutation appends one `InboxTransition` to a
per-session log in `state.json` (`transitions` key, schema-v2
namespaced like entries): `seq` (monotonic per session), `at`, `kind`
(`settled`/`snoozed`/`restored`/`cleared`), `pane_id`, and context
fields captured from the snapshot the mutating command already loaded
(`workspace_id`, `cwd`, `agent_status`, `state_change_seq`,
`agent_session`). `cleared` transitions carry `cause`
(`expired`/`generation`/`session_mismatch`/`pane_closed`/`pruned`) and
are recorded by reconcile, the `agent_status_changed`/`pane.closed`
hooks, and retention pruning — never by pin/order (layout hints).

`transitions [--after <seq>] [--limit <n>]` is the read-only drain
surface (contract `herdr-plugins.inbox/v1`, additive in 0.4.0): it
returns `{session_key, head_seq, oldest_seq, dropped, transitions[]}`
with `--after` exclusive. Retention caps the log at 500 items per
session; evicted items increment `dropped` so a consumer can detect a
cursor older than the retained window (`cursor_expired`) instead of
assuming a gapless history. `rebuildup.projects` `runOnSettle`/
`stopOnSettle` (#182) drains this log lazily — inbox never pushes and
never fabricates herdr events.

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
- Issue-link watching: `watch-pr` covers `pr` links only; issue updates
  have no git-plugin public read surface yet (follow-up candidate).
- Non-DIRTY `mergeStateStatus` transitions, draft flips, and review
  *content* changes do not wake — only the contracted trigger set does.
- True "required check passed" / review-decision semantics: check
  *failure* is detected via `gh pr checks` buckets; "all required checks
  green" is not a distinct trigger in v0.5.0.
