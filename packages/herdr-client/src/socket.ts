/**
 * Minimal typed client for the herdr local socket API.
 *
 * Transport: newline-delimited JSON over a Unix domain socket, or a Windows
 * named pipe on win32 (`\\.\pipe\<socket path>`), matching herdr's own
 * integration assets. One request per line; the first response line with a
 * matching `id` resolves the request.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface HerdrError {
  code: string;
  message: string;
}

export class HerdrRpcError extends Error {
  readonly code: string;
  constructor(error: HerdrError) {
    super(`${error.code}: ${error.message}`);
    this.name = "HerdrRpcError";
    this.code = error.code;
  }
}

export interface RequestOptions {
  /** Timeout in milliseconds. Default 10_000. */
  timeoutMs?: number;
}

let nextRequestId = 0;

function nextId(prefix: string): string {
  nextRequestId += 1;
  return `${prefix}-${process.pid}-${nextRequestId}`;
}

function socketEndpoint(socketPath: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${socketPath}`;
  }
  return socketPath;
}

/**
 * Open a connection to the herdr socket and send one request.
 * The server answers one line per request; the socket is closed after the
 * response unless `keepOpen` semantics are needed (use `subscribe`).
 */
export function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const endpoint = socketEndpoint(socketPath);
  const id = nextId("hp");

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    let buffer = "";

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`herdr request ${method} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: { id?: string; result?: unknown; error?: HerdrError };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        if (message.error) {
          finish(() => reject(new HerdrRpcError(message.error as HerdrError)));
        } else {
          finish(() => resolve(message.result));
        }
        return;
      }
    });

    socket.on("error", (err) => {
      finish(() => reject(err));
    });
    socket.on("close", () => {
      finish(() => reject(new Error(`herdr socket closed before answering ${method}`)));
    });
  });
}

export interface Subscription {
  /** Resolves with the acknowledgement result once the subscription is active. */
  readonly started: Promise<unknown>;
  /** Async iterator of pushed event envelopes `{ event, data }`. */
  readonly events: AsyncIterable<{ event: string; data: unknown }>;
  /** Close the subscription connection. */
  close(): void;
}

/**
 * Open a long-lived `events.subscribe` connection. The caller owns `close()`.
 * Events keep arriving until the socket closes; callers must handle
 * `events_lost` errors surfaced through the request promise or stream end.
 */
export function subscribe(
  socketPath: string,
  subscriptions: Array<Record<string, unknown>>,
  options: RequestOptions = {},
): Subscription {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const endpoint = socketEndpoint(socketPath);
  const id = nextId("hp-sub");
  const socket = net.createConnection(endpoint);

  const queue: Array<{ event: string; data: unknown }> = [];
  const waiters: Array<(value: IteratorResult<{ event: string; data: unknown }>) => void> = [];
  let buffer = "";
  let acknowledged = false;
  let closed = false;

  let ackResolve: (value: unknown) => void = () => {};
  let ackReject: (error: Error) => void = () => {};
  const started = new Promise<unknown>((resolve, reject) => {
    ackResolve = resolve;
    ackReject = reject;
  });
  const ackTimer = setTimeout(() => {
    ackReject(new Error(`herdr events.subscribe timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`,
    );
  });
  socket.on("error", (err) => {
    clearTimeout(ackTimer);
    ackReject(err);
  });
  socket.on("close", () => {
    if (!acknowledged) {
      clearTimeout(ackTimer);
      ackReject(new Error("herdr socket closed before subscription started"));
    }
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  });

  const pushEvent = (event: string, data: unknown) => {
    const value = { event, data };
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      queue.push(value);
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let message: {
        id?: string;
        result?: unknown;
        error?: HerdrError;
        event?: string;
        data?: unknown;
      };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === id) {
        if (message.error) {
          // Subscription rejected (e.g. unknown subscription type): fail the
          // ack and end the stream rather than hanging `started` forever.
          clearTimeout(ackTimer);
          acknowledged = true;
          closed = true;
          socket.destroy();
          ackReject(new HerdrRpcError(message.error));
          for (const waiter of waiters.splice(0)) {
            waiter({ value: undefined, done: true });
          }
          continue;
        }
        acknowledged = true;
        clearTimeout(ackTimer);
        ackResolve(message.result);
        continue;
      }
      if (typeof message.event === "string") {
        pushEvent(message.event, message.data);
      }
    }
  });

  const events: AsyncIterable<{ event: string; data: unknown }> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<{ event: string; data: unknown }>> {
          const queued = queue.shift();
          if (queued) return Promise.resolve({ value: queued, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };

  return {
    started,
    events,
    close() {
      closed = true;
      socket.destroy();
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    },
  };
}

/** Resolve the pending `started` promise for callers that want fail-fast. */
export async function awaitStarted(subscription: Subscription): Promise<void> {
  await subscription.started;
}

export function defaultSocketPath(): string {
  return path.join(herdrConfigDir(), "herdr.sock");
}

export function sessionSocketPath(session: string): string {
  return path.join(herdrConfigDir(), "sessions", session, "herdr.sock");
}

/**
 * How the resolved socket target was chosen.
 * - `flag`: explicit `--socket`/`--session` CLI options.
 * - `env`: ambient `HERDR_SOCKET_PATH`/`HERDR_SESSION` (consistent pair).
 * - `default`: no explicit or ambient target — the implicit default session
 *   socket. Mutating operations must not use this (see `resolveTarget`).
 */
export type TargetSource = "flag" | "env" | "default";

export interface ResolvedTarget {
  socketPath: string;
  source: TargetSource;
  /**
   * Session name when the target is a named-session socket (`default` for
   * the default session); `null` for custom socket paths whose session
   * cannot be named.
   */
  session: string | null;
}

export type TargetErrorCode =
  | "target_conflict"
  | "target_required"
  | "invalid_session"
  | "ambient_identity_mismatch";

/**
 * Structured target-resolution failure. `usage` marks errors caused by an
 * explicit CLI value (callers map them to exit code 2); ambient conflicts
 * and missing mutation targets are runtime errors (exit code 1).
 */
export class TargetResolutionError extends Error {
  readonly code: TargetErrorCode;
  readonly usage: boolean;
  constructor(code: TargetErrorCode, message: string, usage = false) {
    super(message);
    this.name = "TargetResolutionError";
    this.code = code;
    this.usage = usage;
  }
}

export interface ResolveTargetOptions {
  /** Explicit `--session NAME`. */
  session?: string | undefined;
  /** Explicit `--socket PATH`. */
  socketPath?: string | undefined;
  /**
   * When true (mutating operations), the implicit default-session fallback
   * is rejected: the target must come from explicit flags or a consistent
   * ambient environment.
   */
  mutation?: boolean | undefined;
}

/** Mirrors herdr's `validate_name` (src/session.rs): ASCII alnum + `.` `_` `-`. */
const SESSION_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidSessionName(name: string): boolean {
  // "default" is a valid name upstream; socketPathForSession maps it to the
  // default session socket, mirroring herdr's active_name() filter.
  return SESSION_NAME_PATTERN.test(name) && name !== "." && name !== "..";
}

/**
 * Canonicalize a socket path for equality checks: resolve symlinks when the
 * path exists (herdr state dirs are often symlinked, e.g. /var → /private/var
 * on macOS), otherwise normalize lexically.
 */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

function nonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Session-name → socket path. The session name `default` (and an unset
 * HERDR_SESSION) maps to the default session socket, mirroring herdr's
 * `data_dir_for(None)`; named sessions live under `sessions/<name>/`.
 */
export function socketPathForSession(session: string): string {
  if (session === "default") return defaultSocketPath();
  return sessionSocketPath(session);
}

function validateSessionName(name: string, source: "flag" | "env"): string {
  if (!isValidSessionName(name)) {
    throw new TargetResolutionError(
      "invalid_session",
      `${source === "flag" ? "--session" : "HERDR_SESSION"} is not a valid herdr session name: ${JSON.stringify(name)}`,
      source === "flag",
    );
  }
  return name;
}

/**
 * Resolve which herdr socket to talk to.
 *
 * Precedence mirrors herdr's own `active_api_socket_path` with explicit
 * plugin flags promoted above ambient environment (upstream:
 * `--session` > `HERDR_SOCKET_PATH` > `HERDR_SESSION` > default):
 *
 * 1. `--socket PATH` — wins over everything; must be consistent with any
 *    ambient `HERDR_SOCKET_PATH`/`HERDR_SESSION` that is set.
 * 2. `--session NAME` — the named session's socket; must be consistent
 *    with ambient `HERDR_SOCKET_PATH`/`HERDR_SESSION`.
 * 3. Ambient context — `HERDR_SOCKET_PATH` wins over `HERDR_SESSION`
 *    (upstream order); when both are set they must agree on the same
 *    socket or resolution fails closed.
 * 4. Default session socket — implicit fallback, rejected for mutations
 *    (`mutation: true`) with `target_required`.
 *
 * Any contradiction between explicit targets and ambient environment —
 * or between the two explicit flags — throws TargetResolutionError
 * (`target_conflict`) instead of silently picking one side.
 */
export function resolveTarget(options: ResolveTargetOptions = {}): ResolvedTarget {
  const flagSocket = nonEmpty(options.socketPath);
  const flagSessionRaw = nonEmpty(options.session);
  const envSocket = nonEmpty(process.env.HERDR_SOCKET_PATH);
  const envSessionRaw = nonEmpty(process.env.HERDR_SESSION);

  const flagSession = flagSessionRaw ? validateSessionName(flagSessionRaw, "flag") : undefined;
  const envSession = envSessionRaw ? validateSessionName(envSessionRaw, "env") : undefined;

  const conflict = (message: string): never => {
    throw new TargetResolutionError("target_conflict", message);
  };

  if (flagSocket && flagSession) {
    const sessionSocket = socketPathForSession(flagSession);
    if (!samePath(flagSocket, sessionSocket)) {
      conflict(`--socket ${flagSocket} does not match --session ${flagSession} (${sessionSocket})`);
    }
  }

  if (flagSocket) {
    if (envSocket && !samePath(flagSocket, envSocket)) {
      conflict(
        `--socket ${flagSocket} conflicts with ambient HERDR_SOCKET_PATH ${envSocket}; ` +
          `unset the ambient variable or drop the explicit flag`,
      );
    }
    if (envSession) {
      const envSocketPath = socketPathForSession(envSession);
      if (!samePath(flagSocket, envSocketPath)) {
        conflict(
          `--socket ${flagSocket} conflicts with ambient HERDR_SESSION ${envSession} ` +
            `(${envSocketPath}); unset the ambient variable or drop the explicit flag`,
        );
      }
    }
    return {
      socketPath: flagSocket,
      source: "flag",
      session: flagSession ?? envSession ?? null,
    };
  }

  if (flagSession) {
    const resolved = socketPathForSession(flagSession);
    if (envSocket && !samePath(resolved, envSocket)) {
      conflict(
        `--session ${flagSession} (${resolved}) conflicts with ambient HERDR_SOCKET_PATH ` +
          `${envSocket}; unset the ambient variable or drop the explicit flag`,
      );
    }
    if (envSession && envSession !== flagSession) {
      conflict(
        `--session ${flagSession} conflicts with ambient HERDR_SESSION ${envSession}; ` +
          `unset the ambient variable or drop the explicit flag`,
      );
    }
    return { socketPath: resolved, source: "flag", session: flagSession };
  }

  if (envSocket) {
    if (envSession) {
      const sessionSocket = socketPathForSession(envSession);
      if (!samePath(envSocket, sessionSocket)) {
        conflict(
          `ambient HERDR_SOCKET_PATH ${envSocket} is inconsistent with ambient ` +
            `HERDR_SESSION ${envSession} (${sessionSocket})`,
        );
      }
    }
    return { socketPath: envSocket, source: "env", session: envSession ?? null };
  }

  if (envSession) {
    return {
      socketPath: socketPathForSession(envSession),
      source: "env",
      session: envSession,
    };
  }

  if (options.mutation) {
    throw new TargetResolutionError(
      "target_required",
      "mutating operations require an explicit target: pass --socket/--session or run " +
        "inside a herdr context that exports HERDR_SOCKET_PATH/HERDR_SESSION",
    );
  }
  return { socketPath: defaultSocketPath(), source: "default", session: null };
}

/**
 * Resolve which herdr socket to talk to. Kept for callers that only need
 * the path; prefer `resolveTarget` when the source/session matters.
 */
export function resolveSocketPath(options: ResolveTargetOptions = {}): string {
  return resolveTarget(options).socketPath;
}

/**
 * Session discriminator for cross-plugin state namespacing: hostname plus
 * the canonical (symlink-resolved) socket path the command will talk to.
 * Socket path is the only session identity the socket API exposes;
 * canonicalization keeps `/var` vs `/private/var` spellings of the same
 * socket identical. Shared by plugins that namespace per-session state
 * (inbox organize marks, projects run records — #66).
 */
export function sessionKeyFor(options: {
  session?: string | undefined;
  socketPath?: string | undefined;
  mutation?: boolean | undefined;
}): string {
  const socketPath = resolveTarget({
    session: options.session,
    socketPath: options.socketPath,
    mutation: options.mutation,
  }).socketPath;
  let canonical = socketPath;
  try {
    canonical = realpathSync(socketPath);
  } catch {
    canonical = path.resolve(socketPath);
  }
  return `${os.hostname()} ${canonical}`;
}

/** herdr config dir: $XDG_CONFIG_HOME/herdr or ~/.config/herdr (win32: %APPDATA%\herdr etc.). */
export function herdrConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "herdr");
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, "herdr");
    const profile = process.env.USERPROFILE;
    if (profile) return path.join(profile, "AppData", "Roaming", "herdr");
  }
  const home = process.env.HOME;
  if (home) return path.join(home, ".config", "herdr");
  return path.join(process.env.TMPDIR ?? "/tmp", "herdr");
}

/** herdr state dir: $XDG_STATE_HOME/herdr or ~/.local/state/herdr (win32: %LOCALAPPDATA%\herdr). */
export function herdrStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, "herdr");
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return path.join(localAppData, "herdr");
    const profile = process.env.USERPROFILE;
    if (profile) return path.join(profile, "AppData", "Local", "herdr");
  }
  const home = process.env.HOME;
  if (home) return path.join(home, ".local", "state", "herdr");
  return path.join(process.env.TMPDIR ?? "/tmp", "herdr-state");
}

/**
 * Plugin config/state directories for external (non-plugin) clients.
 * Mirrors `herdr plugin config-dir` / the plugin state dir layout.
 * Explicit options win; `HERDR_PLUGIN_CONFIG_DIR` / `HERDR_PLUGIN_STATE_DIR`
 * (plugin runtime environment) come next; derived platform dirs last.
 */
export function pluginDirs(
  pluginId: string,
  options: { configDir?: string; stateDir?: string } = {},
): { configDir: string; stateDir: string } {
  const component = pluginPathComponent(pluginId);
  // Explicit options win over the ambient plugin-runtime env, mirroring the
  // socket-target precedence (explicit > ambient > derived default).
  const configDir =
    options.configDir ??
    process.env.HERDR_PLUGIN_CONFIG_DIR ??
    path.join(herdrConfigDir(), "plugins", "config", component);
  const stateDir =
    options.stateDir ??
    process.env.HERDR_PLUGIN_STATE_DIR ??
    path.join(herdrStateDir(), "plugins", component);
  return { configDir, stateDir };
}

/**
 * Ambient pane/workspace/tab identity exported by herdr into agent panes
 * (`HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`) and plugin
 * invocations (`HERDR_PLUGIN_CONTEXT_JSON`). Values that disagree between
 * the env vars and the context JSON — or that do not match the pane found
 * in the resolved target session — fail closed.
 */
export interface AmbientIdentity {
  paneId?: string | undefined;
  workspaceId?: string | undefined;
  tabId?: string | undefined;
}

interface PluginContextIdentity {
  focused_pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
}

function pluginContextIdentity(): PluginContextIdentity {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PluginContextIdentity;
  } catch {
    return {};
  }
}

/**
 * Read the ambient identity bundle. Explicit env vars win over the plugin
 * context JSON for each field; a pane id present in both with different
 * values is a contradiction and throws `ambient_identity_mismatch`.
 */
export function ambientIdentity(): AmbientIdentity {
  const context = pluginContextIdentity();
  const envPane = nonEmpty(process.env.HERDR_PANE_ID);
  const ctxPane = nonEmpty(context.focused_pane_id);
  if (envPane && ctxPane && envPane !== ctxPane) {
    throw new TargetResolutionError(
      "ambient_identity_mismatch",
      `HERDR_PANE_ID ${envPane} conflicts with ` +
        `HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id ${ctxPane}`,
    );
  }
  return {
    paneId: envPane ?? ctxPane,
    workspaceId: nonEmpty(process.env.HERDR_WORKSPACE_ID) ?? nonEmpty(context.workspace_id),
    tabId: nonEmpty(process.env.HERDR_TAB_ID) ?? nonEmpty(context.tab_id),
  };
}

/**
 * Verify that ambient workspace/tab identity is consistent with the pane
 * resolved in the target session. Call only when the pane id itself came
 * from the ambient identity (an explicit positional pane id overrides the
 * ambient pane id and is verified by session membership alone). Snapshot
 * `PaneInfo` always carries `workspace_id`/`tab_id` on the wire; a missing
 * field cannot be verified and fails closed.
 */
export function assertAmbientPaneIdentity(
  pane: { pane_id: string; workspace_id?: string; tab_id?: string },
  identity: AmbientIdentity,
): void {
  const mismatches: string[] = [];
  if (identity.workspaceId !== undefined) {
    if (pane.workspace_id !== identity.workspaceId) {
      mismatches.push(
        `workspace_id ${JSON.stringify(pane.workspace_id ?? null)} != ambient ${JSON.stringify(identity.workspaceId)}`,
      );
    }
  }
  if (identity.tabId !== undefined) {
    if (pane.tab_id !== identity.tabId) {
      mismatches.push(
        `tab_id ${JSON.stringify(pane.tab_id ?? null)} != ambient ${JSON.stringify(identity.tabId)}`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new TargetResolutionError(
      "ambient_identity_mismatch",
      `ambient identity does not belong to resolved pane ${pane.pane_id} in the target ` +
        `session: ${mismatches.join("; ")}`,
    );
  }
}

/** Path-safe encoding of a plugin id, mirroring herdr's `plugin_config_path_component`. */
export function pluginPathComponent(value: string): string {
  let component = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      ch === "." ||
      ch === "_" ||
      ch === "-"
    ) {
      component += ch;
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        component += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  if (component === "") return "%plugin";
  if (component.endsWith(".")) {
    component = `${component.slice(0, -1)}%2E`;
  }
  if (hasWindowsReservedStem(component)) {
    component = `%${component}`;
  }
  if ([...component].length > PLUGIN_COMPONENT_MAX_CHARS) {
    const hash = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
    const prefix = [...component].slice(0, PLUGIN_COMPONENT_MAX_CHARS - hash.length - 1).join("");
    return `${prefix}-${hash}`;
  }
  return component;
}

const PLUGIN_COMPONENT_MAX_CHARS = 120;

/** Mirrors herdr's Windows reserved device-name guard for path components. */
function hasWindowsReservedStem(component: string): boolean {
  const stem = component.split(".")[0]?.toLowerCase() ?? "";
  if (["con", "prn", "aux", "nul"].includes(stem)) return true;
  return /^com[1-9]$/.test(stem) || /^lpt[1-9]$/.test(stem);
}
