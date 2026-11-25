import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "../plugins/controls/src/cli.ts");
const DEAD_SOCKET = path.join(tmpdir(), "controls-dead-herdr.sock");

const dirs: string[] = [];
const savedSocket = process.env.HERDR_SOCKET_PATH;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "controls-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = savedSocket;
});

function baseEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { HERDR_SOCKET_PATH: DEAD_SOCKET };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key.startsWith("HERDR_") &&
      key !== "HERDR_PLUGIN_STATE_DIR" &&
      key !== "HERDR_PLUGIN_CONFIG_DIR"
    ) {
      continue;
    }
    env[key] = value;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

function parseOut(stdout: string, stderr: string, status: number): CliResult {
  let json: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  try {
    error = (JSON.parse(stderr) as { error?: Record<string, unknown> }).error ?? null;
  } catch {
    /* empty stderr */
  }
  return { status, stdout, stderr, json, error };
}

// Async spawn: the fake herdr socket lives in this process's event loop,
// so a blocking spawnSync would deadlock the agent.* requests.
function runCli(args: string[], extraEnv?: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: baseEnv(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(parseOut(stdout, stderr, code ?? -1)));
  });
}

// --- Fake herdr socket --------------------------------------------------------

interface FakeAgent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string;
  agent_status: string;
  state_change_seq: number;
  agent_session: { source: string; agent: string; kind: string; value: string } | null;
  interactive_ready: boolean;
  launch_pending: boolean;
}

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

const AGENT: FakeAgent = {
  pane_id: "pane-1",
  workspace_id: "ws-1",
  tab_id: "tab-1",
  agent: "claude",
  agent_status: "idle",
  state_change_seq: 7,
  agent_session: { source: "test", agent: "claude", kind: "id", value: "sess-1" },
  interactive_ready: true,
  launch_pending: false,
};

interface FakeState {
  agents: FakeAgent[];
  /** When set, agent.get for unknown targets returns this RPC error. */
  agentGetError?: { code: string; message: string };
}

/**
 * Fake herdr socket: `session.snapshot` + `agent.*` methods. Mutating
 * calls are recorded so tests can assert what (and whether) was sent.
 */
async function fakeHerdr(state: FakeState): Promise<{
  socketPath: string;
  calls: RecordedCall[];
  close: () => Promise<void>;
}> {
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
  const calls: RecordedCall[] = [];
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
        calls.push({ method: message.method ?? "", params: message.params ?? {} });
        let result: unknown = {};
        let error: { code: string; message: string } | undefined;
        const params = message.params ?? {};
        switch (message.method) {
          case "session.snapshot":
            result = {
              snapshot: {
                session: { name: "test-session" },
                panes: state.agents.map((a) => ({
                  pane_id: a.pane_id,
                  workspace_id: a.workspace_id,
                  tab_id: a.tab_id,
                })),
                agents: state.agents,
              },
            };
            break;
          case "agent.get": {
            const target = params.target as string;
            const agent = state.agents.find((a) => a.pane_id === target || a.agent === target);
            if (!agent) {
              error = state.agentGetError ?? {
                code: "agent_not_found",
                message: `no agent for target: ${target}`,
              };
            } else {
              result = { type: "agent_info", agent };
            }
            break;
          }
          case "agent.prompt": {
            const target = params.target as string;
            const agent = state.agents.find((a) => a.pane_id === target || a.agent === target);
            if (agent?.agent_status === "blocked") {
              error = { code: "agent_blocked", message: "agent is blocked" };
            } else {
              result = { type: "agent_prompted", target, accepted: true };
            }
            break;
          }
          case "agent.wait":
            result = { type: "agent_waited", agent_status: "idle" };
            break;
          case "agent.send_keys":
            result = { type: "agent_keys_sent" };
            break;
          case "agent.read":
            result = {
              type: "agent_read",
              read: {
                pane_id: params.target,
                source: params.source,
                format: params.format ?? "text",
                text: "fake scrollback",
                truncated: false,
              },
            };
            break;
          case "agent.rename":
            result = { type: "agent_renamed", name: params.name ?? null };
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
    server.listen(socketPath, () => resolveListen());
  });
  return {
    socketPath,
    calls,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function callsOf(calls: RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((c) => c.method === method);
}

function envFor(socketPath: string): Record<string, string> {
  return { HERDR_SOCKET_PATH: socketPath };
}

// --- Tests ---------------------------------------------------------------------

describe("rebuildup.controls capability", () => {
  test("capability works offline and declares the contract", async () => {
    const result = await runCli(["capability"]);
    expect(result.status).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.contract).toBe("herdr-plugins.controls/v1");
    expect(json.command).toBe("capability");
    expect(json.read_only).toBe(false);
    expect(json.commands).toContain("send");
    expect(json.commands).toContain("interrupt");
    const providers = json.providers as Array<{ id: string; status: string }>;
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every((p) => p.status === "supported")).toBe(true);
    expect(json.upstream_gaps).toBeDefined();
  });
});

describe("rebuildup.controls send", () => {
  test("send resolves identity and forwards text + wait options", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        [
          "send",
          "pane-1",
          "hello",
          "world",
          "--wait-until",
          "working",
          "--wait-until",
          "idle",
          "--timeout-ms",
          "5000",
        ],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const json = result.json as {
        identity: Record<string, unknown>;
        waited: boolean;
        result: Record<string, unknown>;
      };
      expect(json.identity.pane_id).toBe("pane-1");
      expect(json.identity.workspace_id).toBe("ws-1");
      expect(json.identity.tab_id).toBe("tab-1");
      expect(json.identity.agent).toBe("claude");
      expect(json.identity.agent_session).toEqual({
        agent: "claude",
        kind: "id",
        value: "sess-1",
      });
      expect(json.identity.state_change_seq).toBe(7);
      expect(json.identity.herdr_session).toBe("test-session");
      expect(json.waited).toBe(true);

      const prompts = callsOf(fake.calls, "agent.prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.params).toEqual({
        target: "pane-1",
        text: "hello world",
        wait: { until: ["working", "idle"], timeout_ms: 5000 },
      });
    } finally {
      await fake.close();
    }
  });

  test("send without wait flags sends no wait object", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(["send", "claude", "hi"], envFor(fake.socketPath));
      expect(result.status).toBe(0);
      const prompts = callsOf(fake.calls, "agent.prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.params).toEqual({ target: "claude", text: "hi" });
    } finally {
      await fake.close();
    }
  });

  test("send to a blocked agent is a structured error and never reaches agent.prompt", async () => {
    const blocked = { ...AGENT, agent_status: "blocked" };
    const fake = await fakeHerdr({ agents: [blocked] });
    try {
      const result = await runCli(["send", "pane-1", "hi"], envFor(fake.socketPath));
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("requires_interactive_input");
      expect(result.error?.message).toContain("blocked");
      expect(callsOf(fake.calls, "agent.prompt")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  test("send to an unknown target surfaces agent_not_found", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(["send", "pane-99", "hi"], envFor(fake.socketPath));
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("agent_not_found");
      expect(callsOf(fake.calls, "agent.prompt")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});

describe("rebuildup.controls wait", () => {
  test("wait forwards until/timeout_ms", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["wait", "pane-1", "--until", "done", "--until", "blocked", "--timeout-ms", "1234"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const waits = callsOf(fake.calls, "agent.wait");
      expect(waits).toHaveLength(1);
      expect(waits[0]?.params).toEqual({
        target: "pane-1",
        until: ["done", "blocked"],
        timeout_ms: 1234,
      });
      const json = result.json as { identity: { pane_id: string } };
      expect(json.identity.pane_id).toBe("pane-1");
    } finally {
      await fake.close();
    }
  });

  test("wait rejects an invalid status", async () => {
    const result = await runCli(["wait", "pane-1", "--until", "bogus"]);
    expect(result.status).toBe(2);
    expect(result.error?.code).toBe("usage");
  });
});

describe("rebuildup.controls interrupt", () => {
  test("interrupt defaults to esc and reports pty_level", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(["interrupt", "pane-1"], envFor(fake.socketPath));
      expect(result.status).toBe(0);
      const json = result.json as { keys: string[]; pty_level: boolean };
      expect(json.keys).toEqual(["esc"]);
      expect(json.pty_level).toBe(true);
      const keys = callsOf(fake.calls, "agent.send_keys");
      expect(keys).toHaveLength(1);
      expect(keys[0]?.params).toEqual({ target: "pane-1", keys: ["esc"] });
    } finally {
      await fake.close();
    }
  });

  test("interrupt accepts repeated --key and comma-separated --keys", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["interrupt", "pane-1", "--key", "ctrl+c", "--keys", "esc,ctrl+d"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const keys = callsOf(fake.calls, "agent.send_keys");
      expect(keys[0]?.params.keys).toEqual(["ctrl+c", "esc", "ctrl+d"]);
    } finally {
      await fake.close();
    }
  });
});

describe("rebuildup.controls read", () => {
  test("read forwards source/lines/format and defaults strip_ansi", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["read", "pane-1", "--source", "visible", "--lines", "50"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const reads = callsOf(fake.calls, "agent.read");
      expect(reads).toHaveLength(1);
      expect(reads[0]?.params).toEqual({
        target: "pane-1",
        source: "visible",
        lines: 50,
        strip_ansi: true,
      });
      const json = result.json as { scrollback: boolean; read: { text: string } };
      expect(json.scrollback).toBe(true);
      expect(json.read.text).toBe("fake scrollback");
    } finally {
      await fake.close();
    }
  });

  test("read --format ansi disables strip_ansi", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(["read", "pane-1", "--format", "ansi"], envFor(fake.socketPath));
      expect(result.status).toBe(0);
      const reads = callsOf(fake.calls, "agent.read");
      expect(reads[0]?.params.format).toBe("ansi");
      expect(reads[0]?.params.strip_ansi).toBe(false);
    } finally {
      await fake.close();
    }
  });
});

describe("rebuildup.controls rename", () => {
  test("rename --name forwards the name", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["rename", "pane-1", "--name", "worker-1"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const renames = callsOf(fake.calls, "agent.rename");
      expect(renames).toHaveLength(1);
      expect(renames[0]?.params).toEqual({ target: "pane-1", name: "worker-1" });
    } finally {
      await fake.close();
    }
  });

  test("rename --clear sends name=null", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(["rename", "pane-1", "--clear"], envFor(fake.socketPath));
      expect(result.status).toBe(0);
      const renames = callsOf(fake.calls, "agent.rename");
      expect(renames[0]?.params).toEqual({ target: "pane-1", name: null });
    } finally {
      await fake.close();
    }
  });

  test("rename requires exactly one of --name/--clear", async () => {
    const result = await runCli(["rename", "pane-1"]);
    expect(result.status).toBe(2);
  });
});

describe("rebuildup.controls generation guards", () => {
  test("matching expectations pass and are forwarded nowhere", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        [
          "interrupt",
          "pane-1",
          "--expect-pane",
          "pane-1",
          "--expect-state-seq",
          "7",
          "--expect-agent-session",
          "sess-1",
        ],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      expect(callsOf(fake.calls, "agent.send_keys")).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  test("state_change_seq mismatch aborts with stale_generation before mutation", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["send", "pane-1", "hi", "--expect-state-seq", "6"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("stale_generation");
      expect(callsOf(fake.calls, "agent.prompt")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  test("agent_session mismatch aborts with stale_generation", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["rename", "pane-1", "--name", "x", "--expect-agent-session", "other-session"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("stale_generation");
      expect(callsOf(fake.calls, "agent.rename")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  test("pane mismatch aborts with stale_generation", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["interrupt", "pane-1", "--expect-pane", "pane-2"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("stale_generation");
      expect(callsOf(fake.calls, "agent.send_keys")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});

describe("rebuildup.controls unreachable session", () => {
  test("dead socket surfaces session_unreachable", async () => {
    const result = await runCli(["wait", "pane-1"]);
    expect(result.status).toBe(1);
    expect(result.error?.kind).toBe("session_unreachable");
  });
});
