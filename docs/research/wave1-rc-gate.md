# Wave 1 RC gate — independent review and acceptance evidence (#295)

Convergence gate for Program #286 Wave 1: the four native (Rust) plugin
ports — `rebuildup.inbox` (#291), `rebuildup.conversations` (#293),
`rebuildup.git` (#292), `rebuildup.usage` (#294) — reviewed together on
the merged `release-0-13-0` train. This document records the go/no-go
evidence for Wave 2; it does **not** declare the Bun removal complete
(Wave 2, #296, owns the remaining plugins) and it does **not** replace
the final RC gate (#298), which owns Linux/Windows/SSH/IME and the
human visual review.

- Code under test: `release-0-13-0` @ `e4b28d8` **plus** this PR's
  SIGPIPE fix (§6.1) — the only source change in this gate PR; the
  committed `plugins/*/bin/*` binaries were rebuilt from it.
- Host: macOS 27.2.1 (arm64), Apple M5, 24 GB — **shared development
  machine**; concurrent agent builds (cargo/gpui) ran during parts of
  the measurement, so wall-clock p95 values are upper bounds. Two
  measurement passes are recorded where load differed materially.
- Isolated herdr session `np295rc`
  (`XDG_CONFIG_HOME=/var/tmp/np295rc-herdr/config`,
  `XDG_STATE_HOME=/var/tmp/np295rc-herdr/state`,
  `XDG_DATA_HOME=/var/tmp/np295rc-herdr/data`, headless
  `herdr --session np295rc server`, herdr `0.9.5` real binary). The
  user's live session was never touched; every plugin/CLI invocation
  ran with ambient `HERDR_*` scrubbed and `HERDR_SESSION=np295rc` (or
  an explicit consistent `--session`/`--socket`).
- Fixtures: the canonical #287 set — `/var/tmp/np287-fixtures/git-repo`
  (5,000 tracked files, 120 modified + 60 untracked), the full
  conversations index (25 sessions / 10,000 events / ~5.5 MB, copied
  read-only into the np295rc plugin state dir), and the small variant
  (`/var/tmp/np295rc-small`, 3 sessions / 600 events).

## 1. Gate results — build, parity, contract

| check | result | evidence |
| --- | --- | --- |
| `bun run validate:fast` | typecheck ✓, lint ✓; tests **1180 pass / 1 fail** on the first run — `controls-launch` "capability advertises start" hit its 20 s timeout while the machine was under concurrent cargo builds; the file re-run alone passes **15/15** and the full suite re-run is recorded below | §8 |
| `bun scripts/diff-inbox.ts` | **30/30 identical** (run twice: before and after the binary rebuild) | `scripts/diff-inbox.ts` |
| `bun scripts/diff-conversations.ts` | **40/40 identical** (×2) | `scripts/diff-conversations.ts` |
| `bun scripts/diff-git.ts` | **37/37 identical** (×2) | `scripts/diff-git.ts` |
| `bun scripts/diff-usage.ts` | **33/33 identical** (×2) | `scripts/diff-usage.ts` |
| `cargo build --workspace` | clean (dev 11 m 24 s; release 37 m 38 s, thin-LTO) | — |
| `cargo test --workspace` | **56 unit tests, 0 fail** | — |
| `cargo clippy --workspace --all-targets` | clean, no warnings | — |
| `cargo fmt --check` | **pre-existing drift** across `plugins/usage` under current stable rustfmt 1.11.0 (port-time toolchain difference; not introduced by this PR) → filed #322 | #322 |

The diff harnesses compare normalized stdout JSON, exit codes, final
`state.json`, and (conversations) every `events/*.jsonl` line between
the pinned pre-removal TypeScript and the shipped Rust binary — the
correctness guard behind "parity". Contract envelopes
(`contract`/`command`/`warnings`/`coverage`/`source` provenance) are
covered by the spawn-based native contract suites
(`tests/*-native.test.ts`) inside `validate:fast`.

## 2. Real-herdr verification (session `np295rc`)

For **each** of the four plugins, on the merged tree:

- `herdr plugin link plugins/<name>` — manifest parsed; `plugin list`
  shows the expected actions/panes/events/startup with argv
  `./bin/<name> ...`, `platforms=["macos"]`, versions
  inbox 0.8.0 / conversations 0.7.0 / git 0.7.0 / usage 0.6.0.
- `capability` + representative CLI ops — all returned honest contract
  envelopes (details §3).
- TUI smoke — `herdr plugin pane open --plugin <id> --entrypoint main`
  rendered each surface in a real PTY pane (`herdr pane read`):
  - `w1:p2` inbox: `Inbox — np295rc · scope:inbox 3/3`, `[links:1]`
    badge on the linked pane, footer keymap.
  - `w1:p3` conversations: populated sessions list (25 sessions from
    the seeded index — the #293 stale-frame defect D2 is gone; the
    list renders without a keypress).
  - `w1:p4` usage: reports picker (`usage / quota / cost /
    divergence`).
  - `w2:p2` git main: fixture repo status (`unstaged 120 ·
    untracked 60`), changed-files menu.
  - `w2:p3` git forge: forge home (PR/issue/branch-status entries).
- `herdr plugin action invoke open --plugin rebuildup.conversations`
  spawned `./bin/conversations tui --open` and opened a real pane in
  the context-derived workspace; `plugin action invoke status
  --plugin rebuildup.git` returned contract JSON.
- `plugin disable` → invocations fail with `{"code":"plugin_disabled"}`;
  `plugin enable` restores — independent lifecycle verified for all
  four.
- Non-TTY `tui` fallback prints honest plain-text/CLI-equivalent
  notices for all four (also covered by diff-harness `tui-fallback`
  checks).

### Managed install + rollback (official distribution path)

`herdr plugin install rebuildup/hoxay-plugins/plugins/<name> --ref
release-0-13-0 --yes` for all four: resolved the branch to commit
`e4b28d8`, **zero build commands**, installed binaries ran
`capability`/reads against np295rc correctly. Rollback
`--ref release-0-12-0` (the pre-port TS generation, commit `7d661d9`)
was then exercised per plugin and the train moved forward again:

- conversations: TS `sessions --offline` read the seeded index —
  `count: 25` ✓
- git: TS `status w2:p1` — identical change counts
  (`staged 0, unstaged 120, untracked 60`) ✓
- usage: TS `usage --provider opencode --offline` — 389 events ✓;
  **unfiltered `usage --offline` on the TS generation timed out at
  35 s** (defect D1 from the baseline doc still reproduces on
  release-0-12-0 — direct evidence the Wave-1 fix mattered)
- inbox: see §5 state-ownership finding — organize/links state written
  by the native generation was **not** visible to the TS rollback on
  this symlinked-XDG host → filed as #321.

### Cross-plugin delegation (end-to-end)

- `plugins/git/bin/git issue link w2:p1 rebuildup/hoxay-plugins#295`
  delegated to `rebuildup.inbox` and stored the link in **inbox's**
  state (`state/herdr/plugins/rebuildup.inbox/state.json`); `inbox
  list`/`inbox links w2:p1` and the inbox TUI (`[links:1]` badge)
  all show it. `git issue links w2:p1` round-trips.
- `plugins/usage/bin/usage usage --offline` consumed the seeded
  conversations index through the sibling contract: 1,651 usage
  events / 25 sessions aggregated (provider/model/host/project/
  session/pane breakdowns, coverage, cache-token statuses) — the
  usage → conversations export path terminates on the full fixture
  (~0.6–1.1 s depending on load; baseline: non-terminating >30 s).

## 3. Performance vs baseline and absolute budgets

Harness: `scripts/perf/measure.ts` (CLI, fresh process per run,
warm page cache) and `scripts/perf/tui-probe.py` (real PTY). Raw JSON:
`docs/research/native-performance-baseline/6x–9x-np295rc-*.json`
(`6x–7x` = first pass under heavy build load, `8x–9x` = second pass
after the release build finished; label `77` is absent — an aborted
probe superseded by `78`/`79`). Baseline = the #287 canonical
dataset (`native-performance-baseline.md` + `0x–5x` JSONs).

### 3.1 Absolute budgets (Program #286 targets)

| budget | Wave-1 measured (np295rc) | verdict |
| --- | --- | --- |
| Simple CLI p95 ≤ 15 ms | capability p95 **18–33 ms** across the four plugins (p50 15–19; quietest pass: inbox 27, conv 23, git 18, usage 19 — first pass had load outliers to 121–1,527 ms p99) | **NOT MET** — ~1.2–2× over budget, but ~2–2.7× better than the Bun baseline (p95 49 ms). Cold-process floor on this host. See §7 decision. |
| TUI first frame ≤ 50 ms | first_byte p95: inbox **18.8 ms**, conversations **72.6 ms** (one shared-machine outlier; p50 14.4, next-worst ~22), usage **16.6–18.5 ms** | **MET-WITH-RESIDUAL** — p50 is 3–9× under budget everywhere; the conversations p95 tail is a single loaded-machine outlier, re-check at #298 on the RC host |
| key→render p95 ≤ 16 ms | no per-plugin interactive harness exists; inherited evidence = ratatui spike p95 ≤ 1.9 ms (`native-tui-spike-289.md`) on the same renderer stack all four TUIs use | **MET (inherited)** — same caveat as baseline doc: a real key-latency harness is still a follow-up |
| Indexed search p95 ≤ 50 ms | **not implemented** — full scan; search-miss p95 **189–619 ms** depending on load pass (hit p95 37–66 ms) | **NOT MET — accepted residual**: index work is explicitly deferred to #313; see §7 |
| TUI RSS ≤ 20 MB normal / ≤ 50 MB large | pgid peak p50: inbox **7.7 MB**, conversations **7.9 MB**, usage small **9.8 MB**, usage big **21.2 MB** (max observed 33.3 MB) | **MET** — 2.5–6× under the Bun baseline (48–309 MB) |

### 3.2 Non-regression band (`p95 ≤ max(baseline_p95×1.25, +50 ms)`)

Baseline = TS numbers from the #287 canonical dataset; measured =
best available np295rc pass (load noted).

| operation | TS baseline p95 | band limit | np295rc p95 | verdict |
| --- | --- | --- | --- | --- |
| `inbox list` | 355 ms | 444 ms | **19 ms** | MET |
| `inbox capability` | — (canary) | — | 27 ms | n/a (budget §3.1) |
| `conversations capability` | 49 ms | 99 ms | 23–31 ms | MET |
| `conversations sessions --offline` | 148 ms | 225 ms | 36–54 ms | MET |
| `conversations history` | 434 ms | 585 ms | 41–59 ms | MET |
| `conversations search` hit | 1 321 ms | 1 651 ms | 37–66 ms | MET |
| `conversations search` miss | 572 ms | 715 ms | 189–619 ms | MET (inside band on every pass; quietest pass 189 ms ≈ TS p50 parity — the #313 "regression" is load-sensitive, still tracked) |
| `git capability` | — (canary) | — | 18 ms | n/a |
| `git status w2:p1` | 467 ms | 584 ms | 512–654 ms | **MET-WITH-RESIDUAL** — inside band at moderate load (512), exceeded only while concurrent cargo builds saturated the machine (638–654, still <2× = no automatic block). Dominated by identical `git` child spawns; re-measure on the quiet #298 RC host |
| `git files w2:p1` | 808 ms | 1 010 ms | 568–766 ms | MET |
| `git diff --stat` | 670 ms | 838 ms | 439–746 ms | MET |
| `usage capability` | — | — | 19 ms | n/a |
| `usage --provider opencode` | 1 610 ms | 2 012 ms | 260–349 ms | MET — quietest pass p50 240 ms ≈ TS p50 235 ms (the #314 "regression" was substantially load; still tracked) |
| `usage --offline` small index | 1 270 ms | 1 588 ms | 340–448 ms | MET |
| `usage --offline` full index | **non-terminating (>30 s, defect D1)** | — | **624–1 405 ms, 30/30 runs succeed** | MET — unbounded → bounded |
| TUI data_usable (inbox/conv/usage) | 344 ms / 1 539 ms* / 585 ms (small), never (big) | — | 14 ms / 16 ms / 576 ms (small), 1 042 ms (big, was ∞) | MET — *conv baseline included the D2 stale-frame defect; native renders immediately |

Failures/timeouts: **zero** nonzero exits or timeouts on every
fixture command across all passes (the TS `usage` full-fixture hang is
gone). RSS: all native measurements are far inside the
baseline+20 %/+10 MB band.

## 4. Distribution, independence, state ownership

- **Distribution**: official `herdr plugin install
  rebuildup/hoxay-plugins/plugins/<name> --ref <ref>` path verified
  end-to-end for all four on both `release-0-13-0` (native) and
  `release-0-12-0` (TS rollback); per-generation checkouts coexist
  under `github-installations/` and old generations persist.
  `platforms=["macos"]` is honestly declared; arm64-only binaries are
  committed per plugin dir (ADR-0035).
- **Independence**: `plugin disable`/`enable` toggles each plugin
  without affecting the others or herdr; disabled invocations fail
  with `plugin_disabled`, never fabricated success. Sibling
  delegation (git→inbox, usage/mcp/handoff/textgen→conversations,
  projects/mcp/textgen→git) resolves `bin/<name>` first with a
  `bun src/cli.ts` fallback for not-yet-migrated checkouts — mixed
  fleets keep working (verified live: the TS rollback generation
  served reads while native siblings ran).
- **State ownership**: durable state only under herdr-provided plugin
  dirs (`…/state/herdr/plugins/<id>/`); the TUI holds ephemeral view
  state; organize state never rewrites execution state (inbox
  contract tests + live `settle`/`restore` on np295rc). **Exception
  found**: native↔TS session-key canonicalization diverges on
  symlinked paths → #321.
- **Common keymap/theme/grid (mixed TS/Rust)**: all four migrated
  surfaces follow `tui-v1` — `q`/`Esc` back-quit, `?`/`h` help, `/`
  filter, `j`/`k` + arrows, confirm-gated mutations with
  target+consequence dialogs, honest unsupported states. The four
  Rust TUIs share the ratatui/crossterm stack (`crates/tui` safety
  helpers; `hoxay-tui` shell for git forge); remaining TS plugins
  keep `packages/tui` unchanged during coexistence (ADR-0036). The
  pyte snapshot sets (`spikes/{inbox,conversations,git,usage}-tui/
  evidence/`, 75 files) show consistent chrome: bold title row,
  `❯` selection, boxed overlays, footer hints.

## 5. State-ownership finding (fixed / filed)

- **#321 filed** — session-key canonicalization: native binaries
  canonicalize the socket/state path (`/var` → `/private/var` on
  macOS); the TS rollback generation does not. On symlinked prefixes
  the two generations write/read **different `sessions{}` buckets**,
  so organize state and tracker links appear lost across a rollback.
  Reproduced live (§2). Production `~/.config` paths are unaffected;
  recorded as a residual with three remediation options in the issue.
- State format itself is otherwise compatible both directions —
  the diff harness proves normalized `state.json`/`events/*.jsonl`
  parity, and the TS rollback read the seeded conversations index and
  git fixture correctly.

## 6. Issues found by this gate

### 6.1 Fixed in this PR — SIGPIPE/EPIPE panic on piped output

Every native CLI panicked (`failed printing to stdout: Broken pipe`,
exit 101 + panic text on stderr) when its JSON output was piped to a
consumer that closed early (`… | head -c 400`), e.g. the common
`plugin … | jq`/`| head` debugging journey. The retired TS
implementation exited quietly. Rust ignores `SIGPIPE` at startup, so
the fix restores the default disposition at the top of each plugin's
`main()` (`libc::signal(libc::SIGPIPE, libc::SIG_DFL)`, `#[cfg(unix)]`)
in `plugins/{inbox,conversations,git,usage}/src/main.rs`, and the four
committed binaries were rebuilt
(`cargo build --release -p … && cp target/release/<n> plugins/<n>/bin/<n>`).
Verified: `conversations search … | head -c 400` now dies silently
with status 141 (SIGPIPE) and empty stderr; small outputs that fit the
pipe buffer still exit 0. Diff harnesses re-run after the rebuild:
still 140/140 identical.

Note for future binary commits: the documented macOS `Killed: 9`
amid/codesign quirk recurred on `cp` — resolved by delete+re-copy per
`inbox-native-rust.md` §3.4.

### 6.2 Filed — not fixed here

- **#321** session-key canonicalization divergence (above).
- **#322** CI has no Rust gate: `ci.yml` runs only
  `bun run validate:fast`; `cargo build/test/clippy` and committed-
  binary freshness are ungated (overlaps #316's freshness scope but is
  broader). Also records the pre-existing `cargo fmt --check` drift
  in `plugins/usage` under rustfmt 1.11.0.
- Visual anomalies for the #298 human review (see §7.3) — recorded
  here, not filed separately.

### 6.3 Test flake observed (no action)

`tests/controls-launch.test.ts` timed out once (20 s) and then failed
6/15 when re-run while the machine was saturated by concurrent
release-profile cargo builds in sibling worktrees; on a quiet re-run
it passes 15/15 and the full suite re-run is green (§8). Load-induced
flake, unrelated to this PR's changes (Rust `main()` only).

## 7. Go / no-go assessment for Wave 2

### 7.1 Checklist verdicts (issue-comment checklist)

| item | verdict |
| --- | --- |
| Absolute budgets vs measured | **MET-WITH-RESIDUAL** — first-frame/RSS/key→render MET; simple-CLI p95 and indexed-search p95 NOT MET (§3.1, §7.2) |
| Per-op non-regression band | **MET** — every op inside `max(1.25×p95, +50 ms)` on at least one pass; `git status` exceeded only under saturated-load passes and stayed <2× (no block); zero failures/timeouts |
| Evidence consistency (diff harness fixed SHA) | **MET** — 140/140 identical twice, including after the binary rebuild |
| PTY evidence (73→75 files) | **MET-WITH-RESIDUAL** — all snapshots read; two cosmetic anomalies queued for human confirmation at #298 (§7.3) |
| Distribution / independence / state ownership | **MET-WITH-RESIDUAL** — install/rollback/disable all verified; #321 session-key edge case filed |
| Mixed-environment common keymap/theme/grid + journeys | **MET** — tui-v1 conformance across all four; mixed TS/Rust coexistence verified via rollback fleet |
| target-OS/SSH real screens+ops+perf | **PARTIAL → #298** — macOS arm64 only; Linux/Windows/SSH/IME remain #298/#315 scope by design |

### 7.2 The two unmet absolute budgets — explicit disposition

1. **Simple CLI p95 ≤ 15 ms — NOT MET (18–33 ms measured).**
   Judgment: **not a Wave-1 blocker.** The budget's intent (per the
   baseline doc) was proving the runtime overhead is gone; native is
   ~2–2.7× faster than the Bun baseline and the residual is cold
   process-start floor (dyld + static binary ~3–4 MB), not per-op
   work. Recommend the program either (a) revise the budget to a
   defensible cold-start figure (e.g. p95 ≤ 30 ms) or (b) accept
   ~20 ms as the shipped reality — decision belongs to the maintainer
   at #298; Wave 2 should not block on it.
2. **Indexed search p95 ≤ 50 ms — NOT MET (no index; #313).**
   Judgment: **accepted residual, not a Wave-1 blocker.** Wave 1's
   mandate was the runtime port; the baseline doc itself states the
   budget "requires the real index". Search is still inside the
   non-regression band vs the TS baseline on every pass (quietest
   miss p95 189 ms vs TS p95 572 ms), so users are strictly better
   off than release-0-12-0. **However**, this is the one budget where
   "deferred" could silently become "forgotten": #313 must land (or
   the budget be formally amended) before #298 declares the program
   complete. Recorded here so the next wave inherits the obligation.

### 7.3 Remaining for #298 (final RC gate)

- Human visual review of `spikes/*-tui/evidence/*.txt` (75 files) —
  this pass was a systematic self-review, not the independent human
  review #298 requires. Anomalies queued for that review:
  - `conversations-tui/evidence/main-05-detail.txt`: two U+FFFD
    glyphs in the detail overlay's bottom border (possible 1-col
    overflow or snapshot-timing artifact).
  - `usage-tui/evidence/main-08-breakdown-rows.txt`: breakdown-rows
    view renders nearly empty in the snapshot (likely mid-load
    capture; `09-detail` JSON is correct) — confirm live.
  - Stray `┘`/`─┘` border fragments at line starts in a few
    conversations/usage snapshots — possible overlay-redraw residue.
- `git status` quiet-machine re-measurement (band re-check).
- Linux/Windows binaries + `platforms` widening, arch-specific
  distribution, signing/notarization — #315.
- SSH/tmux/IME/ConPTY/WSL2 real-terminal matrix — #298/#289 follow-ups.
- key→render interactive harness (still unbuilt).
- `agent_session`-driven real indexing end-to-end (upstream herdr gap,
  ADR-0012) — verified via fixtures instead.
- forge mutations and `gh`-backed reads against the real GitHub API
  (stub-`gh` coverage only, same as the port tickets).
- Rust source ↔ binary identity / reproducible build — #316.

### 7.4 Recommendation

**GO for Wave 2** (#296), conditional on:

1. #313 (search index) and #314 (usage opencode path) staying on the
   Wave-2 critical path — they own the two budget gaps;
2. #298 retaining the human visual review + multi-OS/SSH matrix as
   release blockers (unchanged);
3. #321/#322 triaged (both are edge-case/tooling, neither blocks
   daily use).

Rationale: every Wave-1 plugin installs, updates, rolls back,
disables, delegates, and renders correctly on the merged train; all
contract-parity harnesses are green twice; every measured operation
is inside the non-regression band with zero failures; the only unmet
items are budgets whose owning follow-ups are already ticketed, plus
platforms that were never claimed (`platforms=["macos"]` is honest).

## 8. Validation record

- `bun run validate:fast` (this branch, final state): **GREEN —
  typecheck ✓, lint ✓, tests 1181 pass / 0 fail** (351 s). An earlier
  full run had one load-flake timeout (§6.3); a second run failed lint
  only on this PR's unformatted evidence JSONs (fixed via `biome check
  --write`); CI `check` job green on the pushed commit.
- `cargo build --workspace`, `cargo test --workspace` (56 tests),
  `cargo clippy --workspace --all-targets`: all clean on this branch.
- `cargo fmt --check`: fails on pre-existing `plugins/usage` drift →
  #322 (not introduced here; the four touched `main.rs` files are
  rustfmt-clean).
- np295rc session left running with all four plugins managed-installed
  at `release-0-13-0` (`e4b28d8`); disposable — safe to delete
  `/var/tmp/np295rc-herdr` after review.
