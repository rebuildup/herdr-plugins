import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentTransport, executeAgentPrompt } from "../plugins/textgen/src/agent";
import {
  apiRequestUrl,
  endpointAllowed,
  executeApiPrompt,
  extractApiText,
} from "../plugins/textgen/src/api";
import type { TextgenConfig } from "../plugins/textgen/src/config";
import {
  type ApiGeneratorConfig,
  normalizeConfig,
  parseApiGenerator,
  resolveApiKey,
} from "../plugins/textgen/src/config";
import { generate } from "../plugins/textgen/src/generate";
import { parseInputJson, validateTaskInput } from "../plugins/textgen/src/input";
import { TASKS, TextgenError, taskSpec } from "../plugins/textgen/src/model";
import { extractMarkedResult, validateGeneratedOutput } from "../plugins/textgen/src/output";
import { buildPrompt, MARKER_CLOSE, MARKER_OPEN } from "../plugins/textgen/src/prompts";
import { resolveProvider } from "../plugins/textgen/src/providers";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "textgen-t1-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function baseConfig(overrides?: Partial<TextgenConfig>): TextgenConfig {
  return {
    apiGenerators: [],
    agentProviders: {},
    agent: { startupTimeoutMs: 5_000, promptTimeoutMs: 5_000, readLines: 100 },
    guards: {
      expensiveTaskOptIn: false,
      quota: { enabled: false, maxUsedPercent: 95, timeoutMs: 10_000 },
    },
    limits: { maxInputChars: 200_000 },
    ...overrides,
  };
}

function apiGen(overrides?: Partial<ApiGeneratorConfig>): ApiGeneratorConfig {
  return {
    id: "test",
    kind: "openai-compatible",
    endpoint: "http://127.0.0.1:9999/v1",
    model: "test-model",
    enabled: true,
    ...overrides,
  };
}

describe("task registry", () => {
  test("registers the six upstream tasks", () => {
    expect(TASKS.map((t) => t.kind).sort()).toEqual([
      "branch_name",
      "commit_message",
      "next_prompt",
      "pr_content",
      "review_guide",
      "thread_title",
    ]);
  });

  test("review_guide and next_prompt are agent-only", () => {
    expect(taskSpec("review_guide").paths).toEqual(["agent"]);
    expect(taskSpec("next_prompt").paths).toEqual(["agent"]);
    expect(taskSpec("commit_message").paths).toContain("api");
  });
});

describe("input boundary", () => {
  const commit = taskSpec("commit_message");

  test("accepts a valid payload and drops empty optionals", () => {
    const out = validateTaskInput(commit, {
      diff: "diff --git a/x b/x",
      instruction: "   ",
      candidates: 3,
    });
    expect(out.diff).toBe("diff --git a/x b/x");
    expect(out.instruction).toBeUndefined();
    expect(out.candidates).toBe(3);
  });

  test("rejects unknown fields with names only", () => {
    try {
      validateTaskInput(commit, { diff: "x", secret_plan: "evil" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TextgenError);
      const e = err as TextgenError;
      expect(e.code).toBe("input_unknown_field");
      expect(e.details.fields).toEqual(["secret_plan"]);
    }
  });

  test("requires non-empty required fields", () => {
    expect(() => validateTaskInput(commit, { diff: "  " })).toThrow(TextgenError);
    try {
      validateTaskInput(commit, {});
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("input_missing_field");
    }
  });

  test("rejects non-string/non-number values", () => {
    expect(() => validateTaskInput(commit, { diff: "x", conventions: ["a"] })).toThrow(
      TextgenError,
    );
  });

  test("caps total input size", () => {
    const big = "x".repeat(300_000);
    try {
      validateTaskInput(taskSpec("thread_title"), { context: big });
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("input_too_large");
    }
  });

  test("secret guard fails closed and never echoes the secret", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    try {
      validateTaskInput(commit, { diff: `token: ${secret}` });
      expect.unreachable();
    } catch (err) {
      const e = err as TextgenError;
      expect(e.code).toBe("input_secret_detected");
      expect(e.details.fields).toEqual(["diff"]);
      expect(JSON.stringify(e.details)).not.toContain(secret);
      expect(e.message).not.toContain(secret);
    }
  });

  test("detects PEM blocks and github tokens", () => {
    for (const payload of [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB",
      "ghp_abcdefghijklmnopqrstuvwxyz1234",
      "Bearer abcdefghijklmnopqrstuvwxyz1234",
    ]) {
      try {
        validateTaskInput(taskSpec("thread_title"), { context: payload });
        expect.unreachable();
      } catch (err) {
        expect((err as TextgenError).code).toBe("input_secret_detected");
      }
    }
  });

  test("ordinary diff content passes the guard", () => {
    const out = validateTaskInput(commit, {
      diff: "diff --git a/token.ts b/token.ts\n+const apiKeyName = 'KEY';",
    });
    expect(out.diff).toContain("apiKeyName");
  });

  test("parseInputJson errors are structured", () => {
    expect(() => parseInputJson("", taskSpec("thread_title"))).toThrow(TextgenError);
    try {
      parseInputJson("{nope", taskSpec("thread_title"));
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("input_invalid");
    }
  });
});

describe("output validation", () => {
  const title = taskSpec("thread_title");
  const commit = taskSpec("commit_message");
  const pr = taskSpec("pr_content");

  test("text: trims and unwraps a single fence", () => {
    expect(validateGeneratedOutput(title, "  My Title  ")).toBe("My Title");
    expect(validateGeneratedOutput(title, "```\nMy Title\n```")).toBe("My Title");
    expect(validateGeneratedOutput(title, "```text\nMy Title\n```")).toBe("My Title");
  });

  test("text: rejects empty, control chars, interior fences, oversize", () => {
    for (const [raw, code] of [
      ["   ", "output_empty"],
      ["bad\u0007title", "output_control_chars"],
      ["a ``` b ``` c", "output_unexpected_fence"],
      ["x".repeat(201), "output_too_long"],
    ] as const) {
      try {
        validateGeneratedOutput(title, raw);
        expect.unreachable();
      } catch (err) {
        expect((err as TextgenError).code).toBe(code);
      }
    }
  });

  test("text_list: JSON array and --- separated forms", () => {
    expect(validateGeneratedOutput(commit, '["a","b"]')).toEqual(["a", "b"]);
    expect(validateGeneratedOutput(commit, "a\n---\nb")).toEqual(["a", "b"]);
    expect(validateGeneratedOutput(commit, "a\n\n---\n\nb\n\n---\n\nc")).toEqual(["a", "b", "c"]);
  });

  test("text_list: caps at requested/maxListItems", () => {
    const many = Array.from({ length: 9 }, (_, i) => `c${i}`).join("\n---\n");
    const out = validateGeneratedOutput(commit, many, 2);
    expect(out).toEqual(["c0", "c1"]);
    expect(validateGeneratedOutput(commit, '["1","2","3","4","5","6"]', 9)).toHaveLength(5);
  });

  test("pr_content: JSON object and first-line fallback", () => {
    expect(validateGeneratedOutput(pr, '```json\n{"title":"T","body":"B"}\n```')).toEqual({
      title: "T",
      body: "B",
    });
    expect(validateGeneratedOutput(pr, "My PR\n\nbody text")).toEqual({
      title: "My PR",
      body: "body text",
    });
    expect(validateGeneratedOutput(pr, "# Heading Title\n\nbody")).toEqual({
      title: "Heading Title",
      body: "body",
    });
  });

  test("pr_content: rejects malformed JSON and empty parts", () => {
    try {
      validateGeneratedOutput(pr, '{"title":"T"}');
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("output_invalid_json");
    }
    try {
      validateGeneratedOutput(pr, '{"title":"T","body":""}');
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("output_empty");
    }
  });
});

describe("markers", () => {
  test("extractMarkedResult takes the last line-anchored marker block", () => {
    const noise = `prompt echo\n${MARKER_OPEN}\nfirst\n${MARKER_CLOSE}\nmore\n${MARKER_OPEN}\nsecond\n${MARKER_CLOSE}\ntail`;
    expect(extractMarkedResult(noise)).toBe("second");
    expect(extractMarkedResult("no markers")).toBeNull();
    expect(extractMarkedResult(`${MARKER_OPEN} unclosed`)).toBeNull();
  });

  test("tolerates TUI decorations and dedents the captured block", () => {
    // Codex renders replies indented behind a `• ` bullet.
    const decorated =
      "noise\n• <<<TEXTGEN_RESULT>>>\n  line one\n  line two\n  <<<TEXTGEN_END>>>\ntail";
    expect(extractMarkedResult(decorated)).toBe("line one\nline two");
    const quoted =
      "Wrap your answer between <<<TEXTGEN_RESULT>>> and <<<TEXTGEN_END>>> lines.\n" +
      "Real answer here without markers.";
    expect(extractMarkedResult(quoted)).toBeNull();
  });

  test("inline marker mentions (model quoting instructions) are ignored", () => {
    // The failure mode seen in real verification: the model echoes the
    // instruction "between <<<TEXTGEN_RESULT>>> and <<<TEXTGEN_END>>>"
    // mid-sentence — markers not on their own lines must not match.
    const quoted =
      "Wrap your answer between <<<TEXTGEN_RESULT>>> and <<<TEXTGEN_END>>> lines.\n" +
      "Real answer here without markers.";
    expect(extractMarkedResult(quoted)).toBeNull();
  });
});

describe("prompts", () => {
  test("agent prompts carry markers; api prompts do not", () => {
    const spec = taskSpec("thread_title");
    const marked = buildPrompt(spec, { context: "ctx" }, { marked: true });
    const plain = buildPrompt(spec, { context: "ctx" }, { marked: false });
    expect(marked.user).toContain(MARKER_OPEN);
    expect(plain.user).not.toContain(MARKER_OPEN);
    expect(marked.system.length).toBeGreaterThan(0);
  });
});

describe("config", () => {
  test("normalizeConfig defaults and drops malformed generators", () => {
    const { config, warnings } = normalizeConfig({
      apiGenerators: [
        { id: "ok", kind: "openai", endpoint: "https://api.openai.com", enabled: true },
        { id: "bad", kind: "nope", endpoint: "x" },
        "junk",
      ],
      defaultProvider: "agent:claude",
    });
    expect(config.apiGenerators).toHaveLength(1);
    expect(config.apiGenerators[0]?.enabled).toBe(true);
    expect(config.defaultProvider).toBe("agent:claude");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("generators are disabled unless enabled === true", () => {
    const parsed = parseApiGenerator({
      id: "x",
      kind: "openai",
      endpoint: "https://api.openai.com",
    });
    expect(parsed?.enabled).toBe(false);
  });

  test("resolveApiKey: env wins, then key file, then null", async () => {
    const dir = tempDir();
    const gen = apiGen({ keyEnv: "TEXTGEN_TEST_KEY_UNIQUE" });
    delete process.env.TEXTGEN_TEST_KEY_UNIQUE;
    expect(await resolveApiKey(gen, dir)).toBeNull();

    mkdirSync(path.join(dir, "keys"), { recursive: true });
    writeFileSync(path.join(dir, "keys", "test.key"), "file-key\n");
    expect(await resolveApiKey(gen, dir)).toBe("file-key");

    process.env.TEXTGEN_TEST_KEY_UNIQUE = "env-key";
    try {
      expect(await resolveApiKey(gen, dir)).toBe("env-key");
    } finally {
      delete process.env.TEXTGEN_TEST_KEY_UNIQUE;
    }
  });
});

describe("api transport helpers", () => {
  test("endpointAllowed enforces https / loopback http", () => {
    expect(endpointAllowed("https://api.openai.com").ok).toBe(true);
    expect(endpointAllowed("http://127.0.0.1:8080/v1").ok).toBe(true);
    expect(endpointAllowed("http://localhost:11434/v1").ok).toBe(true);
    expect(endpointAllowed("http://evil.example.com").ok).toBe(false);
    expect(endpointAllowed("ftp://x").ok).toBe(false);
    expect(endpointAllowed("not a url").ok).toBe(false);
  });

  test("apiRequestUrl appends kind paths", () => {
    expect(apiRequestUrl(apiGen({ endpoint: "https://api.openai.com" }))).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(apiRequestUrl(apiGen({ endpoint: "https://api.openai.com/v1" }))).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(
      apiRequestUrl(apiGen({ kind: "anthropic", endpoint: "https://api.anthropic.com" })),
    ).toBe("https://api.anthropic.com/v1/messages");
    expect(
      apiRequestUrl(apiGen({ kind: "anthropic", endpoint: "https://gw.example.com/v1" })),
    ).toBe("https://gw.example.com/v1/messages");
  });

  test("extractApiText handles openai and anthropic shapes", () => {
    const gen = apiGen();
    expect(extractApiText(gen, { choices: [{ message: { content: "hi" } }] })).toBe("hi");
    expect(
      extractApiText(gen, {
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
            },
          },
        ],
      }),
    ).toBe("a\nb");
    const anth = apiGen({ kind: "anthropic" });
    expect(extractApiText(anth, { content: [{ type: "text", text: "hello" }] })).toBe("hello");
    expect(extractApiText(gen, {})).toBeNull();
  });
});

describe("provider resolution", () => {
  const commit = taskSpec("commit_message");
  const review = taskSpec("review_guide");

  test("explicit agent and api refs", () => {
    const config = baseConfig({
      apiGenerators: [apiGen({ id: "openai" })],
    });
    const agent = resolveProvider(commit, { provider: "agent:codex", config });
    expect(agent.id).toBe("agent:codex");
    expect(agent.path).toBe("agent");
    const api = resolveProvider(commit, { provider: "api:openai", config });
    expect(api.id).toBe("api:openai");
    expect(api.path).toBe("api");
    // bare name resolves api id too
    expect(resolveProvider(commit, { provider: "openai", config }).id).toBe("api:openai");
  });

  test("default prefers agent path over api", () => {
    const config = baseConfig({ apiGenerators: [apiGen()] });
    const resolved = resolveProvider(commit, {
      config,
      manifests: [{ agent: "codex" }],
    });
    expect(resolved.path).toBe("agent");
    expect(resolved.id).toBe("agent:codex");
  });

  test("defaultProvider is honored and must resolve", () => {
    const config = baseConfig({
      defaultProvider: "api:test",
      apiGenerators: [apiGen()],
    });
    expect(resolveProvider(commit, { config }).id).toBe("api:test");
    const bad = baseConfig({ defaultProvider: "api:missing" });
    try {
      resolveProvider(commit, { config: bad });
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("provider_unknown");
    }
  });

  test("agent-only tasks reject api providers", () => {
    const config = baseConfig({ apiGenerators: [apiGen()] });
    try {
      resolveProvider(review, { provider: "api:test", config });
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("provider_path_unsupported");
    }
    // but default resolution still finds agent kinds
    expect(resolveProvider(review, { config }).path).toBe("agent");
  });

  test("disabled api generators cannot be resolved", () => {
    const config = baseConfig({
      apiGenerators: [apiGen({ enabled: false })],
    });
    try {
      resolveProvider(commit, { provider: "api:test", config });
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("provider_unknown");
    }
  });

  test("unknown provider and empty provider set error structurally", () => {
    const config = baseConfig();
    try {
      resolveProvider(commit, { provider: "agent:nosuchkind", config });
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("provider_unknown");
    }
    // bare unknown name
    try {
      resolveProvider(commit, { provider: "bogus", config });
      expect.unreachable();
    } catch (err) {
      expect((err as TextgenError).code).toBe("provider_unknown");
    }
  });
});

// --- agent transport fake -------------------------------------------------------

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

function fakeTransport(
  handler: (method: string, params: Record<string, unknown>) => Record<string, unknown>,
): { transport: AgentTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    transport: {
      call: async (method, params) => {
        calls.push({ method, params });
        return handler(method, params);
      },
    },
  };
}

const AGENT_READ_TEXT = `noise\n${MARKER_OPEN}\nGenerated Title\n${MARKER_CLOSE}\ntrailer`;

function happyAgentHandler(method: string): Record<string, unknown> {
  switch (method) {
    case "workspace.create":
      return {
        workspace: { workspace_id: "w1" },
        tab: { tab_id: "t1" },
        root_pane: { pane_id: "p1" },
      };
    case "agent.start":
      return {
        type: "agent_started",
        agent: { name: "a1", agent_status: "idle", pane_id: "p1" },
        argv: ["claude"],
      };
    case "agent.prompt":
      return { type: "agent_prompted", agent: { name: "a1", agent_status: "idle" } };
    case "agent.read":
      return { type: "pane_read", read: { pane_id: "p1", text: AGENT_READ_TEXT } };
    case "workspace.close":
      return { type: "workspace_closed" };
    default:
      return {};
  }
}

describe("agent-pane executor", () => {
  test("happy path: create → start → prompt → read → close", async () => {
    const { transport, calls } = fakeTransport(happyAgentHandler);
    const result = await executeAgentPrompt(transport, {
      kind: "claude",
      name: "a1",
      prompt: buildPrompt(taskSpec("thread_title"), { context: "ctx" }, { marked: true }),
      startupTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      readLines: 100,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "workspace.create",
      "agent.start",
      "agent.prompt",
      "agent.read",
      "workspace.close",
    ]);
    expect(result.markedText).toContain("Generated Title");
    expect(result.workspaceId).toBe("w1");
    const promptCall = calls.find((c) => c.method === "agent.prompt");
    expect(String(promptCall?.params.text)).toContain(MARKER_OPEN);
  });

  test("cleans up workspace when agent.start fails", async () => {
    const { transport, calls } = fakeTransport((method) => {
      if (method === "agent.start") throw new Error("kind not installed");
      return happyAgentHandler(method);
    });
    await expect(
      executeAgentPrompt(transport, {
        kind: "nosuch",
        name: "a1",
        prompt: buildPrompt(taskSpec("thread_title"), { context: "ctx" }, { marked: true }),
        startupTimeoutMs: 5_000,
        promptTimeoutMs: 5_000,
        readLines: 100,
      }),
    ).rejects.toMatchObject({ code: "agent_start_failed" });
    expect(calls.map((c) => c.method)).toContain("workspace.close");
  });

  test("blocked agent status is a structured error", async () => {
    const { transport } = fakeTransport((method) => {
      if (method === "agent.prompt") {
        return { type: "agent_prompted", agent: { name: "a1", agent_status: "blocked" } };
      }
      return happyAgentHandler(method);
    });
    await expect(
      executeAgentPrompt(transport, {
        kind: "claude",
        name: "a1",
        prompt: buildPrompt(taskSpec("thread_title"), { context: "ctx" }, { marked: true }),
        startupTimeoutMs: 5_000,
        promptTimeoutMs: 5_000,
        readLines: 100,
      }),
    ).rejects.toMatchObject({ code: "agent_blocked" });
  });

  test("unmarked output returns markedText null (caller decides)", async () => {
    const { transport } = fakeTransport((method) => {
      if (method === "agent.read") {
        return { type: "pane_read", read: { pane_id: "p1", text: "no markers here" } };
      }
      return happyAgentHandler(method);
    });
    const result = await executeAgentPrompt(transport, {
      kind: "claude",
      name: "a1",
      prompt: buildPrompt(taskSpec("thread_title"), { context: "ctx" }, { marked: true }),
      startupTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      readLines: 100,
    });
    expect(result.markedText).toBeNull();
  });
});

// --- api executor ----------------------------------------------------------------

function fakeFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; seen: { url: string; auth: string | null; body: string }[] } {
  const seen: { url: string; auth: string | null; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    seen.push({
      url: u,
      auth: headers.get("authorization") ?? headers.get("x-api-key"),
      body: String(init?.body ?? ""),
    });
    const out = handler(u, init ?? {});
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("api executor", () => {
  const prompt = buildPrompt(taskSpec("thread_title"), { context: "ctx" });

  test("openai-compatible: posts chat completions with bearer key", async () => {
    const dir = tempDir();
    const gen = apiGen({ keyEnv: "TEXTGEN_API_TEST_KEY" });
    process.env.TEXTGEN_API_TEST_KEY = "secret-key-123";
    const { fetchImpl, seen } = fakeFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: "A Title" } }] },
    }));
    try {
      const result = await executeApiPrompt({
        generator: gen,
        model: "m1",
        prompt,
        fetchImpl,
        configDir: dir,
      });
      expect(result.text).toBe("A Title");
      expect(seen[0]?.url).toBe("http://127.0.0.1:9999/v1/chat/completions");
      expect(seen[0]?.auth).toBe("Bearer secret-key-123");
      expect(seen[0]?.body).toContain("concise thread title");
    } finally {
      delete process.env.TEXTGEN_API_TEST_KEY;
    }
  });

  test("anthropic: x-api-key header and /v1/messages", async () => {
    const dir = tempDir();
    const gen = apiGen({
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      keyEnv: "TEXTGEN_ANTH_KEY",
    });
    process.env.TEXTGEN_ANTH_KEY = "ant-key";
    const { fetchImpl, seen } = fakeFetch(() => ({
      status: 200,
      body: { content: [{ type: "text", text: "Anthropic says hi" }] },
    }));
    try {
      const result = await executeApiPrompt({
        generator: gen,
        model: "claude-x",
        prompt,
        fetchImpl,
        configDir: dir,
      });
      expect(result.text).toBe("Anthropic says hi");
      expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/messages");
      expect(seen[0]?.auth).toBe("ant-key");
    } finally {
      delete process.env.TEXTGEN_ANTH_KEY;
    }
  });

  test("missing credential → no_credential, fetch never called", async () => {
    const dir = tempDir();
    const gen = apiGen({ keyEnv: "TEXTGEN_MISSING_KEY_XYZ" });
    delete process.env.TEXTGEN_MISSING_KEY_XYZ;
    const { fetchImpl, seen } = fakeFetch(() => ({ status: 200, body: {} }));
    await expect(
      executeApiPrompt({ generator: gen, model: "m", prompt, fetchImpl, configDir: dir }),
    ).rejects.toMatchObject({ code: "no_credential" });
    expect(seen).toHaveLength(0);
  });

  test("insecure endpoint rejected before key read", async () => {
    const dir = tempDir();
    const gen = apiGen({ endpoint: "http://evil.example.com", keyEnv: "TEXTGEN_ANY_KEY" });
    process.env.TEXTGEN_ANY_KEY = "k";
    const { fetchImpl, seen } = fakeFetch(() => ({ status: 200, body: {} }));
    try {
      await expect(
        executeApiPrompt({ generator: gen, model: "m", prompt, fetchImpl, configDir: dir }),
      ).rejects.toMatchObject({ code: "provider_endpoint_insecure" });
      expect(seen).toHaveLength(0);
    } finally {
      delete process.env.TEXTGEN_ANY_KEY;
    }
  });

  test("HTTP error → api_request_failed with status only", async () => {
    const dir = tempDir();
    const gen = apiGen({ keyEnv: "TEXTGEN_ERR_KEY" });
    process.env.TEXTGEN_ERR_KEY = "k";
    const { fetchImpl } = fakeFetch(() => ({
      status: 429,
      body: { error: "rate limited secret-echo" },
    }));
    try {
      await expect(
        executeApiPrompt({ generator: gen, model: "m", prompt, fetchImpl, configDir: dir }),
      ).rejects.toMatchObject({ code: "api_request_failed", details: { status: 429 } });
    } finally {
      delete process.env.TEXTGEN_ERR_KEY;
    }
  });

  test("non-JSON / textless responses → api_bad_response", async () => {
    const dir = tempDir();
    const gen = apiGen({ keyEnv: "TEXTGEN_BAD_KEY" });
    process.env.TEXTGEN_BAD_KEY = "k";
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { choices: [] } }));
    try {
      await expect(
        executeApiPrompt({ generator: gen, model: "m", prompt, fetchImpl, configDir: dir }),
      ).rejects.toMatchObject({ code: "api_bad_response" });
    } finally {
      delete process.env.TEXTGEN_BAD_KEY;
    }
  });
});

describe("generate pipeline", () => {
  test("api path end-to-end with validated output", async () => {
    const dir = tempDir();
    const gen = apiGen({ keyEnv: "TEXTGEN_PIPE_KEY" });
    process.env.TEXTGEN_PIPE_KEY = "pipe-key";
    const config = baseConfig({ apiGenerators: [gen], defaultProvider: "api:test" });
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: "feat(x): do thing" } }] },
    }));
    try {
      const out = await generate({
        task: "commit_message",
        input: { diff: "diff --git a/x b/x" },
        config,
        fetchImpl,
        configDir: dir,
      });
      expect(out.ok).toBe(true);
      expect(out.provider).toBe("api:test");
      expect(out.path).toBe("api");
      expect(out.result).toEqual(["feat(x): do thing"]);
    } finally {
      delete process.env.TEXTGEN_PIPE_KEY;
    }
  });

  test("agent path end-to-end extracts marked output", async () => {
    const { transport } = fakeTransport(happyAgentHandler);
    const config = baseConfig({ defaultProvider: "agent:claude" });
    const out = await generate({
      task: "thread_title",
      input: { context: "we discussed stuff" },
      config,
      agentTransport: transport,
    });
    expect(out.result).toBe("Generated Title");
    expect(out.path).toBe("agent");
  });

  test("unmarked agent output → output_unmarked", async () => {
    const { transport } = fakeTransport((method) => {
      if (method === "agent.read") {
        return { type: "pane_read", read: { pane_id: "p1", text: "garbage" } };
      }
      return happyAgentHandler(method);
    });
    const config = baseConfig({ defaultProvider: "agent:claude" });
    await expect(
      generate({
        task: "thread_title",
        input: { context: "ctx" },
        config,
        agentTransport: transport,
      }),
    ).rejects.toMatchObject({ code: "output_unmarked" });
  });

  test("secret in input fails before any provider call", async () => {
    const config = baseConfig({ defaultProvider: "agent:claude" });
    const { transport, calls } = fakeTransport(happyAgentHandler);
    await expect(
      generate({
        task: "thread_title",
        input: { context: "key is sk-abcdefghijklmnopqrstuvwxyz123456" },
        config,
        agentTransport: transport,
      }),
    ).rejects.toMatchObject({ code: "input_secret_detected" });
    expect(calls).toHaveLength(0);
  });

  test("invalid provider output fails validation", async () => {
    const { transport } = fakeTransport((method) => {
      if (method === "agent.read") {
        return {
          type: "pane_read",
          read: {
            pane_id: "p1",
            text: `${MARKER_OPEN}\n${"x".repeat(500)}\n${MARKER_CLOSE}`,
          },
        };
      }
      return happyAgentHandler(method);
    });
    const config = baseConfig({ defaultProvider: "agent:claude" });
    await expect(
      generate({
        task: "thread_title",
        input: { context: "ctx" },
        config,
        agentTransport: transport,
      }),
    ).rejects.toMatchObject({ code: "output_too_long" });
  });
});
