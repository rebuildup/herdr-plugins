/**
 * Minimal typed client for the herdr local socket API.
 *
 * Transport: newline-delimited JSON over a Unix domain socket, or a Windows
 * named pipe on win32 (`\\.\pipe\<socket path>`), matching herdr's own
 * integration assets. One request per line; the first response line with a
 * matching `id` resolves the request.
 */

import { createHash } from "node:crypto";
import net from "node:net";
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
  /**
   * Error frame addressed to this subscription, when the server sent one
   * (e.g. `events_lost` when the subscription fell behind retained
   * history, or a mid-stream rejection). Null until/unless observed.
   */
  readonly terminalError: HerdrError | null;
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
  let terminalError: HerdrError | null = null;

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
          // Error frame for this subscription — pre-ack this rejects
          // `started`; post-ack (e.g. upstream `events_lost`) it is
          // recorded on `terminalError` before the stream is ended.
          terminalError = message.error;
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
    get terminalError() {
      return terminalError;
    },
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
 * Resolve which herdr socket to talk to, mirroring herdr's own precedence:
 * explicit path/env override > named session > default session socket.
 */
export function resolveSocketPath(options: { session?: string | undefined } = {}): string {
  const explicit = process.env.HERDR_SOCKET_PATH;
  if (explicit) return explicit;
  const session = options.session ?? process.env.HERDR_SESSION;
  if (session) return sessionSocketPath(session);
  return defaultSocketPath();
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
 * `HERDR_PLUGIN_CONFIG_DIR` / `HERDR_PLUGIN_STATE_DIR` win when set
 * (plugin runtime environment).
 */
export function pluginDirs(
  pluginId: string,
  options: { configDir?: string; stateDir?: string } = {},
): { configDir: string; stateDir: string } {
  const component = pluginPathComponent(pluginId);
  const configDir =
    process.env.HERDR_PLUGIN_CONFIG_DIR ??
    options.configDir ??
    path.join(herdrConfigDir(), "plugins", "config", component);
  const stateDir =
    process.env.HERDR_PLUGIN_STATE_DIR ??
    options.stateDir ??
    path.join(herdrStateDir(), "plugins", component);
  return { configDir, stateDir };
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
