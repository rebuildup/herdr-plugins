# Convergence report — Issue #170 (release-safety gate)

Final convergence evidence for the stacked release train
`release-0-2-0` … `release-0-8-0`, centered on the #83/#96
target-isolation fix (fail-closed `resolveTarget` +
`sanitizedChildEnv`/`ghChildEnv`). Assembled 2026-11-26 on branch
`170-convergence` off `origin/release-0-8-0`.

## Per-train convergence table

Tip SHAs are `origin/release-<train>` at fetch time. "Fix present"
evidence was verified by grep on each tip: `resolveTarget` with the
`target_required`/`target_conflict` fail-closed paths in
`packages/herdr-client/src/socket.ts`, `options.mutation = true` /
`{ mutation: true }` gating in plugin CLIs and `plugins/inbox/src/hook.ts`,
and `sanitizedChildEnv`/`ghChildEnv` in the git-env module
(`plugins/git/src/git-env.ts` on 0-2.0 — `packages/git-core` does not
exist there yet; `packages/git-core/src/git-env.ts` on 0-3.0+).

Test counts are `bun test --timeout 30000` with ambient `HERDR_*`
stripped (`env -u HERDR_SOCKET_PATH -u HERDR_PANE_ID
-u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_SESSION
-u HERDR_PLUGIN_CONTEXT_JSON -u HERDR_ENV -u HERDR_BIN_PATH
-u HERDR_STARTUP_CWD`). Trains marked "recorded" reuse the
post-propagation results already on file; the others were re-run in a
clean detached worktree at the tip SHA on this date — all pass, zero
failures, no flakes observed.

| Train | Tip SHA | Fix-present evidence | `bun test` result | RC / verification doc |
| --- | --- | --- | --- | --- |
| release-0-2.0 | `b39bd51c0ed64cda7842305f04ab40de61e6f2fc` | `resolveTarget` fail-closed + `target_required` in `packages/herdr-client/src/socket.ts`; `options.mutation = true` in `plugins/git/src/cli.ts`, `plugins/inbox/src/cli.ts`, `plugins/inbox/src/hook.ts`; `sanitizedChildEnv`/`ghChildEnv` in `plugins/git/src/git-env.ts` | **133 pass / 0 fail** (7 files, this run @ tip) | `docs/research/rc-0-2-0-verification.md` |
| release-0-3.0 | `64ce29ff5adaaf6858b40f63092a03473aefb350` | same socket.ts fail-closed paths; mutation gating in git/inbox/projects CLIs; `sanitizedChildEnv`/`ghChildEnv` moved to `packages/git-core/src/git-env.ts` | **231 pass / 0 fail** (10 files, this run @ tip) | `docs/research/rc-0-3-0-verification.md` |
| release-0-4.0 | `e6449d5a8b7e5ef833930bc9fc1b9defd1f2a664` | same as 0-3.0 (propagation merge `e6449d5` — ambient-consistency test fixes for `--socket` call sites) | **270 pass / 0 fail** (13 files, this run @ tip) | `docs/research/rc-0-4-0-verification.md` |
| release-0-5.0 | `82986bc45974e6ac3b14f4788c92f49ba1e568ad` | same as 0-4.0 | **576 pass / 0 fail** (recorded post-propagation) | no dedicated rc doc; latest on branch `docs/research/rc-0-4-0-verification.md` + per-plugin verification docs |
| release-0-6.0 | `ecb64d0bc30588f1a7db559d6506001e13e36d5a` | same as 0-4.0 | **754 pass / 0 fail** (recorded post-propagation) | no dedicated rc doc; per-plugin docs (`controls-v1`, `handoff-v1`, `textgen-v1`, …) |
| release-0-7.0 | `84349bb9854958c14006b7fb5b030995656bb228` | same as 0-4.0 | **754 pass / 0 fail** (42 files, this run @ tip) | no dedicated rc doc; per-plugin docs (`artifacts-v1`, `automations-t4`, `mcp-v1`, …) |
| release-0-8.0 | `ef3844323087600b7e7dbf8e25b8a9404c2bf082` | same; tip is the merged docs evidence (PRs #206/#208/#210) | **793 pass / 0 fail** (recorded post-propagation) | `docs/research/rc-0-8-0-verification.md` |

No propagation defect was found on any train. The fix landed first on
`release-0-2-0` via PR #194 (`b39bd51`, merge of branch `83`) and was
propagated forward through 0-3.0 (`64ce29f`), 0-4.0 (`e6449d5`),
0-5.0, 0-6.0, 0-7.0 (`84349bb`), and is contained in 0-8.0.

## v0.1.0 published-impact assessment

Per the #83 audit comment: the defect **is present in the published
v0.1.0** (ambient `HERDR_SOCKET_PATH` took precedence over explicit
`--session`/`--socket`). Impact is limited to `rebuildup.inbox` —
organize state (settle/snooze/restore) and pane metadata projection on
the wrong session's socket; no destructive herdr execution operations
exist in v0.1.0. Failure mode is silent wrong-session update, not data
destruction. **No backport was performed**; the fix ships with the
next release train. Tracked in issue #83.

## Evidence documents (all merged on `release-0-8-0`)

| Evidence | Issue/PR | Doc | Merge SHA |
| --- | --- | --- | --- |
| Plugin lifecycle verification — all 14 plugins, isolated named session `verify170`, real herdr 0.9.5 | PR #206 | `docs/research/170-plugin-lifecycle.md` | `71e7844` |
| Contract/security re-check — Secrets/MCP/Checkpoints/Automations permission, target, and failure contracts after the common fix | PR #208 | `docs/research/170-contract-recheck.md` | `5694d24` |
| OS matrix — macOS arm64 / Linux (WSL2, `device-wsl`) / Windows 11 (`device-lab-win`), official install + representative ops | PR #210 | `docs/research/170-os-matrix.md` | `ef38443` (tip) |

## Known residuals (tracked, not silently passed)

- **#209 (OPEN)** — `plugins/secrets` `classifyFailure` embeds provider
  stderr (up to 300 chars) verbatim into error `detail`; a secret value
  echoed by a failing provider CLI could leak into CLI output.
  Verified with a fake-provider marker fixture; fix direction is
  redact/sanitize plus enabling the skipped negative test. Severity
  low–medium; does not regress the #83/#96 fix.
- **#211 (OPEN, F1)** — `packages/herdr-client` tests' fake herdr
  socket binds a raw filesystem path, which Windows maps to a named
  pipe; `bun test` shows 275 fails on Windows. Product transport is
  correct (real herdr 0.9.5 listens on `\\.\pipe\` — verified on
  `device-lab-win`); this is a test-harness gap, so `validate:fast` is
  **not** a usable Windows gate until fixed. Related F2: mcp tests do
  not scrub ambient `HERDR_*`, causing 19 fails when run inside a herdr
  pane (intended strictness, but test-env hygiene needed).
- **`device-windows` ssh alias unreachable** — commands exit 1
  silently; only `device-lab-win` provided Windows coverage. Recorded
  as unverified in the OS matrix, not skipped.
- **Linux/Windows install coverage for v0.3.0+ trains** is partial:
  the OS matrix ran against the cumulative `release-0-8-0` candidate.
  Per-train OS re-verification was deliberately not repeated
  mechanically (per #170: avoid 7× identical full builds; verify the
  final cumulative candidate comprehensively plus each version's
  unique diff). Train-specific diffs since 0-8.0's ancestors are
  covered by the per-train unit suites above.

## Verdict against #170's pre-release conditions

- **#83/#96 resolved in implementation, not warning/manual** — DONE.
  Fail-closed `resolveTarget` (`target_conflict` /
  `target_required` / `ambient_identity_mismatch`) plus
  `sanitizedChildEnv`/`ghChildEnv` are present and green on every train
  tip; real-machine negative tests prove zero side effects on the
  wrong session (PR #194 evidence, `tests/herdr-target.test.ts` on all
  trains).
- **Fixed candidate SHAs + proportionate re-verification** — DONE.
  Every train tip is pinned above; unit suites re-run or recorded per
  train with ambient `HERDR_*` stripped; no evidence was reused across
  different SHAs.
- **Manifest OS (macOS/Linux/Windows) real-device verification for
  v0.3.0+** — DONE with recorded gaps: OS matrix PASS on macOS, WSL2
  Linux, and Windows 11 for install/update/representative ops;
  `device-windows` unreachable and the Windows `validate:fast` harness
  gap are filed as #211 / documented residuals rather than claimed as
  passes.
- **Plugin lifecycle / coexistence / failure contracts** — DONE via
  PR #206 (14 plugins: link + GitHub install, enable/disable,
  state dirs, multi-plugin coexistence on isolated session) and
  PR #208 (contract re-check; finding filed as #209).
- **Release PR base/HEAD, ledger, tag/install behavior sync; publish
  approval reserved to maintainer** — evidence assembled here; the
  `release-* → main` merges and any `v*` tag/publish still await
  explicit maintainer authorization per the delivery workflow.

**Overall verdict: the stacked train has converged for the
release-safety gate.** The known target-isolation defect is fixed in
code on every release train with per-train test evidence, the v0.1.0
published impact is assessed (no backport, inbox-scope only), and all
remaining findings are tracked as open issues (#209, #211) or
documented environment gaps rather than hidden passes. Publication
authorization remains with the maintainer.
