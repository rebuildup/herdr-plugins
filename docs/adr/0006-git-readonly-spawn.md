# ADR-0006: Git plugin stage 1 — argv-spawned read-only git, on-demand projection

## Status

Accepted (v0.2.0, `rebuildup.git` stage 1)

## Context

Issue #2 stage 1 requires per-pane Git status/diff for `rebuildup.git`.
Constraints inherited from the project contract: herdr owns execution
state; no daemon, no high-frequency polling; no unverified string
interpolation into commands; unsupported/disconnected states must not be
reported as success; stage 2 will add mutations, so the read path must not
paint us into a corner.

## Decision

1. **Git access = `git` binary via argv spawn.** Every repository query is
   a `spawn("git", [...args], { cwd })` call — no shell, no string
   interpolation of pane paths or revisions into a command line. The pane
   cwd comes from `session.snapshot` (herdr is the source of truth) and is
   passed as the spawn `cwd`, never concatenated into argv text.
2. **Env hygiene**: `GIT_TERMINAL_PROMPT=0` (no credential prompts),
   `LC_ALL=C` (stable porcelain parsing), inherited `PATH`/`HOME` only.
3. **Bounded execution**: every git call has a hard timeout
   (`config.json timeoutMs`, default 10s, `--timeout` override) and `diff`
   output is byte-capped (`diffMaxBytes`, default 256 KiB) with an explicit
   `truncated` flag. Timeouts and caps are structured errors/results, not
   silent partial success.
4. **On-demand projection**: `project` computes status and reports
   `pane.report_metadata` tokens when a client asks. No event hooks and no
   watch loop in stage 1 — Git state does not correlate with herdr
   agent-status events, and polling would violate the no-daemon
   constraint. Stage 2 may add opt-in refresh.
5. **Worktree-correct identity**: repo root is
   `git rev-parse --show-toplevel` of the pane cwd, so linked worktrees
   resolve to their own root; `git_common_dir` is exposed so clients can
   distinguish worktrees of one repository.
6. **No durable plugin state in stage 1**: status/diff are pure functions
   of the live repository. The plugin still uses herdr-managed config/state
   dirs for `config.json`; nothing else is persisted.

## Consequences

- Large repositories are bounded by timeout/byte caps; clients see
  `timeout`/`truncated` rather than hangs or silent truncation.
- Mutations in stage 2 reuse the same spawn helper with an explicit
  allow-list of write commands; the read path stays side-effect free.
- Checkpoints (#4) can consume `status`/`diff --stat` output as the
  file-state inventory without depending on internal git parsing.
- If `git` is absent or the pane cwd leaves all work trees, commands fail
  with structured `git_missing`/`not_a_repo` — never an empty success.
