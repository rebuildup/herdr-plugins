import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentTransport } from "../plugins/textgen/src/agent";
import type { ApiGeneratorConfig, TextgenConfig } from "../plugins/textgen/src/config";
import { type GenerateSuccess, generate } from "../plugins/textgen/src/generate";
import { TextgenError, taskSpec } from "../plugins/textgen/src/model";
import { MARKER_CLOSE, MARKER_OPEN } from "../plugins/textgen/src/prompts";
import {
  parseUsageQuotaPayload,
  probeUsageQuota,
  USAGE_CONTRACT,
} from "../plugins/textgen/src/quota";
import {
  type WatchEventSource,
  type WatchNextPromptDeps,
  type WatchNextPromptOptions,
  watchNextPrompt,
} from "../plugins/textgen/src/watch";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "textgen-t3-"));
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

const REVIEW_TEXT = `noise\n${MARKER_OPEN}\n## Review guide\n\nCheck auth flow.\n${MARKER_CLOSE}\ntail`;
const PROMPT_TEXT = `noise\n${MARKER_OPEN}\nRun the tests next\n${MARKER_CLOSE}`;

function agentHandler(readText: string, agentName = "a1") {
  return (method: string, params: Record<string, unknown>): Record<string, unknown> => {
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
          agent: { name: params.name ?? agentName, agent_status: "idle", pane_id: "p1" },
        };
      case "agent.prompt":
        return {
          type: "agent_prompted",
          agent: { name: params.target ?? agentName, agent_status: "idle" },
        };
      case "agent.read":
        return { type: "pane_read", read: { pane_id: "p1", text: readText } };
      case "workspace.close":
        return { type: "workspace_closed" };
      default:
        return {};
    }
  };
}

// --- guards ---------------------------------------------------------------------

describe("generation guards", () => {
  const reviewInput = { target: "PR #42 diff" };

  test("review_guide without opt-in → task_not_opted_in, no pane spawned", async () => {
    const { transport, calls } = fakeTransport(agentHandler(REVIEW_TEXT));
    const config = baseConfig({ defaultProvider: "agent:claude" });
    await expect(
      generate({
        task: "review_guide",
        input: reviewInput,
        config,
        agentTransport: transport,
      }),
    ).rejects.toMatchObject({ code: "task_not_opted_in", kind: "policy" });
    expect(calls).toHaveLength(0);
  });

  test("review_guide with --allow-expensive equivalent proceeds", async () => {
    const { transport, calls } = fakeTransport(agentHandler(REVIEW_TEXT));
    const config = baseConfig({ defaultProvider: "agent:claude" });
    const out = await generate({
      task: "review_guide",
      input: reviewInput,
      config,
      agentTransport: transport,
      allowExpensive: true,
    });
    expect(out.ok).toBe(true);
    expect(out.result).toContain("Review guide");
    expect(calls.map((c) => c.method)).toContain("workspace.close");
  });

  test("review_guide with config opt-in proceeds", async () => {
    const { transport } = fakeTransport(agentHandler(REVIEW_TEXT));
    const config = baseConfig({
      defaultProvider: "agent:claude",
      guards: {
        expensiveTaskOptIn: true,
        quota: { enabled: false, maxUsedPercent: 95, timeoutMs: 10_000 },
      },
    });
    const out = await generate({
      task: "review_guide",
      input: reviewInput,
      config,
      agentTransport: transport,
    });
    expect(out.ok).toBe(true);
  });

  test("agent-only task uses its per-task default timeout", async () => {
    const { transport, calls } = fakeTransport(agentHandler(REVIEW_TEXT));
    const config = baseConfig({
      defaultProvider: "agent:claude",
      // config default is tiny; the task default (600s) must win.
      agent: { startupTimeoutMs: 5_000, promptTimeoutMs: 5_000, readLines: 100 },
    });
    await generate({
      task: "review_guide",
      input: reviewInput,
      config,
      agentTransport: transport,
      allowExpensive: true,
    });
    const promptCall = calls.find((c) => c.method === "agent.prompt");
    const wait = promptCall?.params.wait as { timeout_ms?: number } | undefined;
    expect(wait?.timeout_ms).toBe(taskSpec("review_guide").defaultTimeoutMs);
  });

  test("explicit --timeout overrides the task default", async () => {
    const { transport, calls } = fakeTransport(agentHandler(REVIEW_TEXT));
    const config = baseConfig({ defaultProvider: "agent:claude" });
    await generate({
      task: "review_guide",
      input: reviewInput,
      config,
      agentTransport: transport,
      allowExpensive: true,
      timeoutMs: 42_000,
    });
    const promptCall = calls.find((c) => c.method === "agent.prompt");
    const wait = promptCall?.params.wait as { timeout_ms?: number } | undefined;
    expect(wait?.timeout_ms).toBe(42_000);
  });

  test("manifests present but kind missing → provider_unavailable", async () => {
    const { transport, calls } = fakeTransport(agentHandler(PROMPT_TEXT));
    const config = baseConfig({ defaultProvider: "agent:claude" });
    await expect(
      generate({
        task: "next_prompt",
        input: { context: "ctx" },
        config,
        agentTransport: transport,
        manifests: [{ agent: "codex" }],
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable", kind: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  test("manifests unreachable → warning, generation proceeds", async () => {
    const { transport } = fakeTransport(agentHandler(PROMPT_TEXT));
    const config = baseConfig({ defaultProvider: "agent:claude" });
    const out = await generate({
      task: "next_prompt",
      input: { context: "ctx" },
      config,
      agentTransport: transport,
      // manifests omitted = unreachable
    });
    expect(out.result).toBe("Run the tests next");
    expect(out.warnings).toContain("agent_availability_unverified");
  });

  test("quota guard blocks at threshold", async () => {
    const { transport, calls } = fakeTransport(agentHandler(PROMPT_TEXT));
    const config = baseConfig({
      defaultProvider: "agent:claude",
      guards: {
        expensiveTaskOptIn: false,
        quota: { enabled: true, maxUsedPercent: 90, timeoutMs: 10_000 },
      },
    });
    await expect(
      generate({
        task: "next_prompt",
        input: { context: "ctx" },
        config,
        agentTransport: transport,
        quotaProbe: async () => ({
          status: "ok",
          maxUsedPercent: 97,
          provider: "claude",
          windowIds: ["session"],
        }),
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded", kind: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  test("quota guard passes below threshold", async () => {
    const { transport } = fakeTransport(agentHandler(PROMPT_TEXT));
    const config = baseConfig({
      defaultProvider: "agent:claude",
      guards: {
        expensiveTaskOptIn: false,
        quota: { enabled: true, maxUsedPercent: 95, timeoutMs: 10_000 },
      },
    });
    const out = await generate({
      task: "next_prompt",
      input: { context: "ctx" },
      config,
      agentTransport: transport,
      quotaProbe: async () => ({
        status: "ok",
        maxUsedPercent: 40,
        provider: "claude",
        windowIds: ["session"],
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.warnings).not.toContainEqual(expect.stringContaining("quota_check_unavailable"));
  });

  test("quota probe failure degrades to warning, never blocks", async () => {
    const { transport } = fakeTransport(agentHandler(PROMPT_TEXT));
    const config = baseConfig({
      defaultProvider: "agent:claude",
      guards: {
        expensiveTaskOptIn: false,
        quota: { enabled: true, maxUsedPercent: 95, timeoutMs: 10_000 },
      },
    });
    const out = await generate({
      task: "next_prompt",
      input: { context: "ctx" },
      config,
      agentTransport: transport,
      quotaProbe: async () => ({
        status: "unavailable",
        reason: "plugin_unresolved",
        detail: "rebuildup.usage plugin not found",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w) => w.startsWith("quota_check_unavailable"))).toBe(true);
  });

  test("quota probe throw degrades to warning", async () => {
    const { transport } = fakeTransport(agentHandler(PROMPT_TEXT));
    const config = baseConfig({
      defaultProvider: "agent:claude",
      guards: {
        expensiveTaskOptIn: false,
        quota: { enabled: true, maxUsedPercent: 95, timeoutMs: 10_000 },
      },
    });
    const out = await generate({
      task: "next_prompt",
      input: { context: "ctx" },
      config,
      agentTransport: transport,
      quotaProbe: async () => {
        throw new Error("boom");
      },
    });
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w) => w.includes("boom"))).toBe(true);
  });

  test("quota probe is not consulted on the api path", async () => {
    let probed = false;
    const gen: ApiGeneratorConfig = {
      id: "test",
      kind: "openai-compatible",
      endpoint: "http://127.0.0.1:9999/v1",
      model: "m",
      enabled: true,
      keyEnv: "TEXTGEN_T3_KEY",
    };
    process.env.TEXTGEN_T3_KEY = "k";
    const config = baseConfig({
      defaultProvider: "api:test",
      apiGenerators: [gen],
      guards: {
        expensiveTaskOptIn: false,
        quota: { enabled: true, maxUsedPercent: 1, timeoutMs: 10_000 },
      },
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Title" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const out = await generate({
        task: "thread_title",
        input: { context: "ctx" },
        config,
        fetchImpl,
        configDir: tempDir(),
        quotaProbe: async () => {
          probed = true;
          return { status: "ok", maxUsedPercent: 100, provider: "x", windowIds: [] };
        },
      });
      expect(out.ok).toBe(true);
      expect(probed).toBe(false);
    } finally {
      delete process.env.TEXTGEN_T3_KEY;
    }
  });
});

// --- usage quota probe ------------------------------------------------------------

describe("usage quota probe", () => {
  function usagePluginRoot(): string {
    const dir = tempDir();
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "herdr-plugin.toml"),
      'id = "rebuildup.usage"\nname = "Usage"\nversion = "0.5.0"\n',
    );
    writeFileSync(path.join(dir, "src", "cli.ts"), "// stub\n");
    return dir;
  }

  test("parseUsageQuotaPayload extracts max used_percent", () => {
    const parsed = parseUsageQuotaPayload(
      {
        contract: USAGE_CONTRACT,
        providers: [
          {
            provider: "claude",
            status: "ok",
            windows: [
              { id: "session", used_percent: 42 },
              { id: "weekly", used_percent: 87.5 },
            ],
          },
        ],
      },
      "claude",
    );
    expect(parsed).toEqual({ maxUsedPercent: 87.5, windowIds: ["weekly"] });
  });

  test("parseUsageQuotaPayload: non-ok status and missing provider", () => {
    expect(
      parseUsageQuotaPayload(
        {
          contract: USAGE_CONTRACT,
          providers: [{ provider: "codex", status: "no_credential", windows: [] }],
        },
        "codex",
      ),
    ).toEqual({ reason: "no_credential" });
    expect(
      parseUsageQuotaPayload({ contract: USAGE_CONTRACT, providers: [] }, "gemini"),
    ).toBeNull();
    expect(parseUsageQuotaPayload({ contract: "other/v9", providers: [] }, "x")).toBeNull();
  });

  test("probeUsageQuota runs the sibling CLI and maps the result", async () => {
    const root = usagePluginRoot();
    const seen: { args: string[] }[] = [];
    const result = await probeUsageQuota("claude", {
      usagePluginRoot: root,
      timeoutMs: 5_000,
      run: async (_root, args) => {
        seen.push({ args });
        return {
          status: 0,
          stdout: "",
          stderr: "",
          json: {
            contract: USAGE_CONTRACT,
            providers: [
              {
                provider: "claude",
                status: "ok",
                windows: [{ id: "session", used_percent: 55 }],
              },
            ],
          },
        };
      },
    });
    expect(seen[0]?.args).toEqual(["quota", "--provider", "claude"]);
    expect(result).toMatchObject({ status: "ok", maxUsedPercent: 55, provider: "claude" });
  });

  test("probeUsageQuota degrades on CLI failure and contract mismatch", async () => {
    const root = usagePluginRoot();
    const failed = await probeUsageQuota("claude", {
      usagePluginRoot: root,
      timeoutMs: 5_000,
      run: async () => ({ status: 1, stdout: "", stderr: "boom", json: null }),
    });
    expect(failed.status).toBe("unavailable");

    const mismatched = await probeUsageQuota("claude", {
      usagePluginRoot: root,
      timeoutMs: 5_000,
      run: async () => ({
        status: 0,
        stdout: "",
        stderr: "",
        json: { contract: "wrong/v0", providers: [] },
      }),
    });
    expect(mismatched).toMatchObject({ status: "unavailable", reason: "contract_mismatch" });
  });

  test("probeUsageQuota reports unsupported providers honestly", async () => {
    const root = usagePluginRoot();
    const result = await probeUsageQuota("gemini", {
      usagePluginRoot: root,
      timeoutMs: 5_000,
      run: async () => ({
        status: 0,
        stdout: "",
        stderr: "",
        json: {
          contract: USAGE_CONTRACT,
          providers: [{ provider: "gemini", status: "unsupported", windows: [] }],
        },
      }),
    });
    expect(result).toMatchObject({ status: "unavailable", reason: "unsupported" });
  });
});

// --- watch-next-prompt -------------------------------------------------------------

interface FakeEvent {
  event: string;
  data: unknown;
}

function fakeSource(events: FakeEvent[]): {
  source: WatchEventSource;
  closed: () => boolean;
} {
  let closed = false;
  let index = 0;
  const iterable: AsyncIterable<{ event: string; data: unknown }> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (index >= events.length) return { value: undefined, done: true };
          const value = events[index];
          index += 1;
          return { value: value as { event: string; data: unknown }, done: false };
        },
      };
    },
  };
  return {
    closed: () => closed,
    source: {
      started: Promise.resolve({}),
      events: iterable,
      close: () => {
        closed = true;
      },
    },
  };
}

function statusEvent(status: string, paneId = "w1:p1"): FakeEvent {
  return {
    event: "pane.agent_status_changed",
    data: { pane_id: paneId, agent_status: status },
  };
}

function cannedSuccess(result: string): GenerateSuccess {
  return {
    contract: "herdr-plugins.textgen/v1",
    command: "generate",
    ok: true,
    task: "next_prompt",
    provider: "agent:claude",
    path: "agent",
    model: null,
    result,
    elapsed_ms: 1,
    warnings: [],
  };
}

function cannedGenerate(result = "Run the tests"): {
  fn: WatchNextPromptDeps["generate"];
  calls: Parameters<WatchNextPromptDeps["generate"]>[0][];
} {
  const calls: Parameters<WatchNextPromptDeps["generate"]>[0][] = [];
  return {
    calls,
    fn: async (options) => {
      calls.push(options);
      return cannedSuccess(result);
    },
  };
}

function watchDeps(overrides?: Partial<WatchNextPromptDeps> & { seedStatus?: string | null }): {
  deps: WatchNextPromptDeps;
  lines: Record<string, unknown>[];
  metadata: { paneId: string; tokens: Record<string, string | null> }[];
} {
  const lines: Record<string, unknown>[] = [];
  const metadata: { paneId: string; tokens: Record<string, string | null> }[] = [];
  const { fn } = cannedGenerate();
  const { seedStatus, ...depOverrides } = overrides ?? {};
  const seed = seedStatus === undefined ? "working" : seedStatus;
  const deps: WatchNextPromptDeps = {
    transport: {
      call: async (method) => {
        if (method === "session.snapshot") {
          return {
            snapshot: {
              agents: seed === null ? {} : { "w1:p1": { pane_id: "w1:p1", agent_status: seed } },
            },
          };
        }
        if (method === "pane.read") {
          return { read: { pane_id: "w1:p1", text: "turn output\n$ " } };
        }
        return {};
      },
    },
    generate: fn,
    reportMetadata: async (paneId, tokens) => {
      metadata.push({ paneId, tokens });
      return {};
    },
    emit: (line) => lines.push(line),
    ...depOverrides,
  };
  return { deps, lines, metadata };
}

function watchOptions(overrides?: Partial<WatchNextPromptOptions>): WatchNextPromptOptions {
  return {
    paneId: "w1:p1",
    config: baseConfig({ defaultProvider: "agent:claude" }),
    debounceMs: 0,
    ...overrides,
  };
}

describe("watch-next-prompt", () => {
  test("working → idle triggers one generation, metadata recorded", async () => {
    const { source } = fakeSource([statusEvent("idle")]);
    const { deps, lines, metadata } = watchDeps();
    const summary = await watchNextPrompt(source, watchOptions(), deps);
    expect(summary.triggers).toBe(1);
    expect(summary.generated).toBe(1);
    expect(summary.stopped).toBe("stream_end");
    const generated = lines.find((l) => l.type === "next_prompt.generated");
    expect(generated?.result).toBe("Run the tests");
    expect(metadata).toEqual([
      { paneId: "w1:p1", tokens: { textgen_next_prompt: "Run the tests" } },
    ]);
  });

  test("context is read from the pane and passed as next_prompt input", async () => {
    const { source } = fakeSource([statusEvent("done")]);
    const seen: Record<string, unknown>[] = [];
    const { deps } = watchDeps({
      generate: async (options) => {
        seen.push(options.input);
        return cannedSuccess("next");
      },
    });
    await watchNextPrompt(source, watchOptions(), deps);
    expect(seen[0]?.context).toContain("turn output");
  });

  test("static --input context overrides the pane read", async () => {
    const { source } = fakeSource([statusEvent("idle")]);
    let readCalled = false;
    const seen: Record<string, unknown>[] = [];
    const { deps } = watchDeps({
      readContext: async () => {
        readCalled = true;
        return "pane text";
      },
      generate: async (options) => {
        seen.push(options.input);
        return cannedSuccess("next");
      },
    });
    await watchNextPrompt(
      source,
      watchOptions({ input: { context: "static ctx", instruction: "be terse" } }),
      deps,
    );
    expect(readCalled).toBe(false);
    expect(seen[0]).toEqual({ context: "static ctx", instruction: "be terse" });
  });

  test("idle → idle does not trigger", async () => {
    const { source } = fakeSource([statusEvent("idle"), statusEvent("idle")]);
    const { deps } = watchDeps({ seedStatus: "idle" });
    const summary = await watchNextPrompt(source, watchOptions(), deps);
    expect(summary.triggers).toBe(0);
    expect(summary.generated).toBe(0);
  });

  test("unknown → idle does not trigger (no observed working)", async () => {
    const { source } = fakeSource([statusEvent("idle")]);
    const { deps } = watchDeps({ seedStatus: null });
    const summary = await watchNextPrompt(source, watchOptions(), deps);
    expect(summary.triggers).toBe(0);
  });

  test("blocked → idle does not trigger (only working → settled)", async () => {
    const { source } = fakeSource([statusEvent("blocked"), statusEvent("idle")]);
    const { deps } = watchDeps();
    const summary = await watchNextPrompt(source, watchOptions(), deps);
    expect(summary.triggers).toBe(0);
  });

  test("other panes' events are ignored", async () => {
    const { source } = fakeSource([statusEvent("idle", "w9:p9")]);
    const { deps } = watchDeps();
    const summary = await watchNextPrompt(source, watchOptions(), deps);
    expect(summary.triggers).toBe(0);
  });

  test("snake_case event names are accepted", async () => {
    const { source } = fakeSource([
      { event: "pane_agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } },
    ]);
    const { deps } = watchDeps();
    const summary = await watchNextPrompt(source, watchOptions(), deps);
    expect(summary.generated).toBe(1);
  });

  test("debounce suppresses rapid repeat triggers", async () => {
    const { source } = fakeSource([
      statusEvent("idle"),
      statusEvent("working"),
      statusEvent("idle"),
    ]);
    const { deps, lines } = watchDeps();
    const summary = await watchNextPrompt(source, watchOptions({ debounceMs: 60_000 }), deps);
    expect(summary.triggers).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(lines.some((l) => l.type === "next_prompt.skipped")).toBe(true);
  });

  test("--once stops after the first trigger and closes the source", async () => {
    const { source, closed } = fakeSource([
      statusEvent("idle"),
      statusEvent("working"),
      statusEvent("idle"),
    ]);
    const { deps } = watchDeps();
    const summary = await watchNextPrompt(source, watchOptions({ once: true }), deps);
    expect(summary.stopped).toBe("once");
    expect(summary.triggers).toBe(1);
    expect(closed()).toBe(true);
  });

  test("--max-triggers stops the watch", async () => {
    const { source } = fakeSource([
      statusEvent("idle"),
      statusEvent("working"),
      statusEvent("idle"),
      statusEvent("working"),
      statusEvent("idle"),
    ]);
    const { deps } = watchDeps();
    const summary = await watchNextPrompt(
      source,
      watchOptions({ debounceMs: 0, maxTriggers: 2 }),
      deps,
    );
    expect(summary.triggers).toBe(2);
    expect(summary.stopped).toBe("max_triggers");
  });

  test("generation failure emits next_prompt.error and watch continues", async () => {
    const { source } = fakeSource([
      statusEvent("idle"),
      statusEvent("working"),
      statusEvent("idle"),
    ]);
    let calls = 0;
    const lines: Record<string, unknown>[] = [];
    const { deps } = watchDeps({
      emit: (line) => lines.push(line),
      generate: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TextgenError("quota_exceeded", "unavailable", "quota full", {
            used_percent: 99,
          });
        }
        return cannedSuccess("recovered");
      },
    });
    const summary = await watchNextPrompt(source, watchOptions({ debounceMs: 0 }), deps);
    expect(summary.errors).toBe(1);
    expect(summary.generated).toBe(1);
    const errLine = lines.find((l) => l.type === "next_prompt.error");
    expect(errLine?.code).toBe("quota_exceeded");
  });

  test("context read failure is a structured error event, not a crash", async () => {
    const { source } = fakeSource([statusEvent("idle")]);
    const lines: Record<string, unknown>[] = [];
    const { deps } = watchDeps({
      emit: (line) => lines.push(line),
      readContext: async () => {
        throw new Error("pane gone");
      },
    });
    const summary = await watchNextPrompt(source, watchOptions(), deps);
    expect(summary.errors).toBe(1);
    expect(lines.some((l) => l.type === "next_prompt.error" && l.stage === "context")).toBe(true);
  });

  test("end-to-end: real generate() drives the agent pane path", async () => {
    const { transport, calls } = fakeTransport(agentHandler(PROMPT_TEXT));
    const config = baseConfig({ defaultProvider: "agent:claude" });
    const { source } = fakeSource([statusEvent("idle")]);
    const metadata: { paneId: string; tokens: Record<string, string | null> }[] = [];
    const lines: Record<string, unknown>[] = [];

    const summary = await watchNextPrompt(source, watchOptions({ config }), {
      transport: {
        call: async (method, params) => {
          if (method === "session.snapshot") {
            return { snapshot: { agents: { "w1:p1": { agent_status: "working" } } } };
          }
          if (method === "pane.read") {
            return { read: { pane_id: "w1:p1", text: "conversation tail" } };
          }
          return transport.call(method, params);
        },
      },
      generate: (genOptions) => generate({ ...genOptions, agentTransport: transport }),
      reportMetadata: async (paneId, tokens) => {
        metadata.push({ paneId, tokens });
        return {};
      },
      emit: (line) => lines.push(line),
    });

    expect(summary.generated).toBe(1);
    // The dedicated generation workspace ran the full lifecycle.
    expect(calls.map((c) => c.method)).toEqual([
      "workspace.create",
      "agent.start",
      "agent.prompt",
      "agent.read",
      "workspace.close",
    ]);
    expect(metadata[0]?.tokens.textgen_next_prompt).toBe("Run the tests next");
  });
});
