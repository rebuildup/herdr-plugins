import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "../plugins/controls/src/cli.ts");
const DEAD_SOCKET = path.join(tmpdir(), "controls-command-dead-herdr.sock");

const dirs: string[] = [];
const savedSocket = process.env.HERDR_SOCKET_PATH;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "controls-command-test-"));
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

async function fakeHerdr(state: { agents: FakeAgent[] }): Promise<{
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
              error = { code: "agent_not_found", message: `no agent for target: ${target}` };
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

describe("rebuildup.controls command", () => {
  test("command forwards `/name args` text through agent.prompt", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["command", "pane-1", "/model", "opus", "--wait-until", "idle", "--timeout-ms", "3000"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const json = result.json as {
        passthrough: string;
        command_name: string;
        text: string;
        fragile: boolean;
        waited: boolean;
        provider: { kind: string; known_command: boolean; commands: string[] };
        identity: { pane_id: string };
      };
      expect(json.passthrough).toBe("agent.prompt");
      expect(json.command_name).toBe("/model");
      expect(json.text).toBe("/model opus");
      expect(json.fragile).toBe(true);
      expect(json.waited).toBe(true);
      expect(json.identity.pane_id).toBe("pane-1");
      expect(json.provider.kind).toBe("claude");
      expect(json.provider.known_command).toBe(true);
      expect(json.provider.commands).toContain("compact");

      const prompts = callsOf(fake.calls, "agent.prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.params).toEqual({
        target: "pane-1",
        text: "/model opus",
        wait: { until: ["idle"], timeout_ms: 3000 },
      });
    } finally {
      await fake.close();
    }
  });

  test("command without args submits the bare slash command", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(["command", "claude", "/clear"], envFor(fake.socketPath));
      expect(result.status).toBe(0);
      const prompts = callsOf(fake.calls, "agent.prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.params).toEqual({ target: "claude", text: "/clear" });
      const json = result.json as { provider: { known_command: boolean } };
      expect(json.provider.known_command).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("command for an unknown provider command still forwards with known_command=false", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["command", "pane-1", "/definitely-not-a-command"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const prompts = callsOf(fake.calls, "agent.prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.params.text).toBe("/definitely-not-a-command");
      const json = result.json as { provider: { known_command: boolean; commands: string[] } };
      expect(json.provider.known_command).toBe(false);
    } finally {
      await fake.close();
    }
  });

  test("command to an agent kind without a table entry reports empty commands", async () => {
    const unknown = { ...AGENT, agent: "some-unknown-agent" };
    const fake = await fakeHerdr({ agents: [unknown] });
    try {
      const result = await runCli(["command", "pane-1", "/model"], envFor(fake.socketPath));
      expect(result.status).toBe(0);
      const json = result.json as {
        provider: { kind: string | null; known_command: boolean; commands: string[] };
      };
      expect(json.provider.commands).toEqual([]);
      expect(json.provider.known_command).toBe(false);
    } finally {
      await fake.close();
    }
  });

  test("command to a blocked agent is a structured error and never reaches agent.prompt", async () => {
    const blocked = { ...AGENT, agent_status: "blocked" };
    const fake = await fakeHerdr({ agents: [blocked] });
    try {
      const result = await runCli(["command", "pane-1", "/compact"], envFor(fake.socketPath));
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("requires_interactive_input");
      expect(callsOf(fake.calls, "agent.prompt")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  test("command rejects a missing leading slash", async () => {
    const result = await runCli(["command", "pane-1", "model"]);
    expect(result.status).toBe(2);
    expect(result.error?.code).toBe("usage");
  });

  test("command rejects malformed command names", async () => {
    for (const bad of ["/", "/1model", "/model;x", "/model name"]) {
      const result = await runCli(["command", "pane-1", bad]);
      expect(result.status).toBe(2);
    }
  });

  test("command rejects control characters in args", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["command", "pane-1", "/goal", "line1\nline2"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(2);
      expect(callsOf(fake.calls, "agent.prompt")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  test("command requires target and slash-command", async () => {
    expect((await runCli(["command"])).status).toBe(2);
    expect((await runCli(["command", "pane-1"])).status).toBe(2);
  });

  test("command surfaces agent_not_found for unknown targets", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(["command", "pane-99", "/model"], envFor(fake.socketPath));
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("agent_not_found");
      expect(callsOf(fake.calls, "agent.prompt")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  test("command honors generation guards before mutating", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const result = await runCli(
        ["command", "pane-1", "/model", "--expect-state-seq", "6"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("stale_generation");
      expect(callsOf(fake.calls, "agent.prompt")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});

describe("rebuildup.controls capability command surface", () => {
  test("capability declares command and the advisory provider table", async () => {
    const result = await runCli(["capability"]);
    expect(result.status).toBe(0);
    const json = result.json as {
      commands: string[];
      mutation_commands: string[];
      operations: Record<string, { api: string; note: string }>;
      providers: Array<{
        id: string;
        operations: string[];
        commands: { known: string[]; fragile: boolean; verified: boolean };
      }>;
      upstream_gaps: string[];
    };
    expect(json.commands).toContain("command");
    expect(json.mutation_commands).toContain("command");
    expect(json.operations.command?.api).toBe("agent.prompt");
    const claude = json.providers.find((p) => p.id === "claude");
    expect(claude?.operations).toContain("command");
    expect(claude?.commands.known).toContain("compact");
    expect(claude?.commands.fragile).toBe(true);
    expect(claude?.commands.verified).toBe(false);
    expect(json.upstream_gaps.join(" ")).toContain("steer");
  });
});
