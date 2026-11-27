# TUI coverage ledger (program #228 / foundation #229)

Human-readable index of the machine-readable ledger
[`tui-coverage.json`](tui-coverage.json). It maps **every human-facing
capability of all 14 plugins, per command**, to the surfaces that serve
it: CLI, manifest TUI action, interactive TUI pane, GUI (herdr-t3),
real-machine verification, and true upstream gaps.

Design basis: ADR-0031 (architecture + measured herdr 0.9.5
capabilities), ADR-0032 (shared `packages/tui` library), ADR-0033
(launcher + safety contract). The normative contract subsequent tickets
implement against is [`docs/contracts/tui-v1.md`](../contracts/tui-v1.md).

## How to read the statuses

| field | meaning |
| --- | --- |
| `cli` | `implemented` — contract-covered CLI command exists |
| `tui_action` | `declared:<id>` — a manifest `[[actions]]` entry exists today (inbox ×9 incl. `open`, git ×7 incl. `open`/`open-forge`, checkpoints ×2, projects ×2, automations ×1, conversations ×1, usage ×1, controls ×1, handoff ×1, textgen ×1, artifacts ×1, secrets ×1, machines ×1, mcp ×1); `none` — no action yet |
| `interactive_tui` | `implemented:#NNN` — interactive TUI shipped in that ticket (#237 Inbox pilot, #238 Git, #239 Git forge, #240 Projects, #241 Projects scripts, #242 Checkpoints, #243 Automations, #244 Conversations/Usage, #245 Controls/Handoff, #246 TextGen, #247 Artifacts/Secrets/Machines, #248 MCP diagnostics); `n/a` — daemon-, agent-, or diagnostic-only surface with no interactive TUI planned |
| `gui` | GUI is owned by herdr-t3 (#7). This repo records consumption intent only — **GUI-done never implies TUI-done** |
| `real_machine_evidence` | `docs/research/` paths recording live verification; absence means no recorded real-machine run, not necessarily untested |
| `upstream_gap` | non-null = blocked on herdr/T3Code upstream; never worked around by PTY guessing |

## Summary by plugin

| plugin | contract | ticket | commands | declared actions | interactive-TUI plan |
| --- | --- | --- | --- | --- | --- |
| rebuildup.inbox | inbox/v1 stable | #230 | 17 | 9 | **implemented #237**: inbox browser + organize verbs + links/transitions + explicit reconcile |
| rebuildup.git (+forge) | git/v1 stable | #230 | 17 | 7 | **implemented #238**: status/files/diff/log/compare browser + stage/commit/branch/push; **implemented #239**: PR/issue forge workflows (pane `forge` + `open-forge`) |
| rebuildup.projects | projects/v1 stable | #231 | 13 | 2 (`open`, `open-scripts`) | implemented #240 — registry browser + repos membership + settings + scripts/run/stop + worktree info; implemented #241 — dedicated scripts surface (project/repo-path target, run, stop, results, logs) |
| rebuildup.checkpoints | checkpoints/v1 stable | #231 | 12 | 2 (`create`, `open`) | implemented #242 — list/show/diff/plan + guarded create/save/restore/delete + groups + gc/prune dry-run-first |
| rebuildup.automations | automations/v1 stable | #231 | 14 | 1 (`open`) | implemented #243 — task list + create/edit forms (schedule/destination) + enable/disable + run-now + runs history + driver diagnostics (schedule install/uninstall/status, tick-now, detached watch; all explicit + confirm-gated) |
| rebuildup.conversations | conversations/v1 stable | #232 | 8 | 1 (`open`) | **implemented #244**: sessions/history/search browser + event detail; `index` via confirm-gated `i` |
| rebuildup.usage | usage/v1 stable | #232 | 5 | 1 (`open`) | **implemented #244**: usage/quota/cost/divergence reports with provider + period filters |
| rebuildup.controls | controls/v1 stable | #232 | 8 | 1 (`open`) | implemented #245 — agent list/detail + send/command/wait/interrupt/read/rename + agent.start with launch options |
| rebuildup.handoff | handoff/v1 stable | #232 | 9 | 1 (`open`) | implemented #245 — record list/detail + create/execute/delegate/merge-back + resume-info/focus-source |
| rebuildup.textgen | textgen/v1 stable | #232 | 5 | 1 (`open`) | implemented #246 — task picker + input form + provider select + confirm-gated generate; result review/copy only (not persisted, #249); config stays CLI |
| rebuildup.artifacts | artifacts/v1 stable | #233 | 10 | 1 (`open`) | implemented #247 — registry browser + register/search + verify + delete(force-confirm)/deliver/gc(dry-run first); payload never rendered |
| rebuildup.secrets | secrets/v1 stable | #233 | 5 | 1 (`open`) | implemented #247 — binding browser + metadata-only resolve + explicit run/inject + config init; values never displayed (ADR-0027) |
| rebuildup.machines | machines/v1 draft | #233 | 3 | 1 (`open`) | implemented #247 — inventory browser + on-demand probe (progress+cancel) + capability info; read-only, lifecycle stays `herdr machine` |
| rebuildup.mcp | mcp/v1 stable | #233 | 3 CLI + 24 tools | 1 (`open`) | implemented #248 — diagnostics only (capability/access/tools/plugins); the stdio server is NOT screen-ified |

## Foundation row (#236)

The shared zero-dependency TUI core `packages/tui` (raw-mode input,
diff renderer, shared components, task runner, safety helpers per
ADR-0032/ADR-0033 and `tui-v1.md`) is implemented and recorded in the
machine-readable ledger under `foundation`. Verification: dedicated unit
suites (`tests/tui-*.test.ts`) plus a real-PTY smoke of
`packages/tui/examples/demo.ts` via `script(1)`.

## TUI pilot row (#237)

`rebuildup.inbox` v0.7.0 ships the first interactive surface: manifest
`[[panes]] main` (`placement = "tab"`) + `[[actions]] open` (`--open`
helper → `plugin.pane.open` via `HERDR_BIN_PATH`), implemented in
`plugins/inbox/src/tui.ts` on `packages/tui`. All 14 human-facing inbox
commands are `implemented:#237` in the ledger (watch/watch-pr/capability
stay `n/a`); mutations are confirm-gated and run through `cli.ts`, open
is read-only, and reconcile runs only via the explicit `c` key.

**Install-mode reachability: PASS.** `herdr plugin install
rebuildup/herdr-plugins/plugins/inbox --ref 237` produces a full-repo
managed checkout, so `../../../packages/tui` resolves and the pane
renders on herdr 0.9.5 — the ADR-0032 relative-import approach needs no
vendored copy. Live evidence:
`docs/research/inbox-tui-v237-live-verification.md` (isolated session
`verify237`; pane open via entrypoint and via `open` action, `?`/`f`/`s`/
`r`/`q` keys, confirm-gated settle→restore round-trip, clean exit,
focus return).

## Git TUI surface (#238)

`rebuildup.git` ships its interactive surface per `tui-v1.md`: manifest
`[[panes]]` entrypoint `main` (`placement = "tab"`) plus an `open` action
that runs `herdr plugin pane open` via `HERDR_BIN_PATH` and returns
promptly. The UI (`plugins/git/src/tui.ts` + `src/tui/{model,repo,app}.ts`)
covers status, changed-file selection with per-file stage/unstage/diff,
a paged path-scoped diff viewer (worktree/staged/HEAD scopes), log +
per-commit show, compare vs upstream, branch list/switch/create/set
upstream, remote list, fetch, and push (with `--set-upstream` flow when
no upstream exists). Target identity is pinned at launch
(`HERDR_PLUGIN_CONTEXT_JSON`/`HERDR_TUI_TARGET_*` → pane cwd → repo root
→ HEAD sha); every mutation revalidates pane→repo-root and HEAD sha and
aborts with a stale-target state on drift. Commit/push/bulk stage and
branch switch are confirm-gated; detached HEAD, unborn branch, missing
upstream/remotes, and not-a-repo render honest states. Forge
(PR/Issue) surfaces are excluded — #239. Verified by
`tests/git-tui.test.ts` (32 tests) plus a `script(1)` PTY smoke of
`--cwd` launch → files → diff → exit; real-herdr pane-open verification
uses the isolated-session harness only.

## Implementation notes

- **#244 (conversations + usage)**: both plugins ship a `[[panes]]`
  `main` entrypoint (`placement = "tab"`, `bun run src/tui.ts main`)
  plus an `open` action that calls `plugin.pane.open` via
  `HERDR_BIN_PATH` and returns promptly. Data flows through each
  plugin's own CLI JSON surface — never state files or PTY text.
  conversations gates `index` behind `capability.mutation_commands` +
  an in-TUI confirm; usage is fully read-only (`f` refresh is explicit,
  never on open). Quota/hub details redact credential-shaped keys
  (ADR-0014/0015). Unit coverage: `tests/conversations-tui.test.ts`,
  `tests/usage-tui.test.ts`; PTY smoke verified empty-state render.

## Cross-cutting notes

- **Daemon/agent-only surfaces stay out of interactive TUI**: `watch`,
  `watch-pr`, `fire`, `tick`, `schedule install|uninstall`, `serve`,
  `watch-next-prompt`, and all MCP tools are marked `n/a`; TUI surfaces
  may show their *status* (run history, driver state) but do not replace
  the daemon lifecycle.
- **Mutation commands keep their guards in TUI**: every `mutating: true`
  command maps to a confirm-gated or explicitly-targeted UI operation per
  the safety contract (ADR-0033 §3, `tui-v1.md` §safety).
- **Existing manifest actions are preserved**: TUI work adds `open`
  actions/panes; it never removes or renames existing action ids.
- **True upstream gaps** recorded in the ledger stay `upstream_gap`
  entries (e.g. structured approval dialogs, webhook triggers per
  ADR-0026, attention granularity per feature-ledger) — TUI tickets must
  render them as honest unsupported states, not simulate them.

## RC 0.11.0 acceptance (#234)

Release-candidate verification of every interactive TUI surface across
all 14 plugins at `release-0-11-0` @ `0554aed` is recorded in
[`docs/research/tui-rc-0-11-0-verification.md`](../research/tui-rc-0-11-0-verification.md).
The RC doc path is appended to `real_machine_evidence` for every
command whose `interactive_tui` status is `implemented:*` (108 entries).
Headline results: full keyboard→operation→readback→focus-return pass on
macOS for all 14 panes; two forge-TUI defects found and fixed on the
verification branch; WSL2 `validate:fast` fully green plus a live TUI
smoke; Windows install/typecheck/lint green (test suite limited by the
known `core.autocrlf` portability gap, now mitigated for checkouts by
the new `.gitattributes`); alternate Windows host unreachable and
recorded honestly.
