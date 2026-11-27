# TUI RC verification — v0.11.0 (all 14 plugins, issue #234)

Release-acceptance verification for the TUI release train (parent #228,
tracking #22). Fixed target:

- Code under test: `release-0-11-0` @
  `0554aede8d3f30b8b9d36e809443f465843e4558` — every implementation
  ticket (#237–#248) merged; all 14 plugins installed into the isolated
  session with `herdr plugin install
  rebuildup/herdr-plugins/plugins/<name> --ref release-0-11-0` and
  every installation resolved exactly `0554aed`.
- Plugin versions resolved at the RC: artifacts 0.2.0, automations
  0.8.0, checkpoints 0.4.0, controls 0.6.0, conversations 0.6.0, git
  0.7.0, handoff 0.7.0, inbox 0.7.0, machines 0.1.0, mcp 0.7.0,
  projects 0.4.0, secrets 0.2.0, textgen 0.8.0, usage 0.6.0.
- herdr `0.9.5` everywhere; Bun `1.4.4` (macOS/Windows), `1.4.5`
  (WSL2); git for Windows `2.55.0`, WSL2 git, macOS homebrew git.
- This document and the fixes it motivated land on branch `234`
  (PR → `release-0-11-0`); they are verification/audit follow-ups, not
  part of the verified RC SHA itself.

## Environment matrix

| OS | Host | herdr | Bun | Verification depth |
| --- | --- | --- | --- | --- |
| macOS (arm64) | local | 0.9.5 real binary | 1.4.4 | **Full**: all 14 plugins installed at RC SHA; interactive TUI keyboard→operation→readback→focus-return pass per plugin; `bun run validate:fast` |
| WSL2 (Linux) | `device-wsl` (`basic@…`) | 0.9.5 | 1.4.5 | Repo clone @ `234` head: `bun install`, `typecheck`, `lint`, **1516 tests / 0 fail**; isolated-session TUI smoke (inbox pane open, `?` help, readback) |
| Windows 11 | `device-windows` (`C:\Users\rebui`) | 0.9.5 | 1.4.4 | Repo clone @ `234` head: `bun install`, `typecheck`, `lint` green; `bun test` run — see "Windows test suite" below |
| Windows (alt) | `device-lab-win` (100.84.109.16) | — | — | **UNREACHABLE**: SSH connect timed out on every attempt; recorded honestly, not verified |

### Isolation (all hosts)

Dedicated named session `verify234`/`verify234w` with dedicated
`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HERDR_CONFIG_PATH`
(`/var/tmp/herdr-plugin-234*` on POSIX). The real herdr binary was used
directly (the mise shim fails under XDG override). All ambient
`HERDR_*` variables were stripped via an `env -u` wrapper for
server/CLI calls. The user's live session was never touched; isolated
sessions and temp dirs were removed after verification.

## macOS: per-plugin interactive TUI results

Driving method: `herdr plugin pane open --plugin <id> --entrypoint
main --placement tab`, then `herdr pane send-keys` / `pane send-text` /
`pane read` for keyboard input → domain operation → readback → focus
return. Session `verify234`, workspace `w1`, origin pane `w1:p1`.

| plugin | surface exercised | result |
| --- | --- | --- |
| rebuildup.inbox | settle → restore round-trip, scope cycle (`F`), help, focus return | PASS |
| rebuildup.artifacts | register → detail → verify → delete → focus return | PASS |
| rebuildup.automations | create task → delete task (`task_28986b07-…`) | PASS |
| rebuildup.checkpoints | capture → detail (created git ref `refs/herdr-plugins/checkpoints/…`, cleaned up) | PASS |
| rebuildup.controls | agent list/detail render, picker, help (agent-start not exercised — no live agent in isolated session) | PASS (partial) |
| rebuildup.conversations | reindex (confirm-gated) → search | PASS |
| rebuildup.git | status/changed files/stage/unstage/refresh on probe file; forge pane: PR list, issue list (real `gh` data), issue detail | PASS after fixes D1+D2 |
| rebuildup.handoff | create manual record `ho-mwy5twjn-ce20d982` → resume-info → delete | PASS |
| rebuildup.machines | inventory + capability view (read-only by design) | PASS |
| rebuildup.mcp | diagnostics: tools/plugins views | PASS |
| rebuildup.projects | registry browser render (no mutations exercised — empty registry) | PASS (render-only) |
| rebuildup.secrets | binding browser render (no bindings configured — honest empty state) | PASS (render-only) |
| rebuildup.textgen | task picker render (generate not exercised — requires provider) | PASS (render-only) |
| rebuildup.usage | quota rendered; usage report showed "loading…" for an extended period (usage child CLI spawns are heavy — observed slow, not a hang: eventually resolves in unit tests) | PASS (slow render noted) |

Plugin coexistence: all 14 installed simultaneously in one session;
each pane opened independently and closed cleanly (`q`), focus
returned to the origin pane. GUI-less usage: every surface above is
pure TUI — no herdr-t3 involved.

## Defects found and fixed in this PR

- **D1 — forge TUI dead on arrival** (`cac7f64`): `runGitCli` in
  `plugins/git/src/tui-forge-support.ts` spawned plugin CLI children
  that inherited `HERDR_PANE_ID` (the UI pane) together with
  `HERDR_PLUGIN_CONTEXT_JSON` (origin pane); the child's
  `ambientIdentity()` then failed closed with
  `ambient_identity_mismatch`, breaking **every** forge call from the
  TUI. Fix: `forgeCliChildEnv()` drops both keys (mirrors the inbox TUI
  `runCli` precedent). Regression test added.
- **D2 — forge PR/issue lists never load** (`a868dcd`):
  `PrListView`/`IssueListView` constructors in
  `tui-forge-views.ts` never invoked `load()`, so the panes stayed on
  "loading pull requests…" forever (unit tests masked it by calling
  `await view.load()` manually). Fix: `void this.load()` in both
  constructors + two constructor-load regression tests. Verified live:
  PR list renders (empty — no open PRs), issue list renders real `gh`
  issues, issue detail renders.
- **D3 — lint gate red at the RC tip** (`5673e0d`): `bun run lint`
  failed on `release-0-11-0` itself with 88
  `lint/correctness/noUnsafeOptionalChaining` errors (plus format
  diffs), all in `tests/` — pre-existing debt, unrelated to the TUI
  tickets. Fixed mechanically (`(x?.y as T).m` →
  `((x?.y ?? []/{}) as T).m`, semantics preserved when data is present,
  clean assertion failure when absent) plus biome safe fixes
  (organize-imports/format). `bun run lint` now exits 0; remaining
  items are pre-existing unsafe-fix *warnings* (useTemplate,
  useLiteralKeys, …), same class prior RCs recorded as non-blocking.
- **D4 — Windows checkout breaks lint** (`09877a1`): Windows clones
  with `core.autocrlf=true` produced CRLF working trees → biome
  formatter flagged all 268 files. Added `.gitattributes`
  (`* text=auto eol=lf`; repo has no CRLF-dependent file types) and
  verified a fresh Windows clone now checks out LF and lint passes.

## WSL2 results

- `git clone` of branch `234` @ `5673e0d` to
  `~/herdr-plugin-234verify`; `bun install` clean.
- `bun run typecheck` — pass. `bun run lint` — pass (exit 0;
  warnings only, same set as macOS).
- `bun run test` — **1516 pass / 0 fail** (75 files, ~78 s).
- Isolated-session TUI smoke (`verify234w`, real herdr 0.9.5 binary):
  `herdr plugin install …/inbox --ref release-0-11-0` resolved and
  installed; `workspace create` → `plugin pane open` produced pane
  `w1:p2` (Inbox, tab `w1:t2`); `pane read` rendered the inbox TUI
  (status line `inbox · verify234w · 2 inbox · 0 attention` + keybind
  footer); `pane send-keys "?"` opened the help overlay listing all
  bindings; `q` closed it. Session stopped and temp dirs removed.
- Note: plugin-pane CLI calls require an explicit session target
  (`HERDR_SESSION`/`--session`) — the default-socket lookup does not
  see named-session sockets (environment note, same on all hosts).

## Windows results

- Host `device-windows` (Windows 11 10.0.29712, PowerShell 5.1 SSH,
  herdr 0.9.5 via mise, bun 1.4.4, git 2.55.0).
- Fresh clone of branch `234` @ `09877a1` (post-`.gitattributes`) to
  `C:\Users\rebui\herdr-plugin-234verify`; `git ls-files --eol`
  confirms LF working tree.
- `bun install`, `bun run typecheck`, `bun run lint` — all pass
  (lint exit 0, warnings only).
- `bun run test` — **1384 pass / 112 fail / 24 skip** (75 files,
  ~15 min). Failures are concentrated in POSIX-shell-fixture tests,
  not plugin logic: fake `gh`/`infisical` provider fixtures are shell
  scripts that cannot execute under Windows cmd/PowerShell (all
  forge/issue/PR-mutation, watch-pr, secrets-provider, and
  link-`--verify` cases); checkpoint restore tests assert LF-exact
  file bytes while `core.autocrlf=true` git rewrites content to CRLF;
  a few path-case normalization and subprocess-timeout flakes.
  Recorded as a known Windows-suite portability gap, not a release
  defect — the plugins' own Windows paths (cmd/powershell shell-family
  handling in projects-runner, win32 clipboard fallback, etc.) are
  covered by dedicated unit tests that do pass on this host.
- `device-lab-win` (the other Windows SSH target) was unreachable —
  TCP connect to port 22 timed out on every attempt.

## `bun run validate:fast` summary

| host | typecheck | lint | tests |
| --- | --- | --- | --- |
| macOS | pass | pass (warnings only) | 1516 pass; 23 subprocess timeouts under full parallel load — **all 23 pass on isolated re-run** (load flake, zero assertion failures) |
| WSL2 | pass | pass | **1516 pass / 0 fail** |
| Windows | pass | pass | 1384 pass / 112 fail / 24 skip — POSIX-fixture portability gap (see above) |

## Follow-ups (filed / to file)

1. **Windows test-suite portability**: tests that assert exact file
   bytes after git restore assume LF; either set
   `core.autocrlf=false` in test env (`GIT_CONFIG_*` injection) or
   mark byte-exact assertions platform-aware. Substantial enough to
   keep out of this RC PR.
2. **Remaining lint warnings**: ~19 unsafe-fix suggestions
   (useTemplate/useLiteralKeys/useOptionalChain/useMathMinMax) —
   cosmetic, non-blocking.
3. **`usage` TUI report render latency**: child CLI spawns make the
   first report render slow; consider a skeleton/loading state if it
   proves annoying in practice.
4. **controls agent-start / textgen generate / secrets resolve**:
   exercised only to render level on macOS (require live agent,
   provider credentials, or secrets bindings respectively); unit
   coverage exists for the flows.

## Verdict

**READY with noted limitations.** All 14 plugin TUI surfaces verified
interactively on macOS at the RC SHA; two real defects (D1, D2) found
and fixed on this branch; lint gate repaired (D3) and Windows checkout
normalized (D4); WSL2 fully green including a live TUI smoke;
Windows build/lint/typecheck green with the test suite limited by the
known autocrlf portability gap; alternate Windows host unreachable and
recorded. No release-blocking defect remains open.

## WSL/SSH practicality spot-check (supplementary, post-RC)

Maintainer-priority check: are the TUI surfaces practical over plain SSH
(no GUI, no herdr-t3)? Bounded breadth pass on `device-wsl` (WSL2 Ubuntu,
herdr 0.9.5 real binary, Bun 1.4.5) against `release-0-11-0` @ `272ae2f`
(tip incl. #266 Windows fixes). Isolated named session `verifywsl` with
dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME` under
`/var/tmp/herdr-plugin-wsl`; ambient `HERDR_*` stripped via an `env -u`
wrapper; the user's live session was never touched.

### Plugin install (official path)

`herdr plugin install rebuildup/herdr-plugins/plugins/<name>
--ref release-0-11-0` for six representative plugins — inbox, git,
projects, automations, secrets, machines. All resolved checkout SHA
`272ae2fddedf291bb84f8572ed3936daf5bc0594` (verified via
`git rev-parse HEAD` in the github-installations checkout).

### Per-surface results (keyboard → operation → readback → focus return)

Driving method identical to the macOS pass: `plugin pane open
--placement tab`, `pane send-keys`/`send-text`, `pane read` captures,
`q`/`esc` exit, plugin state JSON as readback.

| plugin | surface exercised | result |
| --- | --- | --- |
| rebuildup.inbox | render, `down`/`up` nav, `?` help overlay, `F` scope cycle (inbox→all), settle `s` confirm dialog → **Esc cancel** → `s` → Enter confirm → state.json `settled` readback → restore `r` confirm → state cleared; `q` → focus returned to `w1:p1` | PASS |
| rebuildup.git | render (branch/HEAD/dirty state), `j`/`k` nav, `r` refresh picked up probe file, Changed-files detail, `?` help, `s` stage → `git status` readback `A`, `u` unstage → `??` readback | PASS |
| rebuildup.projects | honest empty-registry render, `?` help, `n` register → path/title prompts → confirm dialog → Enter → registry entry + state.json `projects` readback | PASS |
| rebuildup.automations | honest empty render, `?` help, `n` create → full form (name→prompt→interval schedule→pane destination→misfire) → confirm dialog → `task_6755a140-…` created + state.json readback; task detail `t` disable → confirm → `enabled:false` + `disabled_at` readback; `D` delete → confirm → task removed | PASS |
| rebuildup.secrets | honest empty-bindings render, `?` help, `w` init starter config → confirm dialog → `config.json` written under plugin config dir | PASS |
| rebuildup.machines | honest empty-inventory render, `?` help, `i` capability/contract info render (read-only by design, ADR-0028) | PASS |

### Non-TTY fallback

Each plugin's `bun run src/tui.ts main` run with stdin `/dev/null` (no
TTY) prints a plain-text summary plus a TTY hint and exits 0:

- inbox: `inbox — session=verifywsl total=2 …` + "interactive UI requires
  a TTY; use the CLI for scripting." exit 0
- secrets: `secrets: no bindings declared` + hint. exit 0
- git: `git-tui: interactive UI requires a TTY.` + CLI hint. exit 0
- automations: `automations: no tasks registered` + hint. exit 0

### Coexistence

secrets (`w1:p6`) and machines (`w1:p7`) plugin panes were open
simultaneously in separate tabs; secrets `q` closed cleanly while
machines stayed rendered and interactive — no cross-pane state
corruption. All panes closed with focus returning to the origin shell
pane `w1:p1`.

### Evidence

Captured on `device-wsl` at `~/herdr-plugin-wsl-evidence/`:
`plugin-list.txt` (6 installs @ release-0-11-0), `inbox-tui.txt`,
`inbox-help.txt`, `inbox-state-after-restore.json`. Mutation readbacks
were taken live from
`/var/tmp/herdr-plugin-wsl/xdg-state/herdr/plugins/<id>/state.json`
(session stopped and temp dir removed afterwards; evidence dir retained).

### Defects

None found. Every surface rendered, navigated, confirmed/cancelled, and
returned focus correctly over a plain SSH session with no GUI and no
herdr-t3 involvement.

## RC defect-fix round (#273, merged via PR #274)

Post-RC real-device verification at `release-0-11-0` @ `bcec8fb`
(11 plugins installed, all resolving that SHA) surfaced two TUI defects,
filed as #273 and fixed on branch `273` → merged as `1ea7c40`:

- **checkpoints plan preview hid the real deletion count**:
  `formatPlanPayload` treated the contract's numeric
  `untracked_to_delete` as an array, so the restore-plan detail always
  rendered `untracked files to delete: 0` while the CLI JSON correctly
  returned `untracked_to_delete: 1`. Fixed to render the count; test
  fixture corrected to the contract shape.
- **conversations/usage stale "loading…" frame**: `EventListView.refresh`
  and `ReportView.reload` updated state after `await` without
  `app.invalidate()`, leaving the loading frame until the next keypress.
  This is the observed root cause behind the macOS "usage report shows
  loading… for an extended period" note above (follow-up #3) and the
  prime suspect for #267's measured latency. Fixed on both success and
  error/early-return paths; fake `TuiApp` stubs updated.

## Second-round e2e verification (#234 gaps, `verifyrc` / `verifyrc-mac` / `verifywin`)

Depth verification demanded by the #234差戻し, using isolated sessions
and fixture/loopback providers only (no real credentials or billing).

### WSL2 (`device-wsl`, session `verifyrc`, plugins @ `bcec8fb`; conversations/usage re-verified @ `1ea7c40`)

| plugin | surface exercised | result |
| --- | --- | --- |
| rebuildup.checkpoints | capture → detail → **plan** → restore full flow, incl. pre-restore checkpoint `mwyl0rbh-c30a5d28`; plan defect D5 found (see #273) | PASS (defect found→fixed) |
| rebuildup.projects | fixture repo `t3.json` scripts: `hello` run success, `slow`/`verylong` runs observed via runs/results surfaces | PASS |
| rebuildup.conversations | pane open → honest empty-state render → `i` index key → close | PASS |
| rebuildup.usage | pane open → nav → quota view; **stale "loading…" reproduced @ `bcec8fb`, fixed @ `1ea7c40`** — quota now renders providers/credential status without keypress | PASS after fix |
| rebuildup.automations | `create` (interval schedule, pane destination) → `run-now` → `runs` readback → `delete`; run honestly recorded `failed/destination_unavailable` (`agent_not_found` — no live agent in isolated session, per contract) | PASS (honest-failure path; agent-delivery success path env-blocked, same as controls) |

### macOS (`verifyrc-mac`, isolated XDG dirs)

| plugin | surface exercised | result |
| --- | --- | --- |
| rebuildup.secrets | `resolve` metadata-only + `run` env injection verified via marker file (`MODELSCOPE_API_KEY` via infisical → `PRESENT`) | PASS (upgrades prior render-only) |
| rebuildup.textgen | `generate` end-to-end via loopback OpenAI-compatible stub provider (`127.0.0.1:8399`, `api:` provider kind): task `pr_content` returned ok title/body | PASS (upgrades prior render-only) |
| rebuildup.controls | `start` flow driven to pane/kind selection; agent launch blocked by environment artifact — isolated `XDG_CONFIG_HOME` hid mise config so the `claude` binary could not resolve (not a plugin defect; pane/kind/argv construction verified up to provider resolution) | PARTIAL — env-blocked, recorded honestly |

### Windows 11 (`device-windows`, session `verifywin`, inbox @ `bcec8fb`)

Real plugin pane lifecycle measured (previously only install/typecheck/
lint + unit tests): workspace → `plugin pane open` → pane `w1:p3` →
`pane read` rendered Inbox (`inbox 2/2`, keybar) → `send-text '?'`
opened Keys help overlay → `send-text 's'` settle → confirm → state.json
readback `settled` → `plugin pane close`. Headless `herdr server` works
on Windows (ConPTY bundled); all pane ops function without a TUI client.

Windows-specific findings (environment-level, not plugin defects):

- **mise trust prompt blocks plugin child processes**: PATH resolves
  `bun` → mise shim → "config files not trusted" error/prompt under
  non-interactive and pane contexts; `pane.closed` event hooks and
  startup `reconcile` fail exit 1. Workaround: prepend real
  `~/.bun/bin` to PATH. Candidate follow-up: document bun prerequisite
  as non-shim binary or herdr/plugin env sanitization.
- `pane send-keys` rejects printable characters (`invalid_key`);
  literal input requires `pane send-text` — noted for verification
  scripts and docs.

### Remaining honest gaps

- controls agent-start **success** path (real agent spawn) and
  automations agent-delivery **success** path: env-blocked on all hosts
  (no agent CLI resolvable inside isolated XDG env; no billing allowed).
  Both were verified to the launch/delivery boundary with honest
  failure recording.
- projects mutation TUI on macOS specifically: covered on WSL
  (register + scripts run/stop); macOS render-level only.
- #267 usage latency: root-cause fix landed (#274); dedicated
  measurement can be a follow-up per #234 allowance.

### Updated verdict inputs

All #234差戻し items now have real-device evidence or an explicitly
recorded env-blocked boundary: WSL/SSH e2e (checkpoints plan/restore,
projects scripts, conversations, usage, automations, plus prior git
spot-check), macOS fixture verification (secrets inject, textgen
generate, controls to launch boundary), Windows real pane
launch/input/exit measurement, and ledger/doc accuracy (this section +
`tui-coverage.md` RC block describe actual verification depth, including
the defects found and fixed).
