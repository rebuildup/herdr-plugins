# ADR-0009: Fail-closed herdr target resolution and sanitized git/gh child env

## Status

Accepted (Issue #83 / #96, mandated by Issue #170's public gate)

## Context

Two ambient-environment defects let plugin operations silently retarget
away from the intended session/repository:

- **#83**: `resolveSocketPath` gave ambient `HERDR_SOCKET_PATH` priority
  over an explicit `--session`/`--socket` flag, and over nothing at all
  for mutations. An agent pane inside session A that exports
  `HERDR_SOCKET_PATH`/`HERDR_SESSION` (herdr injects both into plugin
  panes) could have an explicit `--session B` CLI invocation — e.g. from
  a script, another agent, or a nested herdr context — write organize
  state and pane metadata onto session A's socket. Pane ids like `w1:p1`
  repeat across sessions, so the wrong target is not even detectable by
  id shape.
- **#96**: `runGit`/`runGh`/`collectDiff` spawned with
  `{...process.env, ...pins}`, so ambient `GIT_DIR`, `GIT_INDEX_FILE`,
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`,
  `GIT_WORK_TREE`, `GIT_EXTERNAL_DIFF`, and friends could redirect repo,
  index, object-store, discovery, or config resolution away from the
  pane cwd the plugin resolved — including onto a different repository
  entirely.

Upstream herdr (`src/session.rs::active_api_socket_path`) already gives
an explicit `--session` precedence over `HERDR_SOCKET_PATH`; the plugin
contract had diverged from that.

## Decision

1. **Explicit beats ambient; contradictions fail closed.** New
   `resolveTarget` in `packages/herdr-client` resolves
   `--socket`/`--session` → consistent ambient `HERDR_SOCKET_PATH`/
   `HERDR_SESSION` pair → default socket. Every explicit↔ambient and
   ambient↔ambient disagreement throws `TargetResolutionError`
   (`target_conflict`, exit 1) instead of silently picking a side.
   Ambient `HERDR_SOCKET_PATH` still beats ambient `HERDR_SESSION`
   (upstream order) but the pair must agree on one socket.
2. **Mutations require a real target.** Commands that write plugin
   state or pane metadata pass `mutation: true`; resolution then
   rejects the implicit default socket with `target_required` (exit 1).
   Reads keep the default fallback. Applies to inbox
   settle/snooze/restore/reconcile/watch/_wake + hooks, and git
   stage/unstage/commit/branch/upstream/fetch/push/pr create/project.
3. **Ambient pane identity is verified, not trusted.** When the pane id
   comes from `HERDR_PANE_ID`/plugin context (not an explicit
   positional), ambient `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID` must match
   the pane in the resolved session's snapshot
   (`ambient_identity_mismatch`, exit 1) before any metadata write.
4. **Denylist env sanitization for git/gh children.**
   `plugins/git/src/git-env.ts` strips every `GIT_*` variable that can
   retarget or inject into git's view (repo/index/object/discovery/
   config/pathspec/program redirection, `GIT_TRACE*`, `GIT_TEST_*`,
   `GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`) plus `GH_REPO`, `GH_DEBUG`,
   `GH_FORCE_TTY`, `GH_PAGER` for `gh`. User-level config selection
   (`GIT_CONFIG_GLOBAL`/`SYSTEM`/`NOSYSTEM`), commit identity
   (`GIT_AUTHOR_*`/`GIT_COMMITTER_*`), and auth/transport
   (`GIT_SSH*`/`GIT_ASKPASS`/`GIT_SSL_*`, `GH_TOKEN`/`GH_HOST`/…) are
   preserved deliberately — stripping them would break legitimate
   user setups. The plugin's own pins are applied after stripping;
   `overrides` is the only trusted channel for re-introducing a
   stripped name (e.g. a future scratch `GIT_INDEX_FILE`).

## Consequences

- Session names are validated against herdr's `validate_name` rules
  (ASCII alnum + `.`/`_`/`-`, ≤64 bytes); invalid names are usage
  errors (`invalid_session`, exit 2) from flags, fail-closed from env.
- Socket paths compare via `realpathSync` when the path exists, so
  symlinked state dirs (e.g. macOS `/var` → `/private/var`) cannot
  produce false conflicts.
- `git-env.ts` is deliberately self-contained so the 0-3.0 train can
  lift it verbatim into `packages/git-core` when the shared git layer
  is extracted.
- A user who *wants* ambient `GIT_*` retargeting (e.g. wrappers that
  set `GIT_DIR` deliberately) loses it; that is the intended trade —
  the pane cwd is the only repository authority.
- Error surface grows: `target_conflict`, `target_required`,
  `ambient_identity_mismatch`, `invalid_session` are new
  `error.code` values on stderr; both contracts document them.
