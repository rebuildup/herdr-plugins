import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { herdrSocketEndpoint, testEnv } from "./helpers/test-env";

const CLI = path.join(import.meta.dir, "../plugins/mcp/src/cli.ts");
const REPO = path.resolve(import.meta.dir, "..");

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-mut-test-"));
  dirs.push(dir);
  return dir;
}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function clearPluginOverrides(): void {
  for (const key of [
    "HERDR_MCP_ROOT_CONTROLS",
    "HERDR_MCP_ROOT_HANDOFF",
    "HERDR_MCP_ROOT_PROJECTS",
    "HERDR_MCP_ROOT_GIT",
    "HERDR_MCP_ROOT_CONVERSATIONS",
    "HERDR_MCP_ROOT_USAGE",
  ]) {
    setEnv(key, undefined);
  }
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// --- Stateful fake herdr socket -------------------------------------------------

interface FakeCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeState {
  sessionName: string;
  workspaces: Array<Record<string, unknown>>;
  tabs: Array<Record<string, unknown>>;
  panes: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
}

function defaultState(): FakeState {
  return {
    sessionName: "mcp-mut-session",
    workspaces: [{ workspace_id: "ws-1", title: "main" }],
    tabs: [{ tab_id: "tab-1", workspace_id: "ws-1" }],
    panes: [
      { pane_id: "pane-1", workspace_id: "ws-1", tab_id: "tab-1", cwd: "/tmp/fake-repo" },
      // pane-2 is a plain shell pane (agent_start target).
      { pane_id: "pane-2", workspace_id: "ws-1", tab_id: "tab-1", cwd: "/tmp/fake-repo" },
    ],
    agents: [
      {
        pane_id: "pane-1",
        workspace_id: "ws-1",
        tab_id: "tab-1",
        agent: "claude",
        name: "claude-1",
        agent_status: "idle",
        state_change_seq: 7,
        agent_session: { source: "test", agent: "claude", kind: "id", value: "sess-1" },
        cwd: "/tmp/fake-repo",
      },
    ],
  };
}

function findAgent(state: FakeState, target: string): Record<string, unknown> | undefined {
  return state.agents.find((a) => a.pane_id === target || a.name === target);
}

async function fakeHerdr(state: FakeState = defaultState()): Promise<{
  socketPath: string;
  calls: FakeCall[];
  state: FakeState;
  close: () => Promise<void>;
}> {
  const calls: FakeCall[] = [];
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
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
        const method = message.method ?? "";
        const params = message.params ?? {};
        calls.push({ method, params });
        let result: unknown = {};
        let error: { code: string; message: string } | undefined;
        switch (method) {
          case "session.snapshot":
            result = {
              snapshot: {
                session: { name: state.sessionName },
                workspaces: state.workspaces,
                tabs: state.tabs,
                panes: state.panes,
                agents: state.agents,
              },
            };
            break;
          case "agent.list":
            result = { agents: state.agents };
            break;
          case "agent.get": {
            const target = params.target as string;
            const agent = findAgent(state, target);
            if (agent === undefined) {
              error = { code: "agent_not_found", message: `no agent for target: ${target}` };
            } else {
              result = { type: "agent_info", agent };
            }
            break;
          }
          case "agent.prompt": {
            const agent = findAgent(state, params.target as string);
            if (agent === undefined) {
              error = { code: "agent_not_found", message: "no agent" };
            } else if (agent.agent_status === "blocked") {
              error = { code: "agent_blocked", message: "agent is blocked" };
            } else {
              result = { type: "agent_prompted", target: params.target };
            }
            break;
          }
          case "agent.wait":
            result = {
              type: "agent_wait",
              target: params.target,
              status: Array.isArray(params.until) ? params.until[0] : "idle",
            };
            break;
          case "agent.send_keys":
            result = { type: "agent_send_keys", target: params.target, keys: params.keys };
            break;
          case "agent.start": {
            const paneId = params.pane_id as string;
            const pane = state.panes.find((p) => p.pane_id === paneId);
            if (pane === undefined) {
              error = { code: "agent_pane_not_found", message: `no pane: ${paneId}` };
            } else if (state.agents.some((a) => a.pane_id === paneId)) {
              error = { code: "agent_pane_busy", message: `pane busy: ${paneId}` };
            } else {
              const agent = {
                pane_id: paneId,
                workspace_id: pane.workspace_id,
                tab_id: pane.tab_id,
                agent: params.kind,
                name: params.name,
                agent_status: "idle",
                state_change_seq: 1,
                agent_session: null,
                interactive_ready: true,
              };
              state.agents.push(agent);
              result = {
                type: "agent_started",
                agent,
                argv: [params.kind, ...((params.args as string[] | undefined) ?? [])],
              };
            }
            break;
          }
          case "workspace.create": {
            const workspace = {
              workspace_id: `ws-${state.workspaces.length + 1}`,
              title: (params.label as string | undefined) ?? `ws-${state.workspaces.length + 1}`,
            };
            const tab = {
              tab_id: `tab-${state.tabs.length + 1}`,
              workspace_id: workspace.workspace_id,
            };
            const rootPane = {
              pane_id: `pane-${state.panes.length + 1}`,
              workspace_id: workspace.workspace_id,
              tab_id: tab.tab_id,
              cwd: params.cwd ?? null,
            };
            state.workspaces.push(workspace);
            state.tabs.push(tab);
            state.panes.push(rootPane);
            result = { type: "workspace_created", workspace, tab, root_pane: rootPane };
            break;
          }
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
    calls,
    state,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

// --- Fake sibling plugin CLI -----------------------------------------------------

/**
 * Minimal fake plugin root: echoes the CLI argv as JSON. When env
 * `MCP_FAKE_PLUGIN_FAIL_KIND` is set it exits 1 with that error kind on
 * stderr (contract error envelope), for child-error mapping tests.
 */
function fakePluginRoot(pluginId: string, contract: string): string {
  const root = tempDir();
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "herdr-plugin.toml"),
    `id = "${pluginId}"\nname = "Fake"\nversion = "0.0.0"\n`,
  );
  writeFileSync(
    path.join(root, "src", "cli.ts"),
    `const failKind = process.env.MCP_FAKE_PLUGIN_FAIL_KIND;
if (failKind) {
  process.stderr.write(JSON.stringify({contract:"${contract}",ok:false,error:{code:"error",message:"fake failure",kind:failKind}}) + "\\n");
  process.exit(1);
}
const args = process.argv.slice(2);
console.log(JSON.stringify({contract:"${contract}",command:args[0]??null,args,ok:true}));
`,
  );
  return root;
}

// --- MCP stdio client ---------------------------------------------------------------

interface RpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface StdinSink {
  write(data: string): void;
  end(): void;
}

function serveClient(
  args: string[],
  env: Record<string, string> = {},
): {
  proc: Subprocess;
  stdin: StdinSink;
  request: (method: string, params?: unknown, id?: number) => Promise<RpcResponse>;
  close: () => Promise<void>;
} {
  const proc = Bun.spawn(["bun", "run", CLI, "serve", ...args], {
    cwd: REPO,
    env: testEnv(env, { keepEnvPrefixes: ["HERDR_MCP_ROOT_"] }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdin = proc.stdin as unknown as StdinSink;
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
          /* non-JSON stdout would be a protocol violation */
        }
      }
    }
  })();
  return {
    proc,
    stdin,
    request(method, params, id) {
      const requestId = id ?? nextId++;
      const promise = new Promise<RpcResponse>((resolvePromise) => {
        waiters.set(requestId, resolvePromise);
      });
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      return promise;
    },
    async close() {
      stdin.end();
      await proc.exited;
    },
  };
}

interface ToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function toolPayload(response: RpcResponse): ToolCallResult {
  expect(response.error).toBeUndefined();
  return response.result as unknown as ToolCallResult;
}

interface ToolDoc {
  ok: boolean;
  tool?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function docOf(res: ToolCallResult): ToolDoc {
  return res.structuredContent as unknown as ToolDoc;
}

async function callTool(
  client: ReturnType<typeof serveClient>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolDoc> {
  const res = toolPayload(await client.request("tools/call", { name, arguments: args }));
  return docOf(res);
}

// --- Tests -------------------------------------------------------------------------

describe("rebuildup.mcp mutation surface (T3, #139)", () => {
  test("read-only server refuses every mutation tool with capability_denied", async () => {
    clearPluginOverrides();
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath]); // default read-only
    try {
      for (const [name, args] of [
        ["agent_prompt", { target: "pane-1", text: "hi" }],
        ["agent_interrupt", { target: "pane-1" }],
        ["agent_start", { pane_id: "pane-2", agent: "claude" }],
        ["workspace_create", {}],
        ["handoff_invoke", { operation: "execute", id: "ho-1" }],
      ] as Array<[string, Record<string, unknown>]>) {
        const doc = await callTool(client, name, args);
        expect(doc.ok).toBe(false);
        expect(doc.error?.code).toBe("capability_denied");
        expect(doc.error?.details?.negotiated).toBe("read-only");
      }
      // No mutation reached the socket.
      expect(fake.calls.filter((c) => c.method !== "session.snapshot")).toHaveLength(0);
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test("agent_prompt → controls send: identity echo, wait flags, effects", async () => {
    clearPluginOverrides(); // real sibling rebuildup.controls
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      const doc = await callTool(client, "agent_prompt", {
        target: "pane-1",
        text: "run the tests",
        wait_until: ["idle"],
        timeout_ms: 5000,
        expect_state_seq: 7,
        expect_pane: "pane-1",
      });
      expect(doc.ok).toBe(true);
      const result = doc.result as {
        identity: Record<string, unknown>;
        effects: Array<{ surface: string; method: string }>;
        plugin: string;
      };
      expect(result.identity.pane_id).toBe("pane-1");
      expect(result.identity.workspace_id).toBe("ws-1");
      expect(result.identity.agent_session).toEqual({
        agent: "claude",
        kind: "id",
        value: "sess-1",
      });
      expect(result.plugin).toBe("rebuildup.controls");
      expect(result.effects[0]?.surface).toBe("rebuildup.controls");
      expect(result.effects[0]?.method).toContain("send");
      // The mutation actually reached herdr through agent.prompt.
      const prompt = fake.calls.find((c) => c.method === "agent.prompt");
      expect(prompt).toBeDefined();
      expect(prompt?.params.text).toBe("run the tests");
      expect(prompt?.params.target).toBe("pane-1");
      expect(((prompt?.params.wait ?? {}) as { until?: string[] }).until).toEqual(["idle"]);
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test("stale generation / reused pane refuse before any side effect", async () => {
    clearPluginOverrides();
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      // expect_state_seq mismatch → stale_generation, agent.prompt never sent.
      const stale = await callTool(client, "agent_prompt", {
        target: "pane-1",
        text: "hi",
        expect_state_seq: 999,
      });
      expect(stale.ok).toBe(false);
      expect(stale.error?.code).toBe("stale_generation");
      expect(fake.calls.some((c) => c.method === "agent.prompt")).toBe(false);

      // Reused pane id: agent.get resolves an agent whose pane is absent
      // from the live snapshot → not_found, still no side effect.
      const state = fake.state;
      state.agents.push({
        pane_id: "pane-reused",
        workspace_id: "ws-1",
        tab_id: "tab-1",
        agent: "claude",
        name: "claude-ghost",
        agent_status: "idle",
        state_change_seq: 3,
        agent_session: null,
      });
      const reused = await callTool(client, "agent_prompt", {
        target: "claude-ghost",
        text: "hi",
      });
      expect(reused.ok).toBe(false);
      expect(reused.error?.code).toBe("not_found");
      expect(fake.calls.some((c) => c.method === "agent.prompt")).toBe(false);

      // Unknown target → not_found.
      const missing = await callTool(client, "agent_interrupt", { target: "nope" });
      expect(missing.ok).toBe(false);
      expect(missing.error?.code).toBe("not_found");
      expect(fake.calls.some((c) => c.method === "agent.send_keys")).toBe(false);
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test("agent_wait runs at read-only and maps until/timeout", async () => {
    clearPluginOverrides();
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath]); // read-only
    try {
      const doc = await callTool(client, "agent_wait", {
        target: "pane-1",
        until: ["done", "blocked"],
        timeout_ms: 1000,
      });
      expect(doc.ok).toBe(true);
      const wait = fake.calls.find((c) => c.method === "agent.wait");
      expect(wait).toBeDefined();
      expect(wait?.params.until).toEqual(["done", "blocked"]);
      expect(wait?.params.timeout_ms).toBe(1000);
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test("agent_interrupt injects PTY keys and echoes pty_level effect", async () => {
    clearPluginOverrides();
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      const doc = await callTool(client, "agent_interrupt", {
        target: "pane-1",
        keys: ["ctrl+c"],
      });
      expect(doc.ok).toBe(true);
      const keys = fake.calls.find((c) => c.method === "agent.send_keys");
      expect(keys?.params.keys).toEqual(["ctrl+c"]);
      const effects = (doc.result as { effects: Array<Record<string, unknown>> }).effects;
      const detail = effects[0]?.detail as Record<string, unknown> | undefined;
      expect(detail?.pty_level).toBe(true);
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test("agent_start caps provider permission mode at the access level", async () => {
    clearPluginOverrides();
    const fake = await fakeHerdr();
    const supervised = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      // No explicit mode → supervised cap is pinned explicitly.
      const capped = await callTool(supervised, "agent_start", {
        pane_id: "pane-2",
        agent: "claude",
        name: "claude-t3",
      });
      expect(capped.ok).toBe(true);
      const startCall = fake.calls.find((c) => c.method === "agent.start");
      const args = (startCall?.params.args as string[]) ?? [];
      // claude supervised mapping → --permission-mode manual (ADR-0018).
      expect(args).toContain("--permission-mode");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("manual");
      const ident = (capped.result as { identity: Record<string, unknown> }).identity;
      expect(ident.pane_id).toBe("pane-2");
      expect(ident.agent).toBe("claude");

      // pane-2 now runs an agent → a second start is refused upstream
      // (agent_pane_busy), never reported as success.
      const busy = await callTool(supervised, "agent_start", {
        pane_id: "pane-2",
        agent: "claude",
        name: "claude-t3b",
      });
      expect(busy.ok).toBe(false);
    } finally {
      await supervised.close();
      await fake.close();
    }
  });

  test("agent_start refuses over-cap permission_mode with capability_denied", async () => {
    clearPluginOverrides();
    const fake = await fakeHerdr();
    const supervised = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    const full = serveClient(["--socket", fake.socketPath, "--access-level", "full"]);
    try {
      const denied = await callTool(supervised, "agent_start", {
        pane_id: "pane-2",
        agent: "claude",
        permission_mode: "full-access",
      });
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe("capability_denied");
      expect(denied.error?.details?.cap).toBe("supervised");
      expect(fake.calls.some((c) => c.method === "agent.start")).toBe(false);

      // full access passes the mode through to the controls launch table.
      const allowed = await callTool(full, "agent_start", {
        pane_id: "pane-2",
        agent: "claude",
        name: "claude-full",
        permission_mode: "full-access",
      });
      expect(allowed.ok).toBe(true);
      const startCall = fake.calls.filter((c) => c.method === "agent.start").at(-1);
      const args = (startCall?.params.args as string[]) ?? [];
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    } finally {
      await supervised.close();
      await full.close();
      await fake.close();
    }
  });

  test("agent_start on a missing pane is not_found before launch", async () => {
    clearPluginOverrides();
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      const doc = await callTool(client, "agent_start", {
        pane_id: "pane-missing",
        agent: "claude",
      });
      expect(doc.ok).toBe(false);
      expect(doc.error?.code).toBe("not_found");
      expect(fake.calls.some((c) => c.method === "agent.start")).toBe(false);
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test("workspace_create echoes created surface identity + herdr effect", async () => {
    clearPluginOverrides();
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      const doc = await callTool(client, "workspace_create", {
        label: "mcp-ws",
        cwd: "/tmp/fake-repo",
      });
      expect(doc.ok).toBe(true);
      const result = doc.result as {
        created: { workspace: { workspace_id: string } };
        identity: Record<string, unknown>;
        effects: Array<{ surface: string; method: string }>;
      };
      expect(result.created.workspace.workspace_id).toBe("ws-2");
      expect(result.identity.workspace_id).toBe("ws-2");
      expect(result.identity.pane_id).toBe("pane-3");
      expect(result.effects[0]?.surface).toBe("herdr");
      expect(result.effects[0]?.method).toBe("workspace.create");
      const call = fake.calls.find((c) => c.method === "workspace.create");
      expect(call?.params.label).toBe("mcp-ws");
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test("handoff_invoke maps operations onto the handoff CLI contract", async () => {
    clearPluginOverrides();
    setEnv(
      "HERDR_MCP_ROOT_HANDOFF",
      fakePluginRoot("rebuildup.handoff", "herdr-plugins.handoff/v1"),
    );
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      const exec = await callTool(client, "handoff_invoke", {
        operation: "execute",
        id: "ho-1",
        target_pane: "pane-1",
        new_workspace: true,
        wait_ms: 250,
        dry_run: true,
      });
      expect(exec.ok).toBe(true);
      const execArgs = (exec.result as { result: { args: string[] } }).result.args;
      expect(execArgs.slice(0, 2)).toEqual(["execute", "ho-1"]);
      expect(execArgs).toContain("--target-pane");
      expect(execArgs).toContain("--new-workspace");
      expect(execArgs).toContain("--dry-run");
      expect(execArgs[execArgs.indexOf("--wait-ms") + 1]).toBe("250");
      // --remote is never exposed in v1.
      expect(execArgs).not.toContain("--remote");
      const execIdent = (exec.result as { identity: Record<string, unknown> }).identity;
      expect(execIdent.herdr_session).toBe("mcp-mut-session");

      const del = await callTool(client, "handoff_invoke", {
        operation: "delegate",
        id: "ho-parent",
        task: "review the diff",
        strategy: "portable_context",
        provider: "claude",
        requirement: ["req-a", "req-b"],
        no_execute: true,
      });
      expect(del.ok).toBe(true);
      const delArgs = (del.result as { result: { args: string[] } }).result.args;
      expect(delArgs.slice(0, 2)).toEqual(["delegate", "ho-parent"]);
      expect(delArgs[delArgs.indexOf("--task") + 1]).toBe("review the diff");
      expect(delArgs.filter((a) => a === "--requirement")).toHaveLength(2);
      expect(delArgs).toContain("--no-execute");

      const merge = await callTool(client, "handoff_invoke", {
        operation: "merge-back",
        id: "ho-child",
      });
      expect(merge.ok).toBe(true);
      const mergeArgs = (merge.result as { result: { args: string[] } }).result.args;
      expect(mergeArgs.slice(0, 2)).toEqual(["merge-back", "ho-child"]);
    } finally {
      await client.close();
      await fake.close();
      setEnv("HERDR_MCP_ROOT_HANDOFF", undefined);
    }
  });

  test("handoff_invoke rejects args outside the operation surface", async () => {
    clearPluginOverrides();
    setEnv(
      "HERDR_MCP_ROOT_HANDOFF",
      fakePluginRoot("rebuildup.handoff", "herdr-plugins.handoff/v1"),
    );
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      // `task` is delegate/merge-back only.
      const bad = await callTool(client, "handoff_invoke", {
        operation: "execute",
        id: "ho-1",
        task: "nope",
      });
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe("invalid_params");

      // worktree_branch requires worktree: true.
      const wt = await callTool(client, "handoff_invoke", {
        operation: "execute",
        id: "ho-1",
        worktree_branch: "b1",
      });
      expect(wt.ok).toBe(false);
      expect(wt.error?.code).toBe("invalid_params");
    } finally {
      await client.close();
      await fake.close();
      setEnv("HERDR_MCP_ROOT_HANDOFF", undefined);
    }
  });

  test("sibling plugin failure kinds map onto contract error codes", async () => {
    clearPluginOverrides();
    setEnv(
      "HERDR_MCP_ROOT_CONTROLS",
      fakePluginRoot("rebuildup.controls", "herdr-plugins.controls/v1"),
    );
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"], {
      MCP_FAKE_PLUGIN_FAIL_KIND: "requires_interactive_input",
    });
    try {
      const blocked = await callTool(client, "agent_prompt", {
        target: "pane-1",
        text: "hi",
      });
      expect(blocked.ok).toBe(false);
      // Blocked-agent refusal is herdr's missing dialog API → upstream_gap,
      // with the precise sibling kind preserved in details.
      expect(blocked.error?.code).toBe("upstream_gap");
      expect(blocked.error?.details?.plugin_kind).toBe("requires_interactive_input");
    } finally {
      await client.close();
      await fake.close();
      setEnv("HERDR_MCP_ROOT_CONTROLS", undefined);
    }
  });

  test("missing controls plugin reports plugin_unavailable, not fabricated success", async () => {
    clearPluginOverrides();
    setEnv("HERDR_MCP_ROOT_CONTROLS", tempDir()); // no cli.ts inside
    const fake = await fakeHerdr();
    const client = serveClient(["--socket", fake.socketPath, "--access-level", "supervised"]);
    try {
      const doc = await callTool(client, "agent_prompt", { target: "pane-1", text: "hi" });
      expect(doc.ok).toBe(false);
      expect(doc.error?.code).toBe("plugin_unavailable");
      expect(doc.error?.details?.plugin).toBe("rebuildup.controls");
      expect(fake.calls.some((c) => c.method === "agent.prompt")).toBe(false);
    } finally {
      await client.close();
      await fake.close();
      setEnv("HERDR_MCP_ROOT_CONTROLS", undefined);
    }
  });
});
