/**
 * Shared spawn-environment and fake-socket hygiene for the test suite
 * (issues #199 and #211; convergence required by #22 / #170).
 *
 * #199 — spawned CLI/test processes must never inherit ambient `HERDR_*`
 * variables. Inside a herdr pane or plugin invocation, `process.env`
 * carries `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_SESSION`, etc.; a
 * child spawned with a raw `process.env` copy can resolve — and for reads
 * even connect to — the developer's LIVE herdr session socket. Every
 * spawn site in `tests/` must build its env through `testEnv()` (or an
 * equivalent helper that delegates to it) so the scrub is the default,
 * not a per-file patch.
 *
 * #211 — fake herdr socket servers must bind the same transport endpoint
 * the production client dials. `socketEndpoint()` (packages/herdr-client)
 * maps the logical socket path to `\\.\pipe\<path>` on win32; fakes must
 * `listen()` on `herdrSocketEndpoint(socketPath)`, never the raw path.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizedChildEnv } from "../../packages/git-core/src/git-env";
import { socketEndpoint } from "../../packages/herdr-client/src/socket";

/**
 * Ambient herdr context variables that identify a live session/pane.
 * Documented for reviewers; the scrub itself is prefix-based (`HERDR_*`)
 * so future context vars are covered without list maintenance.
 */
export const HERDR_CONTEXT_ENV_VARS = [
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_PANE_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PLUGIN_CONTEXT_JSON",
  "HERDR_ENV",
  "HERDR_BIN_PATH",
  "HERDR_STARTUP_CWD",
] as const;

/**
 * `GH_*` targeting/debug variables stripped in addition to the git-core
 * `GIT_*` set (mirrors STRIPPED_GH_ENV_VARS in
 * packages/git-core/src/git-env.ts — kept private there, duplicated here
 * because test envs are not `gh` invocations and must not inherit repo
 * retargeting either).
 */
const TEST_STRIPPED_GH_ENV_VARS: readonly string[] = [
  "GH_REPO",
  "GH_DEBUG",
  "GH_FORCE_TTY",
  "GH_PAGER",
];

/**
 * XDG vars that relocate the herdr config/state roots
 * (`herdrConfigDir`/`herdrStateDir`/`defaultSocketPath`). Ambient values
 * would silently retarget the implicit default socket, so spawned test
 * processes get them only via explicit `extra`.
 */
const TEST_STRIPPED_XDG_ENV_VARS: ReadonlySet<string> = new Set([
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);

function isScrubbedKey(key: string): boolean {
  return key.startsWith("HERDR_") || TEST_STRIPPED_XDG_ENV_VARS.has(key);
}

/**
 * Isolated plugin state/config root shared by every scrubbed spawn in
 * this test process. Without it a spawned CLI would derive plugin dirs
 * from the ambient HOME and could read or mutate the developer's real
 * plugin state. Tests that need a dedicated dir pass
 * `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` via `extra`.
 */
let sharedPluginRoot: string | undefined;
function sharedPluginDirs(): { stateDir: string; configDir: string } {
  if (sharedPluginRoot === undefined) {
    sharedPluginRoot = mkdtempSync(path.join(tmpdir(), "herdr-test-env-"));
  }
  return {
    stateDir: path.join(sharedPluginRoot, "state"),
    configDir: path.join(sharedPluginRoot, "config"),
  };
}

/**
 * Build a scrubbed environment for a spawned test process:
 *
 * - `process.env` minus every ambient `HERDR_*` variable (socket path,
 *   session, pane/workspace/tab identity, plugin context JSON, plugin
 *   dir overrides, runtime markers — all of them), minus
 *   `XDG_CONFIG_HOME`/`XDG_STATE_HOME`, minus repo/forge-redirecting
 *   `GIT_*`/`GH_*` (same rules as `sanitizedChildEnv`/`ghChildEnv`,
 *   issue #96);
 * - `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` default to a
 *   shared per-process temp root so plugin state can never leak into the
 *   developer's real plugin directories;
 * - then `extra` applied last — the ONLY way a test opts back into
 *   `HERDR_SOCKET_PATH`, `HERDR_SESSION`, pane identity, plugin dirs,
 *   etc. Opt-ins must be socket-consistent with any `--socket`/`--session`
 *   flag the child receives (see `socketConsistentEnv`).
 */
export function testEnv(
  extra: Record<string, string | undefined> = {},
  options: {
    keepEnvPrefixes?: readonly string[];
    /**
     * `"isolate"` (default) pins HERDR_PLUGIN_STATE_DIR/CONFIG_DIR to a
     * shared temp root. `"derive"` omits them so the child resolves
     * plugin dirs from its own HOME/XDG env — only for tests that
     * explicitly exercise derived-path behavior.
     */
    pluginDirs?: "isolate" | "derive";
  } = {},
): Record<string, string> {
  const keep = options.keepEnvPrefixes ?? [];
  const env = sanitizedChildEnv({}, { extraStrip: TEST_STRIPPED_GH_ENV_VARS });
  for (const key of Object.keys(env)) {
    // `keepEnvPrefixes` is the documented opt-in for test-fixture HERDR_*
    // config channels (e.g. HERDR_MCP_ROOT_* sibling-plugin overrides)
    // that tests set on process.env deliberately. Session/pane identity
    // vars must never be admitted this way.
    if (isScrubbedKey(key) && !keep.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  const merged: Record<string, string> = { ...(env as Record<string, string>) };
  if (options.pluginDirs !== "derive") {
    const dirs = sharedPluginDirs();
    // Default plugin dirs apply only when nothing (ambient-kept or extra)
    // provides them — extra still wins below.
    if (merged.HERDR_PLUGIN_STATE_DIR === undefined) {
      merged.HERDR_PLUGIN_STATE_DIR = dirs.stateDir;
    }
    if (merged.HERDR_PLUGIN_CONFIG_DIR === undefined) {
      merged.HERDR_PLUGIN_CONFIG_DIR = dirs.configDir;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Keep an explicit `HERDR_SOCKET_PATH` consistent with `--socket`/`--session`
 * CLI flags so `resolveTarget` never sees a contradiction (issue #83
 * fail-closed rule). With `testEnv` the ambient vars are already absent;
 * this re-introduces a consistent pair only when the test asks for it.
 *
 * Handles both `--socket PATH` and `--socket=PATH`. `--session` needs no
 * ambient pair: with `testEnv` the ambient vars are absent, so the
 * explicit flag wins outright (and `HERDR_SESSION` must NOT be injected
 * here — `socketPathForSession` would resolve against the test process's
 * XDG dirs, not the child's).
 */
export function socketConsistentEnv(
  args: string[],
  extraEnv?: Record<string, string>,
): Record<string, string> | undefined {
  const env: Record<string, string> = { ...(extraEnv ?? {}) };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--socket") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        env.HERDR_SOCKET_PATH = value;
      }
    } else if (arg.startsWith("--socket=")) {
      env.HERDR_SOCKET_PATH = arg.slice("--socket=".length);
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Transport endpoint a fake herdr socket must `listen()` on — identical to
 * what `request()`/`subscribe()` dial for the same logical path (#211).
 */
export function herdrSocketEndpoint(socketPath: string): string {
  return socketEndpoint(socketPath);
}
