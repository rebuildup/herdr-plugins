import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { herdrSocketEndpoint, testEnv } from "./helpers/test-env";

const CLI = path.join(import.meta.dir, "../plugins/mcp/src/cli.ts");

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-events-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Fake herdr socket with events.subscribe support ----------------------------

interface FakeAgent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string;
  agent_status: string;
  state_change_seq: number;
  agent_session: { source: string; agent: string; kind: string; value: string } | null;
}

const AGENT_1: FakeAgent = {
  pane_id: "pane-1",
  workspace_id: "ws-1",
  tab_id: "tab-1",
  agent: "claude",
  agent_status: "idle",
  state_change_seq: 7,
  agent_session: { source: "test", agent: "claude", kind: "id", value: "sess-1" },
};

interface SubConn {
  id: string;
  subscriptions: Array<Record<string, unknown>>;
  conn: net.Socket;
}

interface FakeHerdr {
  socketPath: string;
  /** All live events.subscribe connections (reconnects append). */
  subs: SubConn[];
  /** Push an event envelope to every live subscription conn. */
  push: (event: string, data: unknown) => void;
  /** Destroy every live subscription conn (simulates socket drop). */
  dropAll: () => void;
  /** Send an error frame addressed to each live subscription id, then keep conn. */
  sendSubscriptionError: (code: string, message: string) => void;
  close: () => Promise<void>;
}

async function fakeHerdr(): Promise<FakeHerdr> {
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
  const subs: SubConn[] = [];
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.method === "events.subscribe") {
          const params = message.params ?? {};
          subs.push({
            id: message.id ?? "",
            subscriptions: (params.subscriptions ?? []) as Array<Record<string, unknown>>,
            conn,
          });
          conn.write(`${JSON.stringify({ id: message.id, result: { started: true } })}\n`);
          continue;
        }
        let result: unknown = {};
        let error: { code: string; message: string } | undefined;
        switch (message.method) {
          case "session.snapshot":
            result = {
              snapshot: {
                session: { name: "mcp-events-test" },
                workspaces: [
                  { workspace_id: "ws-1", title: "main" },
                  { workspace_id: "ws-2", title: "side" },
                ],
                tabs: [
                  { tab_id: "tab-1", workspace_id: "ws-1" },
                  { tab_id: "tab-2", workspace_id: "ws-2" },
                ],
                panes: [
                  { pane_id: "pane-1", workspace_id: "ws-1", tab_id: "tab-1" },
                  { pane_id: "pane-2", workspace_id: "ws-2", tab_id: "tab-2" },
                ],
                agents: [AGENT_1],
              },
            };
            break;
          case "agent.list":
            result = { agents: [AGENT_1] };
            break;
          default:
            result = {};
        }
        conn.write(
          `${JSON.stringify(error ? { id: message.id, error } : { id: message.id, result })}\n`,
        );
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(herdrSocketEndpoint(socketPath), () => resolveListen());
  });
  return {
    socketPath,
    subs,
    push(event, data) {
      const line = `${JSON.stringify({ event, data })}\n`;
      for (const sub of subs) {
        if (!sub.conn.destroyed) sub.conn.write(line);
      }
    },
    dropAll() {
      for (const sub of subs) {
        if (!sub.conn.destroyed) sub.conn.destroy();
      }
    },
    sendSubscriptionError(code, message) {
      const line = `${JSON.stringify({ id: subs[subs.length - 1]?.id, error: { code, message } })}\n`;
      for (const sub of subs) {
        if (!sub.conn.destroyed) sub.conn.write(line);
      }
    },
    close: () =>
      new Promise((resolveClose) => {
        for (const sub of subs) sub.conn.destroy();
        server.close(() => resolveClose());
      }),
  };
}

// --- MCP stdio client ------------------------------------------------------------

interface RpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  isError?: boolean;
  structuredContent?: {
    ok?: boolean;
    tool?: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

function serveClient(socketPath: string): {
  request: (method: string, params?: unknown) => Promise<RpcResponse>;
  tool: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  close: () => Promise<void>;
} {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "serve", "--socket", socketPath, "--access-level", "read-only"],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: testEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdin = proc.stdin as unknown as { write(d: string): void; end(): void };
  let buffer = "";
  const waiters = new Map<number | string, (res: RpcResponse) => void>();
  let nextId = 1;
  void (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const message = JSON.parse(line) as RpcResponse;
          const waiter = waiters.get(message.id ?? -1);
          if (waiter) {
            waiters.delete(message.id ?? -1);
            waiter(message);
          }
        } catch {
          /* ignore */
        }
      }
    }
  })();
  const request = (method: string, params?: unknown) => {
    const requestId = nextId++;
    const promise = new Promise<RpcResponse>((resolvePromise) => {
      waiters.set(requestId, resolvePromise);
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    return promise;
  };
  void request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-events-test", version: "0" },
  }).then(() =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`),
  );
  return {
    request,
    async tool(name, args = {}) {
      const response = await request("tools/call", { name, arguments: args });
      expect(response.error).toBeUndefined();
      return response.result as unknown as ToolCallResult;
    },
    async close() {
      stdin.end();
      await proc.exited;
    },
  };
}

function ok(tool: ToolCallResult): Record<string, unknown> {
  expect(tool.isError).toBeUndefined();
  const content = tool.structuredContent;
  expect(content?.ok).toBe(true);
  return (content?.result ?? {}) as Record<string, unknown>;
}

function err(tool: ToolCallResult): { code: string; message: string } {
  expect(tool.isError).toBe(true);
  const error = tool.structuredContent?.error;
  expect(error).toBeDefined();
  return error as { code: string; message: string };
}

interface PollResult {
  subscription_id: string;
  status: string;
  next_cursor: number;
  events: Array<{ seq: number; event: string; data: unknown; at: string }>;
  notices: Array<{
    seq: number;
    notice: string;
    reason: string;
    detail?: Record<string, unknown>;
  }>;
  reconnects: number;
  timed_out?: boolean;
}

// --- Tests -----------------------------------------------------------------------

describe("rebuildup.mcp events surface (T4, #140)", () => {
  test("events_subscribe expands pane-parameterized types and returns baseline", async () => {
    const herdr = await fakeHerdr();
    const client = serveClient(herdr.socketPath);
    try {
      const result = ok(
        await client.tool("events_subscribe", { types: ["pane.agent_status_changed"] }),
      );
      expect(result.id).toMatch(/^sub-/);
      expect(result.status).toBe("live");
      expect(result.types).toEqual(["pane.agent_status_changed"]);
      // No pane filter → expanded across both fake panes.
      expect(result.pane_ids).toEqual(["pane-1", "pane-2"]);
      expect(result.upstream_subscriptions).toBe(2);
      const baseline = result.baseline as { panes: Array<{ pane_id: string }> };
      expect(baseline.panes.map((p) => p.pane_id).sort()).toEqual(["pane-1", "pane-2"]);
      // Upstream saw one parameterized subscription per pane.
      expect(herdr.subs).toHaveLength(1);
      expect(herdr.subs[0]?.subscriptions).toEqual([
        { type: "pane.agent_status_changed", pane_id: "pane-1" },
        { type: "pane.agent_status_changed", pane_id: "pane-2" },
      ]);
      const unsub = ok(
        await client.tool("events_unsubscribe", {
          subscription_id: result.id as string,
        }),
      );
      expect(unsub.closed).toBe(true);
    } finally {
      await client.close();
      await herdr.close();
    }
  });

  test("pane_id/workspace_id/agent_status filters narrow delivery", async () => {
    const herdr = await fakeHerdr();
    const client = serveClient(herdr.socketPath);
    try {
      const paneSub = ok(
        await client.tool("events_subscribe", {
          types: ["pane.agent_status_changed"],
          pane_id: "pane-1",
        }),
      );
      const paneId = paneSub.id as string;
      expect(herdr.subs.at(-1)?.subscriptions).toEqual([
        { type: "pane.agent_status_changed", pane_id: "pane-1" },
      ]);

      herdr.push("pane_agent_status_changed", {
        pane_id: "pane-1",
        workspace_id: "ws-1",
        agent_status: "working",
        agent: "claude",
      });
      herdr.push("pane_agent_status_changed", {
        pane_id: "pane-2",
        workspace_id: "ws-2",
        agent_status: "working",
        agent: "codex",
      });
      await sleep(50);
      const polled = ok(
        await client.tool("events_poll", { subscription_id: paneId }),
      ) as unknown as PollResult;
      expect(polled.events).toHaveLength(1);
      expect(polled.events[0]?.event).toBe("pane.agent_status_changed");
      expect((polled.events[0]?.data as { pane_id: string }).pane_id).toBe("pane-1");

      // workspace_id filter: pane-2 lives in ws-2.
      const wsSub = ok(
        await client.tool("events_subscribe", {
          types: ["pane.agent_status_changed"],
          workspace_id: "ws-2",
        }),
      );
      expect(wsSub.pane_ids).toEqual(["pane-2"]);

      // agent_status filter is forwarded upstream AND applied client-side.
      const statusSub = ok(
        await client.tool("events_subscribe", {
          types: ["pane.agent_status_changed"],
          pane_id: "pane-1",
          agent_status: "done",
        }),
      );
      expect(herdr.subs.at(-1)?.subscriptions).toEqual([
        { type: "pane.agent_status_changed", pane_id: "pane-1", agent_status: "done" },
      ]);
      herdr.push("pane_agent_status_changed", {
        pane_id: "pane-1",
        workspace_id: "ws-1",
        agent_status: "working",
      });
      herdr.push("pane_agent_status_changed", {
        pane_id: "pane-1",
        workspace_id: "ws-1",
        agent_status: "done",
      });
      await sleep(50);
      const statusPolled = ok(
        await client.tool("events_poll", { subscription_id: statusSub.id as string }),
      ) as unknown as PollResult;
      expect(statusPolled.events).toHaveLength(1);
      expect((statusPolled.events[0]?.data as { agent_status: string }).agent_status).toBe("done");

      for (const id of [paneId, wsSub.id as string, statusSub.id as string]) {
        await client.tool("events_unsubscribe", { subscription_id: id });
      }
    } finally {
      await client.close();
      await herdr.close();
    }
  });

  test("lifecycle types pass through unexpanded and normalize snake_case wire names", async () => {
    const herdr = await fakeHerdr();
    const client = serveClient(herdr.socketPath);
    try {
      const result = ok(
        await client.tool("events_subscribe", {
          types: ["workspace.created", "pane.closed", "layout.updated"],
        }),
      );
      // Lifecycle types need no pane resolution.
      expect(result.pane_ids).toEqual([]);
      expect(result.upstream_subscriptions).toBe(3);
      expect(herdr.subs.at(-1)?.subscriptions).toEqual([
        { type: "workspace.created" },
        { type: "pane.closed" },
        { type: "layout.updated" },
      ]);
      herdr.push("workspace_created", { workspace_id: "ws-9", title: "new" });
      herdr.push("pane_closed", { pane_id: "pane-9", workspace_id: "ws-1" });
      await sleep(50);
      const polled = ok(
        await client.tool("events_poll", { subscription_id: result.id as string }),
      ) as unknown as PollResult;
      expect(polled.events.map((e) => e.event)).toEqual(["workspace.created", "pane.closed"]);
      await client.tool("events_unsubscribe", { subscription_id: result.id as string });
    } finally {
      await client.close();
      await herdr.close();
    }
  });

  test("events_wait blocks for a matching event and reports timed_out", async () => {
    const herdr = await fakeHerdr();
    const client = serveClient(herdr.socketPath);
    try {
      const sub = ok(
        await client.tool("events_subscribe", {
          types: ["pane.agent_status_changed"],
          pane_id: "pane-1",
        }),
      );
      const id = sub.id as string;
      const waited = ok(
        await client.tool("events_wait", {
          subscription_id: id,
          timeout_ms: 1500,
          types: ["pane.agent_status_changed"],
        }),
      ) as unknown as PollResult;
      // Nothing pushed yet — this call should have blocked ~5s then timed out.
      expect(waited.timed_out).toBe(true);
      expect(waited.events).toHaveLength(0);

      // Fire the wait first, then push — proves blocking delivery.
      const pending = client.tool("events_wait", {
        subscription_id: id,
        timeout_ms: 3000,
      });
      await sleep(100);
      herdr.push("pane_agent_status_changed", {
        pane_id: "pane-1",
        workspace_id: "ws-1",
        agent_status: "working",
      });
      const got = ok(await pending) as unknown as PollResult;
      expect(got.timed_out).toBe(false);
      expect(got.events).toHaveLength(1);
      await client.tool("events_unsubscribe", { subscription_id: id });
    } finally {
      await client.close();
      await herdr.close();
    }
  });

  test("socket drop produces gap notice then resync with baseline on reconnect", async () => {
    const herdr = await fakeHerdr();
    const client = serveClient(herdr.socketPath);
    try {
      const sub = ok(
        await client.tool("events_subscribe", {
          types: ["pane.agent_status_changed"],
          pane_id: "pane-1",
        }),
      );
      const id = sub.id as string;
      herdr.dropAll();
      // Hub reconnect backoff base is 500ms; allow margin.
      await sleep(1600);
      const polled = ok(
        await client.tool("events_poll", { subscription_id: id }),
      ) as unknown as PollResult;
      expect(polled.status).toBe("live");
      expect(polled.reconnects).toBe(1);
      const notices = polled.notices;
      expect(notices.length).toBeGreaterThanOrEqual(2);
      expect(notices[0]?.notice).toBe("gap");
      expect(["stream_closed", "events_lost", "socket_unreachable"]).toContain(
        notices[0]?.reason ?? "",
      );
      const resync = notices.find((n) => n.notice === "resync");
      expect(resync).toBeDefined();
      expect(resync?.reason).toBe("reconnect");
      const baseline = (resync?.detail as { baseline?: { panes?: unknown[] } })?.baseline;
      expect(baseline?.panes).toBeDefined();
      // A second subscription conn was opened upstream.
      expect(herdr.subs.length).toBeGreaterThanOrEqual(2);
      // Cursor semantics: polling with next_cursor returns nothing new.
      const again = ok(
        await client.tool("events_poll", {
          subscription_id: id,
          cursor: polled.next_cursor,
        }),
      ) as unknown as PollResult;
      expect(again.events).toHaveLength(0);
      expect(again.notices).toHaveLength(0);
      await client.tool("events_unsubscribe", { subscription_id: id });
    } finally {
      await client.close();
      await herdr.close();
    }
  });

  test("upstream events_lost error frame maps to gap reason events_lost", async () => {
    const herdr = await fakeHerdr();
    const client = serveClient(herdr.socketPath);
    try {
      const sub = ok(
        await client.tool("events_subscribe", {
          types: ["pane.agent_status_changed"],
          pane_id: "pane-1",
        }),
      );
      const id = sub.id as string;
      herdr.sendSubscriptionError("events_lost", "event subscription fell behind");
      await sleep(1600);
      const polled = ok(
        await client.tool("events_poll", { subscription_id: id }),
      ) as unknown as PollResult;
      const gap = polled.notices.find((n) => n.notice === "gap");
      expect(gap?.reason).toBe("events_lost");
      expect(polled.notices.some((n) => n.notice === "resync")).toBe(true);
      await client.tool("events_unsubscribe", { subscription_id: id });
    } finally {
      await client.close();
      await herdr.close();
    }
  });

  test("invalid params and unknown ids fail honestly", async () => {
    const herdr = await fakeHerdr();
    const client = serveClient(herdr.socketPath);
    try {
      const badType = await client.tool("events_subscribe", {
        types: ["pane.output_changed"],
      });
      expect(err(badType).code).toBe("invalid_params");

      const missingMatch = await client.tool("events_subscribe", {
        types: ["pane.output_matched"],
        pane_id: "pane-1",
      });
      expect(err(missingMatch).code).toBe("invalid_params");

      const badPane = await client.tool("events_subscribe", {
        types: ["pane.agent_status_changed"],
        pane_id: "pane-nope",
      });
      expect(err(badPane).code).toBe("not_found");

      const badWs = await client.tool("events_subscribe", {
        types: ["pane.agent_status_changed"],
        workspace_id: "ws-nope",
      });
      expect(err(badWs).code).toBe("not_found");

      const unknown = await client.tool("events_poll", {
        subscription_id: "sub-nope",
      });
      expect(err(unknown).code).toBe("not_found");

      const unsub = await client.tool("events_unsubscribe", {
        subscription_id: "sub-nope",
      });
      expect(err(unsub).code).toBe("not_found");
    } finally {
      await client.close();
      await herdr.close();
    }
  });

  test("events_subscribe works at read-only access (observation only)", async () => {
    const herdr = await fakeHerdr();
    const client = serveClient(herdr.socketPath); // read-only by default
    try {
      const cap = ok(await client.tool("herdr_capability"));
      expect(cap.access_level).toBe("read-only");
      const surfaces = cap.surfaces as Record<string, string>;
      expect(surfaces.events).toBe("stable");
      const result = ok(await client.tool("events_subscribe", {}));
      expect(result.id).toMatch(/^sub-/);
      await client.tool("events_unsubscribe", { subscription_id: result.id as string });
    } finally {
      await client.close();
      await herdr.close();
    }
  });
});
