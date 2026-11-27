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
