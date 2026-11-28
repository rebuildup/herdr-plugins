# Research: native Rust port of rebuildup.machines (Issue #326)

Implementation + verification record for porting `plugins/machines`
from TypeScript (Bun) to a committed native binary (Rust), per ADR-0035
(native plugin distribution) and ADR-0036 (native TUI runtime).
Wave-2 child of program #286 / plan `docs/research/wave2-native-migration-plan.md`
(§3.3, W2-A tranche, C3). Wave-1 reference: `inbox-native-rust.md`.

Verification host: macOS arm64 (Apple M5), shared development machine.
Linux and Windows are **unverified** — `platforms = ["macos"]` in the
manifest is the honest scope until binaries for other targets exist and
are verified (tracked by #315).

## 1. What shipped

| piece | location | notes |
| --- | --- | --- |
| plugin binary | `plugins/machines/bin/machines` (committed, macOS arm64) | manifest argv is `./bin/machines`; no Bun/toolchain needed at install or run time |
| CLI | `plugins/machines/src/{cli,model,remote,state}.rs` | contract `herdr-plugins.machines/v1` (unchanged); version `0.1.0` |
| TUI | `plugins/machines/src/tui.rs` | contract `herdr-plugins.tui/v1`; in-process domain calls (no self-CLI respawn) |
| shared socket/client helpers | `crates/herdr-client` | target resolution, NDJSON RPC, atomic state-file helpers |
| shared TUI safety | `crates/tui` (`safety.rs`) | `sanitize_display` on every untrusted render path |
| TS implementation | deleted (`plugins/machines/src/*.ts`, `package.json`, 3 retired test files) | recoverable at the parent of the removal commit |

Manifest entrypoints (`[[panes]] main`, `[[actions]] open`) run
`./bin/machines tui main|open`. `platforms` narrowed from
`["linux","macos","windows"]` to `["macos"]` — honest until per-OS
binaries exist (#315). Public contract `herdr-plugins.machines/v1` is
unchanged; `docs/contracts/machines-v1.md` and `docs/specs/machines.md`
were updated to the `./bin/machines` invocation.

## 2. Contract parity evidence

- `tests/machines-native.test.ts` — 19 spawn-based contract tests
  against a stub `herdr` (HERDR_BIN_PATH): usage errors, exit codes,
  list/probe state taxonomy (ok/disabled/unreachable/
  unsupported_remote/plugin-surface-unsupported), selector resolution
  (id / case-insensitive label / ambiguous / not-found), honest
  `machine_list_failed`, missing-binary failure, non-TTY `tui`
  fallback.
- `scripts/diff-machines.ts` — TS↔Rust parity harness modeled on
  `diff-git.ts`/`diff-inbox.ts`. `git archive`s `plugins/machines` +
  `packages` at the pinned pre-removal commit, runs both
  implementations against the same stub `herdr` and isolated
  state/config dirs, and deep-compares normalized stdout **and stderr**,
  exit codes, final `state.json`, and recorded probe metadata.
  Result: **35/35 checks identical** (usage-errors ×9, capability/help,
  list ×2, probe-single ×3, probe-states ×6, probe-all, list-after-probe,
  tui-non-tty, list-failure ×3, target-flag env forwarding, state
  parity). Documented intentional divergences, normalized by the
  harness: `usage`/hint strings name the invocation (`bun run
  src/cli.ts` vs `machines`). Re-run: `bun scripts/diff-machines.ts`.
- `cargo test -p machines`, `cargo clippy -p machines --all-targets`,
  `cargo fmt -p machines -- --check` — clean.
- `bun run validate:fast` — see PR checks / §5.

## 3. Bugs found by review (all fixed before landing)

Independent two-axis review (standards + spec) of the port found:

1. **Cancelled probes fabricated persisted state.** A cooperative cancel
   surfaced as `RemoteError(kind="cancelled")` but
   `classify_snapshot_error` converted it into a `state:"error"`
   MachineProbe that the TUI recorded as last-known metadata — a state
   value outside the contract taxonomy. Fixed: `probe_machine_entry` /
   `probe_plugin_surface` now propagate `cancelled` as `Err`,
   `probe_all_machines` reports partial completion, and the TUI records
   nothing and reports `cancelled` — matching the TS path where the
   killed CLI child recorded nothing.
2. **`plugin.pane.open` error kind regression.** The `open` helper
   always emitted `pane_open_failed`, discarding the upstream RPC error
   code the TS preserved via `err.code`. Fixed: `ClientError::Rpc`
   surfaces `rpc.code`/`rpc.message`; transport failures keep
   `pane_open_failed`.
3. **Missing reserved-key contract.** tui-v1 §6 / ADR-0033 require
   `?`/`h` help generated from the keymap table and Ctrl-C
   cancel-then-exit. Added `MACHINES_TUI_KEYMAP` + `View::Help`; bare
   Ctrl-<key> now exits when no task is running (cancel still wins
   during a probe).
4. **Unsafe terminal restore.** `Terminal::new` failure returned with
   raw mode + alternate screen still active; now restores both (same
   pattern as `plugins/inbox/src/tui.rs`).
5. **Unsanitized remote text.** Status line and the plain-text fallback
   printed remote-sourced fields raw; all render paths now go through
   `sanitize_display`/`bound_text` (tui-v1 §5 item 8).

## 4. OS / environment verification matrix

| target | status | evidence |
| --- | --- | --- |
| macOS arm64 | verified | this doc's harness + tests on the dev host; committed `bin/machines` |
| Linux | not verified | no binary; `platforms` excludes it honestly — #315 |
| Windows | not verified | same — #315 |
| SSH remote probe | transport unchanged | stub-`herdr` parity only; live remote machines were not available in this environment (same limitation as the TS implementation's own verification) |

## 5. Performance

machines is I/O-bound by design (ADR-0028): every remote call is a
`herdr --machine <id>` CLI spawn; the port keeps that boundary and adds
no ambient polling. Measured on the shared dev host (load caveated,
debug build for Rust):

| op | TS (bun) p50 / p95 | Rust (debug) p50 / p95 |
| --- | --- | --- |
| `capability` (offline) | ~1089 ms / ~2071 ms | ~81 ms / ~356 ms |
| `list` (stub herdr) | ~774 ms / ~2498 ms | ~135 ms / ~173 ms |

The dominant win is removing the Bun runtime startup; per-spawn bridge
cost is unchanged by contract. Absolute-budget conformance for this
plugin is assessed at the Wave-2 gate (#295/#298), not claimed here.

## 6. Known limitations / follow-ups

- Linux/Windows binaries, signing, arch selection: #315.
- Committed-binary freshness / reproducible-build identity: #316
  (overlaps #322 CI gate).
- `probe --all` is sequential by design (SSH bridge churn); recorded
  probe metadata is last-known, never live truth.
- Live-probe verification against a real second machine remains a
  #298 RC item (the TS implementation had the same evidence gap).

## 7. Rollback

`herdr plugin install … --ref release-0-12-0` restores the TS
generation; state format (`state.json` schema v1, `probes` map) is
unchanged and readable both directions — the diff harness asserts
state parity. The TS sources remain recoverable at the parent commit
of the removal commit on this branch.
