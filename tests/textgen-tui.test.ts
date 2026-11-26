/**
 * Tests for the rebuildup.textgen TUI surface (#246,
 * contract docs/contracts/tui-v1.md).
 *
 * Covers the pure helpers (context pinning, pane-open params, mutation
 * gating, capability→view-model mapping, generate argv, field-value
 * resolution, result formatting, clipboard) and the view layer with a
 * fake CLI/ui — no real herdr session, no TTY required. A small
 * real-subprocess section exercises stdin JSON piping and the honest
 * error envelope without needing a provider.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ConfirmOptions,
  SelectItem,
  SelectListOptions,
  TextInputOptions,
} from "../packages/tui/src/components";
import { type KeyEvent, KeyParser } from "../packages/tui/src/input";
import type { Line, ScreenView } from "../packages/tui/src/screen";
import { TaskRunner } from "../packages/tui/src/task";
import {
  buildGenerateArgs,
  buildPaneOpenParams,
  capabilityTasks,
  configDefaults,
  copyToClipboard,
  errorLine,
  expensiveTaskOptIn,
  formatGenerateResult,
  formatTargetLabel,
  generateTimeoutMs,
  mutationAllowed,
  parsePluginContext,
  providerOptions,
  resolveFieldValue,
  resolvePinnedTarget,
  resultClipboardText,
  runTextgenCli,
  TextgenCliError,
} from "../plugins/textgen/src/tui-support";
import {
  effectiveTasks,
  ResultView,
  TaskListView,
  type TextgenTuiDeps,
  type TextgenTuiUi,
} from "../plugins/textgen/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const CAPABILITY = {
  contract: "herdr-plugins.textgen/v1",
  command: "capability",
  mutation_commands: [
    "generate",
    "watch-next-prompt",
    "config set-default-provider",
    "config set-default-model",
    "config add-api-generator",
    "config remove-api-generator",
  ],
  tasks: [
    {
      kind: "thread_title",
      description: "Short title summarizing a conversation/thread context.",
      paths: ["agent", "api"],
      input_fields: ["context", "instruction"],
      required_input: ["context"],
      output: "text",
      requires_opt_in: false,
    },
    {
      kind: "commit_message",
      description: "Conventional-commit-style message candidates.",
      paths: ["agent", "api"],
      input_fields: ["diff", "conventions", "instruction", "candidates"],
      required_input: ["diff"],
      output: "text_list",
      requires_opt_in: false,
    },
    {
      kind: "review_guide",
      description: "Read-only multi-step review guide.",
      paths: ["agent"],
      input_fields: ["target", "instructions", "cwd"],
      required_input: ["target"],
      output: "text",
      requires_opt_in: true,
    },
  ],
  providers: {
    agent: [
      {
        id: "agent:claude",
        path: "agent",
        kind: "claude",
        enabled: true,
        availability: "manifest",
      },
      {
        id: "agent:ghost",
        path: "agent",
        kind: "ghost",
        enabled: true,
        availability: "not_in_manifests",
      },
    ],
    api: [
      {
        id: "api:openai",
        path: "api",
        kind: "openai",
        endpoint: "https://api.openai.com",
        model: "gpt-4o-mini",
        enabled: false,
        credential_configured: false,
      },
    ],
  },
  guards: { expensive_task_opt_in: false },
  config: { defaultProvider: "agent:claude", defaultModel: null },
};

const GENERATE_PAYLOAD = {
  contract: "herdr-plugins.textgen/v1",
  command: "generate",
  ok: true,
  task: "thread_title",
  provider: "agent:claude",
  path: "agent",
  model: null,
  result: "Fix the flaky test",
  elapsed_ms: 1234,
  warnings: ["agent_availability_unverified"],
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends TextgenTuiUi {
  statuses: string[];
  confirms: ConfirmOptions[];
  prompts: string[];
  pushed: ScreenView[];
  confirmResults: boolean[];
  promptResults: Array<string | null>;
  selectResult: SelectItem<unknown> | null;
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    statuses: [],
    confirms: [],
    prompts: [],
    pushed: [],
    confirmResults: [],
    promptResults: [],
    selectResult: null,
    confirm(opts: ConfirmOptions) {
      ui.confirms.push(opts);
      return Promise.resolve(ui.confirmResults.shift() ?? true);
    },
    prompt(text: string, _opts?: TextInputOptions) {
      ui.prompts.push(text);
      return Promise.resolve(ui.promptResults.shift() ?? null);
    },
    select<T>(_opts: SelectListOptions<T>) {
      return Promise.resolve(ui.selectResult as SelectItem<T> | null);
    },
    setStatus(left: string) {
      ui.statuses.push(left);
    },
    push(view: ScreenView) {
      ui.pushed.push(view);
    },
    pop() {
      return ui.pushed.pop();
    },
    tasks: new TaskRunner(),
    invalidate() {},
    close() {
      return Promise.resolve();
    },
  };
  return ui;
}

type CliHandler = (
  args: readonly string[],
  options?: { input?: string },
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function fakeCli(handler: CliHandler): {
  calls: string[][];
  inputs: Array<string | undefined>;
  fn: TextgenTuiDeps["cli"];
} {
  const calls: string[][] = [];
  const inputs: Array<string | undefined> = [];
  return {
    calls,
    inputs,
    fn: (args, options) => {
      calls.push([...args]);
      inputs.push(options?.input);
      try {
        return Promise.resolve(handler(args, options));
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}

function makeDeps(
  cli: TextgenTuiDeps["cli"],
  ui: FakeUi,
  capability: TextgenTuiDeps["capability"] = CAPABILITY,
): TextgenTuiDeps {
  return {
    cli,
    ui,
    capability,
    target: {
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      originCwd: "/repos/demo",
      socketPath: "/tmp/herdr.sock",
      session: "default",
    },
  };
}

function feedKeys(view: ScreenView, ...feeds: string[]): void {
  const parser = new KeyParser();
  for (const feed of feeds) {
    for (const ev of parser.feed(feed)) {
      view.handleKey?.(ev);
    }
  }
}

function linesText(lines: Line[]): string[] {
  return lines.map((l) => l.map((s) => s.text).join(""));
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// --- context pinning -------------------------------------------------------------

describe("parsePluginContext", () => {
  test("parses valid JSON", () => {
    const ctx = parsePluginContext('{"workspace_id":"w1","focused_pane_id":"w1:p1"}');
    expect(ctx.workspace_id).toBe("w1");
    expect(ctx.focused_pane_id).toBe("w1:p1");
  });
  test("invalid/empty input yields {}", () => {
    expect(parsePluginContext("not json")).toEqual({});
    expect(parsePluginContext("")).toEqual({});
    expect(parsePluginContext(undefined)).toEqual({});
    expect(parsePluginContext("null")).toEqual({});
    expect(parsePluginContext("[1]")).toEqual({});
  });
});

describe("resolvePinnedTarget", () => {
  test("HERDR_TUI_* pins win over context JSON", () => {
    const target = resolvePinnedTarget({
      HERDR_TUI_WORKSPACE_ID: "w-pin",
      HERDR_TUI_PANE_ID: "w-pin:p1",
      HERDR_TUI_CWD: "/pin/cwd",
      HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_id":"w-ctx","focused_pane_id":"w-ctx:p2"}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w-pin");
    expect(target.originPaneId).toBe("w-pin:p1");
    expect(target.originCwd).toBe("/pin/cwd");
  });
  test("falls back to context JSON fields", () => {
    const target = resolvePinnedTarget({
      HERDR_PLUGIN_CONTEXT_JSON:
        '{"workspace_id":"w9","tab_id":"w9:t2","focused_pane_id":"w9:p7","focused_pane":{"cwd":"/ctx/cwd"}}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w9");
    expect(target.tabId).toBe("w9:t2");
    expect(target.originPaneId).toBe("w9:p7");
    expect(target.originCwd).toBe("/ctx/cwd");
  });
  test("HERDR_PANE_ID (UI pane) is never used as origin target", () => {
    const target = resolvePinnedTarget({
      HERDR_PANE_ID: "ui:pane",
      HERDR_PLUGIN_CONTEXT_JSON: "{}",
    } as NodeJS.ProcessEnv);
    expect(target.originPaneId).toBeNull();
  });
});

describe("buildPaneOpenParams", () => {
  test("tab placement + pinned env + textgen plugin id", () => {
    const params = buildPaneOpenParams({
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      originCwd: "/repos/demo",
      socketPath: "/s",
      session: "default",
    });
    expect(params.plugin_id).toBe("rebuildup.textgen");
    expect(params.entrypoint).toBe("main");
    expect(params.placement).toBe("tab");
    expect(params.workspace_id).toBe("w1");
    const env = params.env as Record<string, string>;
    expect(env.HERDR_TUI_WORKSPACE_ID).toBe("w1");
    expect(env.HERDR_TUI_PANE_ID).toBe("w1:p9");
    expect(env.HERDR_TUI_CWD).toBe("/repos/demo");
  });
  test("omits unset pins honestly", () => {
    const params = buildPaneOpenParams({
      workspaceId: null,
      tabId: null,
      originPaneId: null,
      originCwd: null,
      socketPath: null,
      session: null,
    });
    expect(params.workspace_id).toBeUndefined();
    expect(params.env).toEqual({});
  });
});

describe("formatTargetLabel", () => {
  test("renders pinned parts and honest empty state", () => {
    expect(
      formatTargetLabel({
        workspaceId: "w1",
        tabId: null,
        originPaneId: "w1:p9",
        originCwd: null,
        socketPath: null,
        session: "s1",
      }),
    ).toBe("session s1 · ws w1 · pane w1:p9");
    expect(
      formatTargetLabel({
        workspaceId: null,
        tabId: null,
        originPaneId: null,
        originCwd: null,
        socketPath: null,
        session: null,
      }),
    ).toBe("no pinned target");
  });
});

// --- mutation gating ---------------------------------------------------------------

describe("mutationAllowed", () => {
  test("fails closed when capability is unavailable", () => {
    const gate = mutationAllowed(null, "generate");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("unavailable");
  });
  test("read_only capability disables everything", () => {
    const gate = mutationAllowed({ read_only: true, mutation_commands: ["generate"] }, "generate");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("read_only");
  });
  test("listed command allowed, unlisted denied with reason", () => {
    expect(mutationAllowed(CAPABILITY, "generate").allowed).toBe(true);
    const denied = mutationAllowed(CAPABILITY, "config set-default-provider");
    // it IS listed in the fixture — check an unlisted one instead
    expect(denied.allowed).toBe(true);
    const denied2 = mutationAllowed(CAPABILITY, "watch-next-prompt extra");
    expect(denied2.allowed).toBe(false);
    expect(denied2.reason).toContain("watch-next-prompt extra");
  });
});

// --- capability → view model ---------------------------------------------------------

describe("capability view-model helpers", () => {
  test("capabilityTasks parses tasks tolerantly", () => {
    const tasks = capabilityTasks(CAPABILITY);
    expect(tasks.map((t) => t.kind)).toEqual(["thread_title", "commit_message", "review_guide"]);
    expect(tasks[0]?.requiredInput).toEqual(["context"]);
    expect(tasks[2]?.requiresOptIn).toBe(true);
    expect(capabilityTasks(null)).toEqual([]);
    expect(capabilityTasks({ tasks: [{ nope: 1 }, "x"] })).toEqual([]);
  });

  test("effectiveTasks falls back to the built-in registry", () => {
    const tasks = effectiveTasks(null);
    expect(tasks.length).toBe(6);
    expect(tasks.map((t) => t.kind)).toContain("next_prompt");
    const cap = effectiveTasks(CAPABILITY);
    expect(cap.length).toBe(3);
  });

  test("providerOptions marks disabled providers with reasons", () => {
    const opts = providerOptions(CAPABILITY);
    const claude = opts.find((o) => o.id === "agent:claude");
    const ghost = opts.find((o) => o.id === "agent:ghost");
    const openai = opts.find((o) => o.id === "api:openai");
    expect(claude?.disabledReason).toBeNull();
    expect(ghost?.disabledReason).toContain("agent_manifests");
    expect(openai?.disabledReason).toContain("disabled");
    expect(providerOptions(null)).toEqual([]);
  });

  test("expensiveTaskOptIn + configDefaults read the capability doc", () => {
    expect(expensiveTaskOptIn(CAPABILITY)).toBe(false);
    expect(expensiveTaskOptIn({ guards: { expensive_task_opt_in: true } })).toBe(true);
    expect(expensiveTaskOptIn(null)).toBe(false);
    expect(configDefaults(CAPABILITY)).toEqual({
      provider: "agent:claude",
      model: null,
    });
  });
});

// --- generate argv / timeouts ---------------------------------------------------------

describe("buildGenerateArgs", () => {
  test("minimal args omit optional flags", () => {
    expect(buildGenerateArgs({ task: "thread_title" })).toEqual([
      "generate",
      "--task",
      "thread_title",
    ]);
  });
  test("full args include provider/model/git-pane/allow-expensive/timeout", () => {
    expect(
      buildGenerateArgs({
        task: "commit_message",
        provider: "agent:claude",
        model: "sonnet",
        gitPane: "w1:p9",
        allowExpensive: true,
        timeoutMs: 180_000,
      }),
    ).toEqual([
      "generate",
      "--task",
      "commit_message",
      "--provider",
      "agent:claude",
      "--model",
      "sonnet",
      "--git-pane",
      "w1:p9",
      "--allow-expensive",
      "--timeout",
      "180000",
    ]);
  });
  test("blank strings are treated as unset", () => {
    const args = buildGenerateArgs({ task: "pr_content", provider: "", model: "  " });
    expect(args).toEqual(["generate", "--task", "pr_content"]);
  });
});

describe("generateTimeoutMs", () => {
  test("agent-only tasks use their contract default + grace", () => {
    expect(generateTimeoutMs("review_guide")).toBe(660_000);
    expect(generateTimeoutMs("next_prompt")).toBe(180_000);
  });
  test("agent+api tasks use the 300s prompt wait + grace", () => {
    expect(generateTimeoutMs("commit_message")).toBe(360_000);
  });
  test("unknown task falls back honestly", () => {
    expect(generateTimeoutMs("bogus")).toBe(360_000);
  });
});

// --- field value resolution ------------------------------------------------------------

describe("resolveFieldValue", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("plain values pass through verbatim", async () => {
    expect(await resolveFieldValue("hello world", "/tmp")).toEqual({
      ok: true,
      value: "hello world",
    });
  });

  test("@path reads file content (multiline preserved)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "textgen-tui-field-"));
    dirs.push(dir);
    const file = path.join(dir, "diff.txt");
    writeFileSync(file, "line1\nline2\n");
    const res = await resolveFieldValue(`@${file}`, dir);
    expect(res).toEqual({ ok: true, value: "line1\nline2\n" });
  });

  test("@missing reports an honest error", async () => {
    const res = await resolveFieldValue("@/nonexistent/definitely-not-here.txt", "/tmp");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("cannot read @file");
  });
});

// --- result formatting -------------------------------------------------------------------

describe("formatGenerateResult / resultClipboardText", () => {
  test("text result renders metadata + not-retained footer", () => {
    const lines = formatGenerateResult(GENERATE_PAYLOAD);
    const text = lines.join("\n");
    expect(text).toContain("task: thread_title");
    expect(text).toContain("provider: agent:claude");
    expect(text).toContain("Fix the flaky test");
    expect(text).toContain("agent_availability_unverified");
    expect(text).toContain("not retained");
    expect(text).toContain("persisted plugin-side");
  });

  test("text_list and pr_content shapes render distinctly", () => {
    const list = formatGenerateResult({
      ...GENERATE_PAYLOAD,
      task: "commit_message",
      result: ["feat: a", "fix: b"],
    });
    expect(list.join("\n")).toContain("candidate 1");
    expect(list.join("\n")).toContain("fix: b");

    const pr = formatGenerateResult({
      ...GENERATE_PAYLOAD,
      task: "pr_content",
      result: { title: "Add feature", body: "Body text" },
    });
    const prText = pr.join("\n");
    expect(prText).toContain("title: Add feature");
    expect(prText).toContain("Body text");
  });

  test("resultClipboardText returns raw result per shape", () => {
    expect(resultClipboardText(GENERATE_PAYLOAD)).toBe("Fix the flaky test");
    expect(resultClipboardText({ ...GENERATE_PAYLOAD, result: ["a", "b"] })).toBe("a\n\n---\n\nb");
    expect(
      resultClipboardText({
        ...GENERATE_PAYLOAD,
        result: { title: "T", body: "B" },
      }),
    ).toBe("T\n\nB");
  });
});

describe("copyToClipboard", () => {
  test("win32 clip.exe absent on POSIX reports honest failure", async () => {
    // Deterministic: clip.exe does not exist on macOS/Linux CI.
    const res = await copyToClipboard("hello", {
      platform: "win32",
      timeoutMs: 2_000,
    });
    expect(res.ok).toBe(false);
  });
});

// --- TaskListView -------------------------------------------------------------------------

describe("TaskListView", () => {
  test("renders capability tasks; capability null shows honest degraded state", () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => ({}));
    const view = new TaskListView(makeDeps(fn, ui));
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("thread_title");
    expect(text).toContain("review_guide");
    expect(text).toContain("OPT-IN");

    const ui2 = fakeUi();
    const view2 = new TaskListView(makeDeps(fn, ui2, null));
    const text2 = linesText(view2.render(100, 30)).join("\n");
    // falls back to built-in registry + honest capability warning
    expect(text2).toContain("capability document unavailable");
    expect(text2).toContain("next_prompt");
  });

  test("full generate flow: provider → model → fields → confirm → generate → result view", async () => {
    const ui = fakeUi();
    ui.selectResult = { value: null, label: "(default)" }; // default provider
    ui.promptResults.push(
      "", // model
      "a conversation about tests", // context (required)
      "", // instruction (optional)
    );
    ui.confirmResults.push(true); // generate confirm
    const { calls, inputs, fn } = fakeCli((args) => {
      if (args[0] === "generate") return GENERATE_PAYLOAD;
      return {};
    });
    const view = new TaskListView(makeDeps(fn, ui));
    feedKeys(view, "\r"); // enter on first item (thread_title)
    await flush(30);

    const genCall = calls.find((c) => c[0] === "generate");
    expect(genCall).toEqual(["generate", "--task", "thread_title", "--timeout", "360000"]);
    const inputJson = inputs[calls.indexOf(genCall as string[])];
    const parsed = JSON.parse(inputJson ?? "{}") as Record<string, unknown>;
    expect(parsed.context).toBe("a conversation about tests");
    expect(parsed.instruction).toBeUndefined();
    expect(ui.confirms.length).toBe(1);
    expect(ui.confirms[0]?.title).toContain("Generate thread_title");
    // field VALUES must not appear in the confirm target lines
    expect(ui.confirms[0]?.target?.join("\n")).not.toContain("a conversation about tests");
    expect(ui.confirms[0]?.target?.join("\n")).toContain("context: 26 chars");
    // result view pushed
    expect(ui.pushed.length).toBe(1);
    const pushedText = linesText((ui.pushed[0] as ResultView).render(100, 30)).join("\n");
    expect(pushedText).toContain("not retained");
    expect(pushedText).toContain("Fix the flaky test");
  });

  test("capability null disables generate before any cli call", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => ({}));
    const view = new TaskListView(makeDeps(fn, ui, null));
    feedKeys(view, "\r");
    await flush(10);
    expect(calls.some((c) => c[0] === "generate")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });

  test("review_guide asks per-run opt-in; declining aborts", async () => {
    const ui = fakeUi();
    ui.selectResult = { value: "agent:claude", label: "agent:claude" };
    ui.confirmResults.push(false); // decline --allow-expensive
    const { calls, fn } = fakeCli(() => ({}));
    const view = new TaskListView(makeDeps(fn, ui));
    feedKeys(view, "jj\r"); // down to review_guide (index 2), enter
    await flush(20);
    expect(ui.confirms.length).toBe(1);
    expect(ui.confirms[0]?.title).toContain("requires opt-in");
    // declined → no provider select, no field prompts, no generate
    expect(calls.some((c) => c[0] === "generate")).toBe(false);
    expect(ui.prompts.length).toBe(0);
  });

  test("review_guide opt-in accepted → --allow-expensive in argv", async () => {
    const ui = fakeUi();
    ui.selectResult = { value: "agent:claude", label: "agent:claude" };
    // model, then fields target/instructions/cwd
    ui.promptResults.push("", "PR #42", "", "");
    ui.confirmResults.push(true, true); // opt-in + generate confirm
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "generate") {
        return { ...GENERATE_PAYLOAD, task: "review_guide" };
      }
      return {};
    });
    const view = new TaskListView(makeDeps(fn, ui));
    feedKeys(view, "jj\r");
    await flush(30);
    const genCall = calls.find((c) => c[0] === "generate");
    expect(genCall).toBeDefined();
    expect(genCall).toContain("review_guide");
    expect(genCall).toContain("--allow-expensive");
    expect(genCall).toContain("--provider");
    expect(genCall).toContain("agent:claude");
    expect(genCall).toContain("660000"); // contract defaultTimeoutMs + grace
    expect(ui.confirms.length).toBe(2);
  });

  test("git task offers --git-pane and previews git-context", async () => {
    const ui = fakeUi();
    ui.selectResult = { value: null, label: "(default)" };
    // commit_message is index 1: model, git-pane, diff, conventions, instruction, candidates
    ui.promptResults.push(
      "", // model
      "w1:p9", // git pane
      "diff --git a/x b/x", // diff (required)
      "", // conventions
      "", // instruction
      "3", // candidates
    );
    ui.confirmResults.push(true);
    const { calls, inputs, fn } = fakeCli((args) => {
      if (args[0] === "git-context") {
        return {
          contract: "herdr-plugins.textgen/v1",
          command: "git-context",
          ok: true,
          task: "commit_message",
          pane_id: "w1:p9",
          repo_root: "/repos/demo",
          branch: "main",
          input: { diff: "collected diff" },
          sources: [{ command: "status" }],
          warnings: [],
        };
      }
      if (args[0] === "generate") {
        return {
          ...GENERATE_PAYLOAD,
          task: "commit_message",
          result: ["feat: x"],
        };
      }
      return {};
    });
    const view = new TaskListView(makeDeps(fn, ui));
    feedKeys(view, "j\r"); // down to commit_message (index 1), enter
    await flush(40);

    expect(calls.some((c) => c[0] === "git-context" && c.includes("w1:p9"))).toBe(true);
    const genCall = calls.find((c) => c[0] === "generate");
    expect(genCall).toBeDefined();
    expect(genCall).toContain("--git-pane");
    expect(genCall).toContain("w1:p9");
    const idx = calls.indexOf(genCall as string[]);
    const parsed = JSON.parse(inputs[idx] ?? "{}") as Record<string, unknown>;
    expect(parsed.diff).toBe("diff --git a/x b/x");
    expect(parsed.candidates).toBe(3);
    // git-context preview view was pushed
    expect(ui.pushed.length).toBeGreaterThanOrEqual(1);
  });

  test("generate CLI error surfaces honestly on the status line", async () => {
    const ui = fakeUi();
    ui.selectResult = { value: null, label: "(default)" };
    ui.promptResults.push("", "ctx", "");
    ui.confirmResults.push(true);
    const { fn } = fakeCli(() => {
      throw new TextgenCliError("agent kind not in herdr manifests", "provider_unavailable");
    });
    const view = new TaskListView(makeDeps(fn, ui));
    feedKeys(view, "\r");
    await flush(30);
    expect(ui.statuses.join(" ")).toContain("provider_unavailable");
    expect(ui.statuses.join(" ")).toContain("not in herdr manifests");
    expect(ui.pushed.length).toBe(0);
  });
});

// --- ResultView ---------------------------------------------------------------------------

describe("ResultView", () => {
  test("renders result + not-retained footer; c copies", async () => {
    const ui = fakeUi();
    const deps = makeDeps(fakeCli(() => ({})).fn, ui);
    const view = new ResultView(deps, { payload: GENERATE_PAYLOAD });
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("result — thread_title");
    expect(text).toContain("Fix the flaky test");
    expect(text).toContain("not retained");

    const ev: KeyEvent = { kind: "key", key: "c", ctrl: false, shift: false, alt: false };
    view.handleKey?.(ev);
    // clipboard spawn needs real wall time, not just microtask flushes
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ui.statuses.join(" ")).toMatch(/copied|unavailable/);
  });

  test("preview mode renders custom lines + footer, no copy key", () => {
    const ui = fakeUi();
    const deps = makeDeps(fakeCli(() => ({})).fn, ui);
    const view = new ResultView(deps, {
      title: "git context preview",
      lines: ["repo: /r", "branch: main"],
      footer: "read-only preview",
    });
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("git context preview");
    expect(text).toContain("read-only preview");
    expect(view.keymap().some((k) => k.keys === "c")).toBe(false);
  });
});

// --- runTextgenCli (real subprocess, isolated state/config dirs) -------------------------

describe("runTextgenCli", () => {
  const dirs: string[] = [];
  const savedState = process.env.HERDR_PLUGIN_STATE_DIR;
  const savedConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;
  const savedSocket = process.env.HERDR_SOCKET_PATH;
  const savedSession = process.env.HERDR_SESSION;

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    if (savedState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = savedState;
    if (savedConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = savedConfig;
    if (savedSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = savedSocket;
    if (savedSession === undefined) delete process.env.HERDR_SESSION;
    else process.env.HERDR_SESSION = savedSession;
  });

  function useIsolatedDirs(): void {
    const dir = mkdtempSync(path.join(tmpdir(), "textgen-tui-cli-"));
    dirs.push(dir);
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
    // Never let the subprocess reach the user's live herdr session:
    // point the socket at a path that cannot exist.
    process.env.HERDR_SOCKET_PATH = path.join(dir, "nonexistent.sock");
    delete process.env.HERDR_SESSION;
  }

  test("capability returns the contract document", async () => {
    useIsolatedDirs();
    const payload = await runTextgenCli(["capability"], { timeoutMs: 30_000 });
    expect(payload.contract).toBe("herdr-plugins.textgen/v1");
    expect(payload.command).toBe("capability");
    expect(Array.isArray(payload.mutation_commands)).toBe(true);
    expect((payload.mutation_commands as string[]).includes("generate")).toBe(true);
  }, 40_000);

  test("generate pipes stdin JSON and fails honestly without a provider", async () => {
    useIsolatedDirs();
    // Valid input reaches provider resolution; with no herdr session and
    // no api generators the CLI must fail with a structured error —
    // proving the TUI's stdin JSON path works end to end.
    try {
      await runTextgenCli(["generate", "--task", "thread_title"], {
        timeoutMs: 60_000,
        input: JSON.stringify({ context: "tui smoke" }),
      });
      expect.unreachable("generate should fail without a provider");
    } catch (err) {
      expect(err).toBeInstanceOf(TextgenCliError);
      const kind = (err as TextgenCliError).kind;
      // Any honest failure kind is acceptable — the point is the CLI
      // rejected with a structured error instead of fabricating output.
      expect(kind.length).toBeGreaterThan(0);
      expect((err as TextgenCliError).message.length).toBeGreaterThan(0);
    }
  }, 70_000);

  test("input_secret_detected surfaces the policy kind via stdin input", async () => {
    useIsolatedDirs();
    try {
      await runTextgenCli(["generate", "--task", "thread_title"], {
        timeoutMs: 30_000,
        input: JSON.stringify({ context: "key sk-abcdefghijklmnopqrstuvwx" }),
      });
      expect.unreachable("secret-shaped input must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(TextgenCliError);
      expect((err as TextgenCliError).kind).toBe("policy");
      expect(errorLine(err)).toContain("credential-shaped");
    }
  }, 40_000);
});
