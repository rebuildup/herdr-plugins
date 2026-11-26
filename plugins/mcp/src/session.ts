/**
 * Target-session resolution for `rebuildup.mcp` (ADR-0025 §4,
 * contract "Session resolution").
 *
 * Precedence:
 *   1. `--socket PATH` (explicit socket path)
 *   2. `--session NAME` or `HERDR_SESSION` (named session socket)
 *   3. `HERDR_SOCKET_PATH` env (e.g. inherited inside a herdr pane)
 *   4. the default session socket
 *
 * Pane-scoped env (`HERDR_PANE_ID`/`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`)
 * is never consulted: it identifies a pane *inside* herdr and is
 * meaningless to the MCP server process. An MCP client with no
 * ambient herdr env must pass `--session`/`--socket` (or set
 * `HERDR_SESSION`/`HERDR_SOCKET_PATH`) in its server config — there is
 * no other discovery channel in v1.
 */

import { defaultSocketPath, sessionSocketPath } from "../../../packages/herdr-client/src/index";

export interface SessionTargetOptions {
  /** `--socket PATH`. */
  socketPath?: string | undefined;
  /** `--session NAME` (wins over `HERDR_SESSION`, loses to `--socket`). */
  session?: string | undefined;
}

export interface ResolvedTarget {
  /** Absolute-or-explicit path of the herdr socket to talk to. */
  socketPath: string;
  /**
   * Named session when one was selected via `--session`/`HERDR_SESSION`
   * (undefined for `--socket`/`HERDR_SOCKET_PATH`/default resolution —
   * the live `session.snapshot` still reports the real session name).
   */
  sessionName: string | undefined;
  /** Which precedence step produced the socket (for `capability`). */
  resolvedVia: "socket" | "session" | "env-socket" | "default";
}

export function resolveTarget(options: SessionTargetOptions = {}): ResolvedTarget {
  if (options.socketPath !== undefined && options.socketPath !== "") {
    return {
      socketPath: options.socketPath,
      sessionName: undefined,
      resolvedVia: "socket",
    };
  }
  const session = options.session ?? process.env.HERDR_SESSION;
  if (session !== undefined && session !== "") {
    return {
      socketPath: sessionSocketPath(session),
      sessionName: session,
      resolvedVia: "session",
    };
  }
  const envSocket = process.env.HERDR_SOCKET_PATH;
  if (envSocket !== undefined && envSocket !== "") {
    return { socketPath: envSocket, sessionName: undefined, resolvedVia: "env-socket" };
  }
  return { socketPath: defaultSocketPath(), sessionName: undefined, resolvedVia: "default" };
}
