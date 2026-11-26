# OS matrix verification — Issue #170 (release-safety gate)

Cross-platform install/runtime verification for the v0.2.0–v0.8.0
content carried by `release-0-8-0`. Method follows
`docs/research/rc-0-2-0-verification.md` (fixed SHA, isolated env,
real `herdr plugin install`/`link` smoke).

## Fixed target

- Release branch: `release-0-8-0` (dash form; the branch was renamed
  from `release-0.8.0`-style naming during this verification window —
  `git ls-remote` is the authority).
- Code under test: `83c4b372d947f62161559e433edb2335487528b5`.
  During verification the branch advanced to
  `71e7844de52c8ef55e283fafc10ae934effb0327`; the delta is **docs-only**
  (`docs/research/170-plugin-lifecycle.md` + its merge, PR #206), so all
  product-code results below apply identically to the current tip.
  The macOS re-run was executed at `71e7844` itself.
- herdr `0.9.5` (protocol 22) on all three hosts; Bun `1.4.4` (macOS,
  Windows) / `1.4.5` (WSL).

## Environment

| OS | Host | OS version | arch | bun | herdr | Reachability |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | local | macOS 27.2.1 (26B131) | arm64 | 1.4.4 | 0.9.5 | local |
| Linux | `device-wsl` (ssh) | Ubuntu 26.04.1 LTS, WSL2 kernel 6.18.58.1-microsoft-standard-WSL2 | x86_64 | 1.4.5 | 0.9.5 | OK |
| Windows | `device-lab-win` (ssh) | Windows 11, build 10.0.26320.10022 | x86_64 | 1.4.4 (mise) | 0.9.5 | OK |
| Windows (alt) | `device-windows` (ssh) | — | — | — | — | **UNREACHABLE** — ssh connects but every command exits 1 with no output; recorded as unverified, not skipped silently |

Notes:

- `device-wsl` and `device-lab-win` had no prior `herdr-plugins`
  checkout; both were cloned fresh at the fixed SHA
  (`~/herdr-plugin-osverify`, `C:\Users\user\herdr-plugin-osverify`).
  `git clone --branch release-0-8.0` fails on all hosts with
  "Remote branch not found" because the real ref is
  `refs/heads/release-0-8-0` (dash); workaround used everywhere:
  full clone + `git fetch --depth 1 origin "+refs/heads/*:refs/remotes/origin/*"`
  + checkout by SHA. Single-ref fetches by short name fail even on
  macOS git 2.56.1 — a git/GitHub ref-negotiation quirk, not OS-specific.
- `device-lab-win` `~/.gitconfig` is a **broken symlink** into
  `~/.dotfiles` (target path contains unrepresentable chars; git reports
  "Invalid argument"). All git/herdr commands there were run with
  `GIT_CONFIG_GLOBAL=C:\Users\user\osverify-gitconfig` (empty file) +
  `GIT_CONFIG_NOSYSTEM=1`. Without this, `herdr plugin install` fails
  inside its own `git fetch` — device environment issue, not a plugin
  defect.
- Neither remote had plugins installed before verification; all
  installs below were uninstalled afterwards (`herdr plugin list` →
  "No plugins installed" on both).

## Results

| OS | `bun install` | typecheck | lint | `bun test` | Plugin install smoke |
| --- | --- | --- | --- | --- | --- |
| macOS arm64 | PASS | PASS | PASS (pre-existing FIXABLE warnings only) | **792 pass / 1 fail** at `71e7844` (see F2) | PASS (see below) |
| Linux WSL2 x86_64 | PASS | PASS | PASS | **793 pass / 0 fail** at `83c4b37` | PASS — 3× GitHub install + link, resolved `71e7844` |
| Windows 11 x86_64 | PASS | PASS | PASS (FIXABLE warnings only) | **510 pass / 275 fail / 1 error** at `83c4b37` | PASS — 3× GitHub install + link, resolved `71e7844` |

Commands run per host: `bun install`, then
`bun run validate:fast` (= `tsc --noEmit` + `bunx @biomejs/biome check`
+ `bun test --timeout 20000`).

### macOS detail

- First full run **inside a herdr pane** (ambient `HERDR_*` exported):
  774 pass / 19 fail — all 19 in `tests/mcp-events.test.ts` /
  `tests/mcp-mutations.test.ts`.
- Root cause: the spawned MCP test servers inherit
  `HERDR_SOCKET_PATH=/Users/rebui/.config/herdr/herdr.sock`, which now
  *conflicts* with the explicit `--socket <fake>` flag under the strict
  target resolution added by the #83/#96 propagation. Reproduced
  manually: tool returns `session_unreachable` with message
  "--socket … conflicts with ambient HERDR_SOCKET_PATH …; unset the
  ambient variable or drop the explicit flag". This is intended product
  behavior; the mcp test files spawn servers with `env:
  { ...process.env }` and do not scrub `HERDR_*` — a **test-hygiene
  gap**, not a product defect.
- Re-run with ambient `HERDR_SOCKET_PATH`, `HERDR_SESSION`,
  `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`,
  `HERDR_PLUGIN_*`, `HERDR_BIN_PATH`, `HERDR_ENV`,
  `HERDR_STARTUP_CWD`, `TERM_PROGRAM` unset: **792 pass / 1 fail**.
  The single failure (`git-env.test.ts` › "GIT_DIR/GIT_WORK_TREE … do
  not retarget repo B", 11.1s under parallel load) **passes in
  isolation** (1.3s) — load-sensitive flake, not a correctness failure.
- Effective macOS verdict: **PASS** (clean-env), with two follow-up
  candidates: scrub `HERDR_*` in mcp test spawns; investigate the
  git-env timing flake.

### Linux (WSL2) detail

- `bun install` + `bun run validate:fast` at `83c4b37`: typecheck clean,
  biome clean, **793 tests / 0 fail** in 29s.
- Plugin smoke: `herdr plugin install rebuildup/herdr-plugins/{inbox,git,secrets}
  --ref release-0-8-0 -y` → all three installed, `plugins.json`
  `resolved_commit = 71e7844de52c8ef55e283fafc10ae934effb0327`
  (current tip; product code identical to `83c4b37`).
  `herdr plugin link ~/herdr-plugin-osverify/plugins/usage` →
  `plugin_linked` with correct `plugin_root`; unlinked afterwards.
  `herdr plugin uninstall` ×3 → registry back to "No plugins installed".
- herdr server was already running on the device (version 0.9.5); no
  session was created or touched — plugin registry operations only.

### Windows detail

- `bun install` + `bun run validate:fast` at `83c4b37`: typecheck PASS,
  lint PASS, **`bun test`: 510 pass / 275 fail / 1 error** (785 tests
  discovered vs 793 elsewhere — 8 tests not discovered/collected on
  Windows; see F1).
- Failure signature is uniform: spawned plugin CLIs / MCP servers report
  structured `session_unreachable` against the tests' fake herdr socket.
- **Root cause (verified by minimal repro):**
  `packages/herdr-client/src/socket.ts:42-46` maps the socket path to a
  Windows named pipe `\\.\pipe\<socket path>` on `process.platform ===
  "win32"`. The test fakes (`tests/*.test.ts` `fakeHerdr` helpers) call
  `net.createServer().listen(<raw filesystem path>)`, which on Windows
  binds an AF_UNIX-style endpoint — *not* the named pipe the client
  dials. Direct experiment: server on `C:/…/fake-test2.sock` + client
  on `\\.\pipe\C:/…/fake-test2.sock` → `connect ENOENT`.
- The **product transport is correct on Windows**: the real herdr
  0.9.5 server on `device-lab-win` listens on
  `\\.\pipe\C:\Users\user\AppData\Roaming\herdr\herdr.sock` (verified by
  successful `net.connect`), matching the client's mapping. The gap is
  in the **test harness**: fakes do not emulate the win32 named-pipe
  endpoint, so every socket-dependent test fails on Windows.
- Secondary environmental noise on this device: broken `~/.gitconfig`
  symlink (see Environment) produced `git init` warnings inside tests
  and single `git_missing` / `provider_error` failures; not counted as
  platform defects.
- Plugin smoke (with `GIT_CONFIG_GLOBAL` workaround):
  `herdr plugin install rebuildup/herdr-plugins/{inbox,git,secrets}
  --ref release-0-8-0 -y` → installed, resolved `71e7844`.
  `herdr plugin link C:\Users\user\herdr-plugin-osverify\plugins\usage`
  → `plugin_linked`; manifest recorded
  `plugin_root: C:\…\plugins\usage`, `manifest_path` under the `\\?\`
  verbatim prefix — Windows path handling OK. Unlinked + all three
  uninstalled afterwards → "No plugins installed".
- Windows verdict: **PARTIAL** — install/runtime smoke PASS, but
  `validate:fast` is red on Windows today. This is a release-safety
  finding: the fast gate is not usable as a Windows signal until the
  test fakes learn the named-pipe transport (follow-up ticket
  candidate). It does not by itself prove a product runtime defect —
  the real-herdr socket path was verified end-to-end.

### macOS plugin install smoke

Covered by the sibling lifecycle verification
(`docs/research/170-plugin-lifecycle.md`): `plugin link` ×14 and
`plugin install …/inbox --ref release-0-8-0` resolving `83c4b37` on an
isolated session. During this OS-matrix run a `plugin link`/`install`/
`unlink` cycle was also exercised against the live registry (see
Isolation caveat below) — link, GitHub install, and uninstall all
functioned; the inbox entry was restored to its prior GitHub source
(`414e87dea9faa5c221fb27508e5828f086849836`, the commit recorded in the
pre-existing `github-installations/rebuildup.inbox-91021cbdd6f7`
checkout).

## Findings

- **F1 (Windows, test harness):** fake herdr sockets in `tests/` bind
  raw paths; the client requires `\\.\pipe\<path>` on win32. ~275 test
  failures on Windows are this single gap. Fix direction: teach the
  fake-server helper to `listen("\\\\.\\pipe\\" + socketPath)` on
  win32 (or skip socket-dependent tests on win32 until then).
- **F2 (all hosts, test hygiene):** `tests/mcp-*.test.ts` (and likely
  other spawn-based suites) inherit ambient `HERDR_*`; inside a herdr
  pane the strict socket/flag conflict check fails 19 mcp tests on
  macOS. Scrub `HERDR_SOCKET_PATH`/`HERDR_SESSION`/`HERDR_PANE_ID` etc.
  in test spawn env.
- **F3 (flake):** `tests/git-env.test.ts` › "GIT_DIR/GIT_WORK_TREE …
  do not retarget repo B" failed once under full-suite parallel load on
  macOS (11.1s), passed in isolation. Watch for recurrence.
- **F4 (methodology):** `XDG_CONFIG_HOME`/`XDG_STATE_HOME` alone do
  **not** isolate the herdr plugin registry on macOS herdr 0.9.5 —
  `~/.config/herdr/plugins.json` is still read/written. The sibling
  lifecycle doc's isolation additionally set `HERDR_CONFIG_PATH`, which
  is the effective override. Operators reusing the XDG-only recipe
  will touch the live registry (this run did; restored afterwards).
- **F5 (device env, not product):** `device-lab-win` has a broken
  `~/.gitconfig` symlink; git and `herdr plugin install` fail without
  `GIT_CONFIG_GLOBAL` override. `device-windows` ssh alias is
  unreachable (commands exit 1 silently) — only one Windows host was
  verified.
- **F6 (git quirk, not OS):** `git fetch origin release-0-8-0` /
  `clone --branch` fail with "couldn't find remote ref" on git 2.53–
  2.56 across macOS/Linux/Windows while `ls-remote` and wildcard
  fetches succeed; single-ref fetch by short name is unreliable for
  this repo. Use explicit `refs/heads/*` refspecs or SHA checkout.

## Platform-specific code observations

- `packages/herdr-client/src/socket.ts` already special-cases win32
  (`\\.\pipe\` mapping) — the only hardcoded transport divergence found;
  it matches real herdr 0.9.5 behavior on Windows.
- `plugins/projects` runner has explicit shell-family detection
  (cmd/powershell/posix + win32 host default) with dedicated tests;
  those tests could not run green on Windows only because of F1.
- `packages/git-core`/`plugins/git` sanitize repo-redirecting `GIT_*`
  env (`git-env.ts`, `ghChildEnv`) — relevant on Windows where ambient
  git env differs; covered by `tests/git-env.test.ts` (PASS on
  macOS/Linux).
- No hardcoded `/` path separators or POSIX-shell assumptions found in
  plugin runtime code paths exercised; manifest `platforms` already
  lists `["linux","macos","windows"]` for all plugins.

## Verdict

| OS | Verdict |
| --- | --- |
| macOS arm64 | **PASS** — 792/793 with scrubbed env (1 load flake, passes isolated); install smoke PASS |
| Linux WSL2 x86_64 | **PASS** — 793/793; install smoke PASS |
| Windows 11 x86_64 (`device-lab-win`) | **PARTIAL** — install/runtime smoke PASS; `validate:fast` red due to test-harness named-pipe gap (F1), not a demonstrated product defect |
| Windows (`device-windows`) | **UNVERIFIED** — host unreachable |

Release-safety recommendation: Linux + macOS evidence is solid for
v0.2.0–v0.8.0 content. Windows runtime install path is proven against
real herdr 0.9.5, but the automated gate needs the F1 test-harness fix
(and ideally a second Windows host) before Windows can be called fully
verified. F2/F3/F4 are cheap follow-ups.

## Cleanup / residue

- `device-wsl`: clone left at `~/herdr-plugin-osverify` @ `83c4b37`;
  plugins uninstalled ("No plugins installed"); no sessions touched.
- `device-lab-win`: clone left at `C:\Users\user\herdr-plugin-osverify`
  @ `83c4b37`; plugins uninstalled; helper files
  `C:\Users\user\osverify-gitconfig`, `%TEMP%\socktest*.ts` remain
  (harmless; `osverify-gitconfig` is an empty file created for the
  broken-`.gitconfig` workaround).
- macOS: worktree `/Users/rebui/work/herdr-plugin-osmatrix` holds this
  doc on branch `170-os-matrix`; live herdr registry restored
  (inbox re-installed from GitHub @ `414e87d`, matching its prior
  managed checkout); `/tmp/herdr-osverify`, `/tmp/mcp-repro.ts`,
  `/tmp/socktest*.ts`, `/tmp/fetchtest` are disposable.
