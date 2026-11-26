/**
 * Child-process environment hygiene for `git` (and `gh`, which shells out
 * to git for repo/remote resolution).
 *
 * `runGit`/`runGh` spawn with argv only — no shell — but the child still
 * inherits `process.env`. Ambient `GIT_*` variables exported by agent panes,
 * CI wrappers, or `git -c` parents can silently redirect repository, index,
 * object-store, discovery, or config resolution to a different target than
 * the pane cwd the plugin resolved (issue #96). This module strips every
 * `GIT_*` variable that can retarget or inject into git's view of the
 * repository while preserving the user's intentional auth/identity config.
 *
 * This file is intentionally self-contained (no imports) so it can be
 * lifted verbatim into `packages/git-core` when the 0-3.0 train extracts
 * the shared git layer — keep it that way.
 */

/**
 * Exact `GIT_*` names removed from the inherited environment.
 *
 * Repository / index / object-store redirection:
 * - GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_IMPLICIT_WORK_TREE —
 *   retarget the work tree and git dir outright.
 * - GIT_INDEX_FILE, GIT_INDEX_VERSION — retarget the index (checkpoints
 *   must never inherit an ambient scratch index).
 * - GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES — retarget the
 *   object store.
 * - GIT_NAMESPACE — retargets refs.
 * - GIT_PREFIX — set by `git` for aliases; stale values confuse subcommands.
 * - GIT_QUARANTINE_PATH — pre-receive quarantine object dir; meaningless
 *   outside hook context and can hide objects.
 * - GIT_SHALLOW_FILE, GIT_GRAFT_FILE — replace the repo's shallow/graft
 *   metadata, altering history reads.
 *
 * Discovery control:
 * - GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM — change how
 *   `rev-parse` walks up from the pane cwd.
 *
 * Config injection (command-scoped `-c` propagation):
 * - GIT_CONFIG, GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT — the transport
 *   `git -c`/libgit2 use to smuggle arbitrary config into children.
 *
 * Pathspec / object-semantics overrides:
 * - GIT_LITERAL_PATHSPECS, GIT_GLOB_PATHSPECS, GIT_NOGLOB_PATHSPECS,
 *   GIT_ICASE_PATHSPECS — rewrite every pathspec's magic.
 * - GIT_NO_REPLACE_OBJECTS, GIT_NO_LAZY_FETCH — change which objects/refs
 *   are visible.
 * - GIT_DEFAULT_HASH, GIT_DEFAULT_REF_FORMAT, GIT_REFERENCE_BACKEND —
 *   repo-format overrides.
 * - GIT_ATTR_SOURCE, GIT_ATTR_NOSYSTEM — attribute-source overrides that
 *   change filter/diff driver resolution.
 *
 * Program / output redirection:
 * - GIT_EXEC_PATH — retargets where git finds its sub-commands.
 * - GIT_EXTERNAL_DIFF, GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE, GIT_DIFF_OPTS,
 *   GIT_DIFF_PATH_COUNTER, GIT_DIFF_PATH_TOTAL — external diff program and
 *   diff option injection (the *_COUNTER/_TOTAL pair is internal state git
 *   sets for GIT_EXTERNAL_DIFF itself).
 * - GIT_EDITOR, GIT_SEQUENCE_EDITOR, GIT_PAGER — interactive programs the
 *   plugin never intends to run; stripping prevents hangs/terminal escape.
 * - GIT_TEMPLATE_DIR — init template override (defense in depth).
 * - GIT_REFLOG_ACTION — would stamp ambient text into reflogs on mutations.
 * - GIT_REF_PARANOIA, GIT_COMMIT_GRAPH_PARANOIA — ambient "false" disables
 *   integrity checks on broken refs/objects.
 * - GIT_PROTOCOL, GIT_PROTOCOL_FROM_USER — internal wire-protocol state.
 * - GIT_REDIRECT_STDIN, GIT_REDIRECT_STDOUT, GIT_REDIRECT_STDERR — Windows
 *   handle redirection that would break the spawn pipes.
 * - GIT_CURL_VERBOSE — verbose curl logging to stderr (noise in errors).
 */
const STRIPPED_ENV_VARS: ReadonlySet<string> = new Set([
  // repository / index / object store
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INDEX_VERSION",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  // discovery
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  // config injection
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  // pathspec / object semantics
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_NO_LAZY_FETCH",
  "GIT_DEFAULT_HASH",
  "GIT_DEFAULT_REF_FORMAT",
  "GIT_REFERENCE_BACKEND",
  "GIT_ATTR_SOURCE",
  "GIT_ATTR_NOSYSTEM",
  // program / output redirection
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE",
  "GIT_DIFF_OPTS",
  "GIT_DIFF_PATH_COUNTER",
  "GIT_DIFF_PATH_TOTAL",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "GIT_TEMPLATE_DIR",
  "GIT_REFLOG_ACTION",
  "GIT_REF_PARANOIA",
  "GIT_COMMIT_GRAPH_PARANOIA",
  "GIT_PROTOCOL",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_REDIRECT_STDIN",
  "GIT_REDIRECT_STDOUT",
  "GIT_REDIRECT_STDERR",
  "GIT_CURL_VERBOSE",
]);

/**
 * Prefixes removed from the inherited environment:
 * - `GIT_TRACE` — covers GIT_TRACE, GIT_TRACE_PACKET, GIT_TRACE_PERFORMANCE,
 *   GIT_TRACE_SETUP, GIT_TRACE_SHALLOW, GIT_TRACE_REFS, GIT_TRACE_FSMONITOR,
 *   GIT_TRACE_PACK_ACCESS, GIT_TRACE_PACKFILE, GIT_TRACE_CURL,
 *   GIT_TRACE_CURL_NO_DATA, GIT_TRACE_REDACT, GIT_TRACE2,
 *   GIT_TRACE2_EVENT, GIT_TRACE2_PERF, GIT_TRACE2_CONFIG_PARAMS. Trace
 *   output leaks to stderr (captured into error messages) or to arbitrary
 *   file descriptors/paths.
 * - `GIT_CONFIG_KEY_` / `GIT_CONFIG_VALUE_` — the indexed halves of
 *   GIT_CONFIG_COUNT config injection.
 * - `GIT_TEST_` — upstream test-only hooks (e.g. GIT_TEST_ASSUME_DIFFERENT
 *   _OWNER, GIT_TEST_FSYNC) that alter git behavior.
 */
const STRIPPED_ENV_PREFIXES: readonly string[] = [
  "GIT_TRACE",
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
  "GIT_TEST_",
];

/** gh-specific variables removed in addition to the GIT_* set. */
const STRIPPED_GH_ENV_VARS: ReadonlySet<string> = new Set([
  // GH_REPO is an explicit repo-targeting override; the plugin resolves the
  // forge repo itself (--repo or `gh repo view` in the repo root) and must
  // not let ambient env silently retarget it.
  "GH_REPO",
  // GH_DEBUG writes request/response logs (potentially including auth
  // headers) to stderr, which is captured into plugin error output.
  "GH_DEBUG",
  // GH_FORCE_TTY/GH_PAGER re-enable interactive behavior the plugin pins off.
  "GH_FORCE_TTY",
  "GH_PAGER",
]);

/**
 * Build the environment for a git/gh child process: `process.env` minus
 * every repo/index/object/config-redirecting `GIT_*` variable (plus any
 * `extraStrip` names, e.g. the GH_* set for `gh`), with `overrides`
 * applied last.
 *
 * Deliberately preserved (see module docstring / spec for the full
 * rationale):
 * - `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM` —
 *   user-level config *selection*, the same trust level as `~/.gitconfig`
 *   itself; they carry credential helpers, user identity, and url rewrites
 *   that users legitimately manage (dotfiles, credential helpers).
 * - `GIT_AUTHOR_*` / `GIT_COMMITTER_*` — explicit commit identity the user
 *   exported on purpose.
 * - `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, `GIT_ASKPASS`,
 *   `GIT_SSL_*`, `GIT_HTTP_*`, proxy vars, `GIT_ALLOW_PROTOCOL`,
 *   `GIT_SSL_NO_VERIFY` — authentication/transport configuration needed by
 *   fetch/push; stripping them would break users behind proxies, GHES, or
 *   custom SSH setups. `GIT_TERMINAL_PROMPT`/`GIT_OPTIONAL_LOCKS` are pinned
 *   by the caller after this helper runs.
 * - Everything non-`GIT_*` (PATH, HOME, LANG, GH_TOKEN, etc.).
 *
 * `overrides` is the trusted internal channel: callers may re-introduce a
 * stripped variable (e.g. a scratch `GIT_INDEX_FILE` for checkpoint
 * capture) only by passing it explicitly here — never via ambient env.
 */
export function sanitizedChildEnv(
  overrides: Record<string, string> = {},
  options: { extraStrip?: readonly string[] } = {},
): NodeJS.ProcessEnv {
  const extra = new Set(options.extraStrip ?? []);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      STRIPPED_ENV_VARS.has(key) ||
      extra.has(key) ||
      STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...overrides };
}

/** Environment for `gh`: git hygiene plus GH_* targeting/debug stripping. */
export function ghChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return sanitizedChildEnv(overrides, {
    extraStrip: [...STRIPPED_GH_ENV_VARS],
  });
}
