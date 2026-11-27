import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { herdrSocketEndpoint, testEnv } from "./helpers/test-env";

const CLI = path.join(__dirname, "..", "plugins", "textgen", "src", "cli.ts");

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "TEXTGEN_E2E_KEY",
]) {
  savedEnv[key] = process.env[key];
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "textgen-cli-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

function baseEnv(extra?: Record<string, string>): Record<string, string> {
  return testEnv(extra);
}

function parseOut(stdout: string, stderr: string, status: number): CliResult {
  let json: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    /* non-JSON stdout */
  }
  try {
    error = (JSON.parse(stderr) as { error?: Record<string, unknown> }).error ?? null;
  } catch {
    /* empty stderr */
  }
  return { status, stdout, stderr, json, error };
}

function runCli(
  args: string[],
  extraEnv: Record<string, string>,
  stdin?: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: baseEnv(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(parseOut(stdout, stderr, code ?? -1)));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

// --- fake herdr socket -----------------------------------------------------------

interface FakeCall {
  method: string;
  params: Record<string, unknown>;
}

/** Fake herdr answering the agent-pane generation sequence. */
async function fakeHerdr(opts?: {
  agentReadText?: string;
  failStart?: boolean;
  onCall?: (call: FakeCall) => void;
}): Promise<{ socketPath: string; calls: FakeCall[]; close: () => Promise<void> }> {
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
  const calls: FakeCall[] = [];
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
        opts?.onCall?.({ method, params });
        let result: Record<string, unknown>;
        switch (method) {
          case "server.agent_manifests":
            result = {
              manifests: [{ agent: "claude", source: "builtin", source_kind: "builtin" }],
            };
            break;
          case "workspace.create":
            result = {
              workspace: { workspace_id: "w-e2e" },
              tab: { tab_id: "t-e2e" },
              root_pane: { pane_id: "p-e2e" },
            };
            break;
          case "agent.start":
            if (opts?.failStart) {
              conn.write(
                `${JSON.stringify({ id: message.id, error: { code: "agent_start_failed", message: "kind not installed" } })}\n`,
              );
              continue;
            }
            result = {
              type: "agent_started",
              agent: { name: params.name, agent_status: "idle", pane_id: "p-e2e" },
              argv: ["claude"],
            };
            break;
          case "agent.prompt":
            result = {
              type: "agent_prompted",
              agent: { name: params.target, agent_status: "idle" },
            };
            break;
          case "agent.read":
            result = {
              type: "pane_read",
              read: {
                pane_id: "p-e2e",
                text:
                  opts?.agentReadText ??
                  "noise\n<<<TEXTGEN_RESULT>>>\nfeat(cli): e2e generated title\n<<<TEXTGEN_END>>>\ntail",
              },
            };
            break;
          case "workspace.close":
            result = { type: "workspace_closed" };
            break;
          default:
            result = {};
        }
        conn.write(`${JSON.stringify({ id: message.id, result })}\n`);
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
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

// --- fake HTTP API generator -------------------------------------------------------

async function fakeApi(
  handler: (req: http.IncomingMessage, body: string) => { status: number; json: unknown },
): Promise<{
  port: number;
  seen: { auth: string | null; body: string }[];
  close: () => Promise<void>;
}> {
  const seen: { auth: string | null; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization ?? null, body });
      const out = handler(req, body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    seen,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function writeConfig(dir: string, config: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

// --- tests -------------------------------------------------------------------------

describe("textgen cli", () => {
  test("capability works with unreachable herdr and lists tasks/paths", async () => {
    const configDir = path.join(tempDir(), "config");
    const dead = path.join(tempDir(), "no.sock");
    const res = await runCli(["capability"], {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: path.join(configDir, "..", "state"),
      HERDR_SOCKET_PATH: dead,
    });
    expect(res.status).toBe(0);
    expect(res.json?.contract).toBe("herdr-plugins.textgen/v1");
    const tasks = res.json?.tasks as Array<{ kind: string; paths: string[] }>;
    expect(tasks.map((t) => t.kind).sort()).toEqual([
      "branch_name",
      "commit_message",
      "next_prompt",
      "pr_content",
      "review_guide",
      "thread_title",
    ]);
    const providers = res.json?.providers as Record<string, unknown>;
    expect((providers.cli as { status: string }).status).toBe("unsupported");
    // mutation_commands (#224): generation + config-writing subcommands.
    expect(res.json?.mutation_commands).toEqual([
      "generate",
      "watch-next-prompt",
      "config set-default-provider",
      "config set-default-model",
      "config add-api-generator",
      "config remove-api-generator",
    ]);
  });

  test("generate via agent path: full socket sequence + validated result", async () => {
    const herdr = await fakeHerdr();
    try {
      const configDir = path.join(tempDir(), "config");
      const res = await runCli(
        ["generate", "--task", "thread_title", "--provider", "agent:claude"],
        {
          HERDR_PLUGIN_CONFIG_DIR: configDir,
          HERDR_PLUGIN_STATE_DIR: path.join(configDir, "..", "state"),
          HERDR_SOCKET_PATH: herdr.socketPath,
        },
        JSON.stringify({ context: "we planned the release" }),
      );
      expect(res.status).toBe(0);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.provider).toBe("agent:claude");
      expect(res.json?.result).toBe("feat(cli): e2e generated title");
      const methods = herdr.calls.map((c) => c.method);
      expect(methods).toEqual([
        "server.agent_manifests",
        "workspace.create",
        "agent.start",
        "agent.prompt",
        "agent.read",
        "workspace.close",
      ]);
      // prompt carried the markers instruction
      const promptCall = herdr.calls.find((c) => c.method === "agent.prompt");
      expect(String(promptCall?.params.text)).toContain("<<<TEXTGEN_RESULT>>>");
      expect(String(promptCall?.params.text)).toContain("we planned the release");
    } finally {
      await herdr.close();
    }
  });

  test("generate via api path: opt-in generator, key never leaks", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: { choices: [{ message: { content: "feat(api): generated branch" } }] },
    }));
    try {
      const root = tempDir();
      const configDir = path.join(root, "config");
      writeConfig(configDir, {
        apiGenerators: [
          {
            id: "local",
            kind: "openai-compatible",
            endpoint: `http://127.0.0.1:${api.port}/v1`,
            model: "test-model",
            keyEnv: "TEXTGEN_E2E_KEY",
            enabled: true,
          },
        ],
      });
      const res = await runCli(
        ["generate", "--task", "branch_name", "--provider", "api:local"],
        {
          HERDR_PLUGIN_CONFIG_DIR: configDir,
          HERDR_PLUGIN_STATE_DIR: path.join(root, "state"),
          HERDR_SOCKET_PATH: path.join(root, "dead.sock"),
          TEXTGEN_E2E_KEY: "e2e-secret-key",
        },
        JSON.stringify({ change_summary: "add textgen plugin" }),
      );
      expect(res.status).toBe(0);
      expect(res.json?.provider).toBe("api:local");
      expect(res.json?.path).toBe("api");
      expect(res.json?.result).toBe("feat(api): generated branch");
      expect(api.seen).toHaveLength(1);
      expect(api.seen[0]?.auth).toBe("Bearer e2e-secret-key");
      // credential never appears in any output channel
      expect(res.stdout).not.toContain("e2e-secret-key");
      expect(res.stderr).not.toContain("e2e-secret-key");
    } finally {
      await api.close();
    }
  });

  test("disabled api generator cannot be used", async () => {
    const root = tempDir();
    const configDir = path.join(root, "config");
    writeConfig(configDir, {
      apiGenerators: [
        {
          id: "off",
          kind: "openai",
          endpoint: "https://api.openai.com",
          enabled: false,
        },
      ],
    });
    const res = await runCli(
      ["generate", "--task", "thread_title", "--provider", "api:off"],
      {
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_STATE_DIR: path.join(root, "state"),
        HERDR_SOCKET_PATH: path.join(root, "dead.sock"),
      },
      JSON.stringify({ context: "ctx" }),
    );
    expect(res.status).toBe(1);
    expect(JSON.stringify(res.error)).toContain("provider_unknown");
  });

  test("secret-shaped input is rejected before any provider call", async () => {
    const herdr = await fakeHerdr();
    try {
      const configDir = path.join(tempDir(), "config");
      const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
      const res = await runCli(
        ["generate", "--task", "commit_message", "--provider", "agent:claude"],
        {
          HERDR_PLUGIN_CONFIG_DIR: configDir,
          HERDR_PLUGIN_STATE_DIR: path.join(configDir, "..", "state"),
          HERDR_SOCKET_PATH: herdr.socketPath,
        },
        JSON.stringify({ diff: `+const k = "${secret}";` }),
      );
      expect(res.status).toBe(1);
      expect(JSON.stringify(res.error)).toContain("input_secret_detected");
      // only the manifests probe may have run — no workspace/agent calls
      const methods = herdr.calls.map((c) => c.method);
      expect(methods).not.toContain("workspace.create");
      expect(methods).not.toContain("agent.start");
      expect(res.stderr).not.toContain(secret);
      expect(res.stdout).not.toContain(secret);
    } finally {
      await herdr.close();
    }
  });

  test("agent start failure still closes the workspace and reports structured error", async () => {
    const herdr = await fakeHerdr({ failStart: true });
    try {
      const configDir = path.join(tempDir(), "config");
      const res = await runCli(
        ["generate", "--task", "thread_title", "--provider", "agent:claude"],
        {
          HERDR_PLUGIN_CONFIG_DIR: configDir,
          HERDR_PLUGIN_STATE_DIR: path.join(configDir, "..", "state"),
          HERDR_SOCKET_PATH: herdr.socketPath,
        },
        JSON.stringify({ context: "ctx" }),
      );
      expect(res.status).toBe(1);
      expect(JSON.stringify(res.error)).toContain("agent_start_failed");
      const methods = herdr.calls.map((c) => c.method);
      expect(methods).toContain("workspace.create");
      expect(methods).toContain("workspace.close");
    } finally {
      await herdr.close();
    }
  });

  test("unmarked agent output → output_unmarked error", async () => {
    const herdr = await fakeHerdr({ agentReadText: "the agent rambled without markers" });
    try {
      const configDir = path.join(tempDir(), "config");
      const res = await runCli(
        ["generate", "--task", "thread_title", "--provider", "agent:claude"],
        {
          HERDR_PLUGIN_CONFIG_DIR: configDir,
          HERDR_PLUGIN_STATE_DIR: path.join(configDir, "..", "state"),
          HERDR_SOCKET_PATH: herdr.socketPath,
        },
        JSON.stringify({ context: "ctx" }),
      );
      expect(res.status).toBe(1);
      expect(JSON.stringify(res.error)).toContain("output_unmarked");
    } finally {
      await herdr.close();
    }
  });

  test("review_guide rejects api provider (agent-only task)", async () => {
    const root = tempDir();
    const configDir = path.join(root, "config");
    const api = await fakeApi(() => ({
      status: 200,
      json: { choices: [{ message: { content: "x" } }] },
    }));
    try {
      writeConfig(configDir, {
        apiGenerators: [
          {
            id: "local",
            kind: "openai-compatible",
            endpoint: `http://127.0.0.1:${api.port}/v1`,
            enabled: true,
            keyEnv: "TEXTGEN_E2E_KEY",
          },
        ],
      });
      const res = await runCli(
        ["generate", "--task", "review_guide", "--provider", "api:local"],
        {
          HERDR_PLUGIN_CONFIG_DIR: configDir,
          HERDR_PLUGIN_STATE_DIR: path.join(root, "state"),
          HERDR_SOCKET_PATH: path.join(root, "dead.sock"),
          TEXTGEN_E2E_KEY: "k",
        },
        JSON.stringify({ target: "PR #1" }),
      );
      expect(res.status).toBe(1);
      expect(JSON.stringify(res.error)).toContain("provider_path_unsupported");
      expect(api.seen).toHaveLength(0);
    } finally {
      await api.close();
    }
  });

  test("config add-api-generator stores disabled unless --enable", async () => {
    const root = tempDir();
    const configDir = path.join(root, "config");
    const env = {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: path.join(root, "state"),
    };
    const add = await runCli(
      [
        "config",
        "add-api-generator",
        "--id",
        "gw",
        "--kind",
        "openai-compatible",
        "--endpoint",
        "https://gw.example.com/v1",
        "--key-env",
        "GW_KEY",
      ],
      env,
    );
    expect(add.status).toBe(0);
    expect(add.json?.note).toContain("DISABLED");
    const show = await runCli(["config", "show"], env);
    const gens = (show.json?.config as { apiGenerators: Array<{ id: string; enabled: boolean }> })
      .apiGenerators;
    expect(gens[0]?.id).toBe("gw");
    expect(gens[0]?.enabled).toBe(false);
    // config file must not contain a key value
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(path.join(configDir, "config.json"), "utf8");
    expect(raw).toContain("GW_KEY");
    expect(raw).not.toContain("sk-");
  });

  test("generate --raw prints bare result for scripting", async () => {
    const herdr = await fakeHerdr();
    try {
      const configDir = path.join(tempDir(), "config");
      const res = await runCli(
        ["generate", "--task", "thread_title", "--provider", "agent:claude", "--raw"],
        {
          HERDR_PLUGIN_CONFIG_DIR: configDir,
          HERDR_PLUGIN_STATE_DIR: path.join(configDir, "..", "state"),
          HERDR_SOCKET_PATH: herdr.socketPath,
        },
        JSON.stringify({ context: "ctx" }),
      );
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe("feat(cli): e2e generated title");
      expect(res.json).toBeNull();
    } finally {
      await herdr.close();
    }
  });

  test("unknown task / missing input are usage/structured errors", async () => {
    const configDir = path.join(tempDir(), "config");
    const env = {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: path.join(configDir, "..", "state"),
      HERDR_SOCKET_PATH: path.join(tempDir(), "dead.sock"),
    };
    const bad = await runCli(["generate", "--task", "nope"], env, "{}");
    expect(bad.status).toBe(2);
    const empty = await runCli(["generate", "--task", "thread_title"], env, "");
    expect(empty.status).toBe(1);
    expect(JSON.stringify(empty.error)).toContain("input_required");
  });
});
