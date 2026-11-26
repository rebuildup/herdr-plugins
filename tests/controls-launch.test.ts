import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "../plugins/controls/src/cli.ts");
const DEAD_SOCKET = path.join(tmpdir(), "controls-launch-dead-herdr.sock");

const dirs: string[] = [];
const savedSocket = process.env.HERDR_SOCKET_PATH;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "controls-launch-test-"));
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

const KNOWN_KINDS = new Set([
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "letta",
  "maki",
  "muse",
]);

interface FakeState {
  agents: FakeAgent[];
}

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
              error = { code: "agent_not_found", message: `no agent for target: ${target}` };
            } else {
              result = { type: "agent_info", agent };
            }
            break;
          }
          case "agent.start": {
            const kind = params.kind as string;
            if (!KNOWN_KINDS.has(kind)) {
              error = {
                code: "unsupported_agent_kind",
                message: `unsupported interactive agent kind ${kind}`,
              };
              break;
            }
            const args = Array.isArray(params.args) ? (params.args as string[]) : [];
            // Mirror herdr: argv = [executable, ...args].
            const argv = [kind, ...args];
            result = {
              type: "agent_started",
              agent: {
                pane_id: params.pane_id,
                workspace_id: "ws-9",
                tab_id: "tab-9",
                agent: kind,
                agent_status: "idle",
                state_change_seq: 1,
                interactive_ready: true,
                launch_pending: false,
                name: params.name,
              },
              argv,
            };
            break;
          }
          case "agent.wait":
            result = { type: "agent_waited", agent_status: "idle" };
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

describe("rebuildup.controls start — capability", () => {
  test("capability advertises start and per-provider launch tables", async () => {
    const result = await runCli(["capability"]);
    expect(result.status).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.commands).toContain("start");
    expect(json.mutation_commands).toContain("start");
    const providers = json.providers as Array<{
      id: string;
      launch: {
        model: boolean;
        reasoning: boolean;
        permission_modes: Record<string, string[]>;
        resume: string;
      };
    }>;
    const claude = providers.find((p) => p.id === "claude");
    expect(claude?.launch.model).toBe(true);
    expect(claude?.launch.reasoning).toBe(true);
    expect(Object.keys(claude?.launch.permission_modes ?? {})).toEqual([
      "supervised",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(claude?.launch.resume).toContain("id");
    const codex = providers.find((p) => p.id === "codex");
    expect(codex?.launch.permission_modes["full-access"]).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    const gemini = providers.find((p) => p.id === "gemini");
    expect(gemini?.launch.permission_modes.auto).toBeUndefined();
    const muse = providers.find((p) => p.id === "muse");
    expect(muse?.launch.resume).toBe("unsupported");
  });
});

describe("rebuildup.controls start — launch args", () => {
  test("start maps model/reasoning/permission-mode/arg for claude", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const result = await runCli(
        [
          "start",
          "pane-9",
          "--agent",
          "claude",
          "--name",
          "worker-1",
          "--model",
          "sonnet",
          "--reasoning",
          "high",
          "--permission-mode",
          "auto-accept-edits",
          "--arg",
          "--verbose",
        ],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const starts = callsOf(fake.calls, "agent.start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.params).toEqual({
        name: "worker-1",
        kind: "claude",
        pane_id: "pane-9",
        args: [
          "--model",
          "sonnet",
          "--effort",
          "high",
          "--permission-mode",
          "acceptEdits",
          "--verbose",
        ],
      });
      const json = result.json as {
        identity: { pane_id: string; agent: string };
        launch: { argv: string[]; applied: Record<string, unknown> };
      };
      expect(json.identity.pane_id).toBe("pane-9");
      expect(json.identity.agent).toBe("claude");
      expect(json.launch.argv[0]).toBe("claude");
      expect(json.launch.argv).toContain("--permission-mode");
      expect(json.launch.applied.unsafe_args).toBe(false);
    } finally {
      await fake.close();
    }
  });

  test("start generates a default agent name when --name is absent", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const result = await runCli(["start", "pane-9", "--agent", "pi"], envFor(fake.socketPath));
      expect(result.status).toBe(0);
      const starts = callsOf(fake.calls, "agent.start");
      const name = starts[0]?.params.name as string;
      expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect(name.startsWith("pi-")).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("codex full-access maps to the bypass flag; auto maps to --approve-for-me", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const full = await runCli(
        ["start", "pane-9", "--agent", "codex", "--permission-mode", "full-access"],
        envFor(fake.socketPath),
      );
      expect(full.status).toBe(0);
      expect(callsOf(fake.calls, "agent.start")[0]?.params.args).toEqual([
        "--dangerously-bypass-approvals-and-sandbox",
      ]);

      const auto = await runCli(
        ["start", "pane-9", "--agent", "codex", "--permission-mode", "auto"],
        envFor(fake.socketPath),
      );
      expect(auto.status).toBe(0);
      expect(callsOf(fake.calls, "agent.start")[1]?.params.args).toEqual(["--approve-for-me"]);
    } finally {
      await fake.close();
    }
  });

  test("unsupported options fail before agent.start is called", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const model = await runCli(
        ["start", "pane-9", "--agent", "opencode", "--model", "anthropic/claude"],
        envFor(fake.socketPath),
      );
      expect(model.status).toBe(1);
      expect(model.error?.kind).toBe("unsupported_launch_option");
      expect(model.error?.option).toBe("model");

      const mode = await runCli(
        ["start", "pane-9", "--agent", "gemini", "--permission-mode", "auto"],
        envFor(fake.socketPath),
      );
      expect(mode.status).toBe(1);
      expect(mode.error?.kind).toBe("unsupported_launch_option");
      expect(mode.error?.supported_modes).toEqual([
        "supervised",
        "auto-accept-edits",
        "full-access",
      ]);

      const resume = await runCli(
        ["start", "pane-9", "--agent", "muse", "--resume", "sess-1"],
        envFor(fake.socketPath),
      );
      expect(resume.status).toBe(1);
      expect(resume.error?.kind).toBe("unsupported_launch_option");
      expect(resume.error?.option).toBe("resume");

      expect(callsOf(fake.calls, "agent.start")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  test("unknown agent kind still reaches agent.start for herdr to judge", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const result = await runCli(
        ["start", "pane-9", "--agent", "bogus-kind", "--arg", "--foo"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("unsupported_agent_kind");
      const starts = callsOf(fake.calls, "agent.start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.params.kind).toBe("bogus-kind");
      expect(starts[0]?.params.args).toEqual(["--foo"]);
    } finally {
      await fake.close();
    }
  });
});

describe("rebuildup.controls start — resume", () => {
  test("--resume maps per provider (claude flag, codex subcommand, pi --session)", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      await runCli(
        ["start", "pane-9", "--agent", "claude", "--resume", "sess-42"],
        envFor(fake.socketPath),
      );
      await runCli(
        ["start", "pane-9", "--agent", "codex", "--resume", "sess-42"],
        envFor(fake.socketPath),
      );
      await runCli(
        ["start", "pane-9", "--agent", "pi", "--resume", "abc123"],
        envFor(fake.socketPath),
      );
      const starts = callsOf(fake.calls, "agent.start");
      expect(starts[0]?.params.args).toEqual(["--resume", "sess-42"]);
      expect(starts[1]?.params.args).toEqual(["resume", "sess-42"]);
      expect(starts[2]?.params.args).toEqual(["--session", "abc123"]);
    } finally {
      await fake.close();
    }
  });

  test("--resume-from reuses the reported agent_session", async () => {
    const piAgent: FakeAgent = {
      ...AGENT,
      pane_id: "pane-1",
      agent: "pi",
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "path",
        value: "/tmp/pi-sessions/sess-1.jsonl",
      },
    };
    const fake = await fakeHerdr({ agents: [piAgent] });
    try {
      const result = await runCli(
        ["start", "pane-9", "--agent", "pi", "--resume-from", "pane-1"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const starts = callsOf(fake.calls, "agent.start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.params.args).toEqual(["--session", "/tmp/pi-sessions/sess-1.jsonl"]);
      const json = result.json as { launch: { resume_source: string } };
      expect(json.launch.resume_source).toBe("herdr:pi");
    } finally {
      await fake.close();
    }
  });

  test("--resume-from rejects provider mismatch and missing sessions", async () => {
    const fake = await fakeHerdr({ agents: [AGENT] });
    try {
      const mismatch = await runCli(
        ["start", "pane-9", "--agent", "codex", "--resume-from", "pane-1"],
        envFor(fake.socketPath),
      );
      expect(mismatch.status).toBe(1);
      expect(mismatch.error?.kind).toBe("resume_session_mismatch");

      const noSession = await runCli(
        ["start", "pane-9", "--agent", "claude", "--resume-from", "pane-99"],
        envFor(fake.socketPath),
      );
      expect(noSession.status).toBe(1);
      expect(noSession.error?.kind).toBe("agent_not_found");

      expect(callsOf(fake.calls, "agent.start")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});

describe("rebuildup.controls start — arg safety", () => {
  test("denylisted privilege flags are rejected before agent.start", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const result = await runCli(
        ["start", "pane-9", "--agent", "claude", "--arg", "--dangerously-skip-permissions"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("unsafe_agent_argument");
      expect(callsOf(fake.calls, "agent.start")).toHaveLength(0);

      const inline = await runCli(
        ["start", "pane-9", "--agent", "claude", "--arg", "--permission-mode=bypassPermissions"],
        envFor(fake.socketPath),
      );
      expect(inline.status).toBe(1);
      expect(inline.error?.kind).toBe("unsafe_agent_argument");

      const pair = await runCli(
        ["start", "pane-9", "--agent", "codex", "--arg", "--ask-for-approval", "--arg", "never"],
        envFor(fake.socketPath),
      );
      expect(pair.status).toBe(1);
      expect(pair.error?.kind).toBe("unsafe_agent_argument");
      expect(callsOf(fake.calls, "agent.start")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  test("--unsafe-args is the explicit opt-out and is echoed", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const result = await runCli(
        [
          "start",
          "pane-9",
          "--agent",
          "claude",
          "--arg",
          "--dangerously-skip-permissions",
          "--unsafe-args",
        ],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const starts = callsOf(fake.calls, "agent.start");
      expect(starts[0]?.params.args).toEqual(["--dangerously-skip-permissions"]);
      const json = result.json as { launch: { applied: { unsafe_args: boolean } } };
      expect(json.launch.applied.unsafe_args).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("control characters and flag-smuggling values are usage errors", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const ctrl = await runCli(
        ["start", "pane-9", "--agent", "claude", "--arg", "bad\u0007arg"],
        envFor(fake.socketPath),
      );
      expect(ctrl.status).toBe(2);

      const smuggle = await runCli(
        ["start", "pane-9", "--agent", "claude", "--model", "--dangerously-skip-permissions"],
        envFor(fake.socketPath),
      );
      expect(smuggle.status).toBe(2);

      const empty = await runCli(
        ["start", "pane-9", "--agent", "claude", "--resume", "-c"],
        envFor(fake.socketPath),
      );
      expect(empty.status).toBe(2);

      expect(callsOf(fake.calls, "agent.start")).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});

describe("rebuildup.controls start — timeouts and wait", () => {
  test("--timeout-ms bounds are enforced and forwarded as timeout_ms", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const bad = await runCli(
        ["start", "pane-9", "--agent", "claude", "--timeout-ms", "1000"],
        envFor(fake.socketPath),
      );
      expect(bad.status).toBe(2);

      const good = await runCli(
        ["start", "pane-9", "--agent", "claude", "--timeout-ms", "60000"],
        envFor(fake.socketPath),
      );
      expect(good.status).toBe(0);
      expect(callsOf(fake.calls, "agent.start")[0]?.params.timeout_ms).toBe(60000);
    } finally {
      await fake.close();
    }
  });

  test("--wait observes idle/working via agent.wait after launch", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const result = await runCli(
        ["start", "pane-9", "--agent", "claude", "--wait", "--wait-timeout-ms", "5000"],
        envFor(fake.socketPath),
      );
      expect(result.status).toBe(0);
      const waits = callsOf(fake.calls, "agent.wait");
      expect(waits).toHaveLength(1);
      expect(waits[0]?.params).toEqual({
        target: "pane-9",
        until: ["idle", "working"],
        timeout_ms: 5000,
      });
      const json = result.json as { waited: boolean; wait: { agent_status: string } };
      expect(json.waited).toBe(true);
      expect(json.wait.agent_status).toBe("idle");
    } finally {
      await fake.close();
    }
  });

  test("upstream agent.start errors surface their RPC code", async () => {
    const fake = await fakeHerdr({ agents: [] });
    try {
      const result = await runCli(
        ["start", "pane-9", "--agent", "bogus-kind"],
        envFor(fake.socketPath),
      );
      // canonicalKind leaves it untouched; fake rejects unknown kinds.
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("unsupported_agent_kind");
    } finally {
      await fake.close();
    }
  });
});
