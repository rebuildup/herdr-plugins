/**
 * Tests for the rebuildup.controls TUI surface (#245,
 * contract docs/contracts/tui-v1.md).
 *
 * Covers the pure helpers (context pinning, pane-open params, mutation
 * gating, payload formatting) and the view layer with a fake
 * CLI/ui/snapshot — no real herdr session, no TTY required.
 */

import { describe, expect, test } from "bun:test";
import type { AgentGetResult, PaneInfo } from "../packages/herdr-client/src/index";
import type {
  ConfirmOptions,
  SelectItem,
  SelectListOptions,
  TextInputOptions,
} from "../packages/tui/src/components";
import { KeyParser } from "../packages/tui/src/input";
import type { Line, ScreenView } from "../packages/tui/src/screen";
import { TaskRunner } from "../packages/tui/src/task";
import {
  agentSelectItem,
  buildPaneOpenParams,
  formatTargetLabel,
  identityLines,
  mutationAllowed,
  parsePluginContext,
  resolvePinnedTarget,
  type SessionAgents,
  shellPaneSelectItem,
} from "../plugins/controls/src/tui-support";
import {
  AgentDetailView,
  AgentListView,
  type ControlsTuiDeps,
  type ControlsTuiUi,
} from "../plugins/controls/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const AGENT: AgentGetResult = {
  pane_id: "w1:p1",
  agent: "claude",
  agent_status: "idle",
  state_change_seq: 3,
  agent_session: { agent: "claude", kind: "id", value: "sess-1" },
  workspace_id: "w1",
  tab_id: "w1:t1",
  cwd: "/repo",
  interactive_ready: true,
} as AgentGetResult;

const PANE: PaneInfo = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  title: "worker",
  cwd: "/repo",
};

const SHELL_PANE: PaneInfo = {
  pane_id: "w1:p9",
  workspace_id: "w1",
  tab_id: "w1:t1",
  cwd: "/repo",
};

const CAPABILITY = {
  read_only: false,
  mutation_commands: ["send", "command", "interrupt", "rename", "start"],
};

const SESSION: SessionAgents = {
  panes: [PANE, SHELL_PANE],
  agents: { "w1:p1": { ...AGENT } },
  sessionName: "default",
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends ControlsTuiUi {
  statuses: string[];
  confirms: ConfirmOptions[];
  prompts: string[];
  pushed: ScreenView[];
  confirmResults: boolean[];
  promptResults: Array<string | null>;
  selectResults: Array<SelectItem<unknown> | null>;
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    statuses: [],
    confirms: [],
    prompts: [],
    pushed: [],
    confirmResults: [],
    promptResults: [],
    selectResults: [],
    confirm(opts: ConfirmOptions) {
      ui.confirms.push(opts);
      return Promise.resolve(ui.confirmResults.shift() ?? true);
    },
    prompt(text: string, _opts?: TextInputOptions) {
      ui.prompts.push(text);
      return Promise.resolve(ui.promptResults.shift() ?? null);
    },
    select<T>(_opts: SelectListOptions<T>) {
      return Promise.resolve((ui.selectResults.shift() ?? null) as SelectItem<T> | null);
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
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function fakeCli(handler: CliHandler): {
  calls: string[][];
  fn: ControlsTuiDeps["cli"];
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args) => {
      calls.push([...args]);
      return Promise.resolve(handler(args));
    },
  };
}

function makeDeps(
  cli: ControlsTuiDeps["cli"],
  ui: FakeUi,
  overrides: Partial<ControlsTuiDeps> = {},
): ControlsTuiDeps {
  return {
    cli,
    ui,
    capability: CAPABILITY,
    target: {
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      socketPath: "/tmp/herdr.sock",
      session: "default",
    },
    agents: () => Promise.resolve(SESSION),
    agentGet: () => Promise.resolve(AGENT),
    ...overrides,
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
      HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_id":"w-ctx","focused_pane_id":"w-ctx:p2"}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w-pin");
    expect(target.originPaneId).toBe("w-pin:p1");
  });
  test("falls back to context JSON fields", () => {
    const target = resolvePinnedTarget({
      HERDR_PLUGIN_CONTEXT_JSON:
        '{"workspace_id":"w9","tab_id":"w9:t2","focused_pane_id":"w9:p7","focused_pane":{"pane_id":"w9:p8"}}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w9");
    expect(target.tabId).toBe("w9:t2");
    expect(target.originPaneId).toBe("w9:p7");
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
  test("tab placement + pinned env, workspace_id only when known", () => {
    const params = buildPaneOpenParams({
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      socketPath: "/s",
      session: "default",
    });
    expect(params.plugin_id).toBe("rebuildup.controls");
    expect(params.entrypoint).toBe("main");
    expect(params.placement).toBe("tab");
    expect(params.workspace_id).toBe("w1");
    const env = params.env as Record<string, string>;
    expect(env.HERDR_TUI_WORKSPACE_ID).toBe("w1");
    expect(env.HERDR_TUI_TAB_ID).toBe("w1:t1");
    expect(env.HERDR_TUI_PANE_ID).toBe("w1:p9");
  });
  test("omits unset pins honestly", () => {
    const params = buildPaneOpenParams({
      workspaceId: null,
      tabId: null,
      originPaneId: null,
      socketPath: null,
      session: null,
    });
    expect(params.workspace_id).toBeUndefined();
    expect(params.env).toEqual({});
    expect(params.placement).toBe("tab");
  });
});

describe("formatTargetLabel", () => {
  test("renders pinned parts and honest empty state", () => {
    expect(
      formatTargetLabel({
        workspaceId: "w1",
        tabId: null,
        originPaneId: "w1:p9",
        socketPath: null,
        session: "default",
      }),
    ).toBe("session default · ws w1 · pane w1:p9");
    expect(
      formatTargetLabel({
        workspaceId: null,
        tabId: null,
        originPaneId: null,
        socketPath: null,
        session: null,
      }),
    ).toBe("no pinned target");
  });
});

// --- mutation gating ---------------------------------------------------------------

describe("mutationAllowed", () => {
  test("fails closed when capability is unavailable", () => {
    const gate = mutationAllowed(null, "send");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("unavailable");
  });
  test("read_only capability disables everything", () => {
    const gate = mutationAllowed({ read_only: true, mutation_commands: ["send"] }, "send");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("read_only");
  });
  test("listed command allowed, unlisted denied with reason", () => {
    expect(mutationAllowed(CAPABILITY, "send").allowed).toBe(true);
    const denied = mutationAllowed(CAPABILITY, "wait");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("wait");
  });
});

// --- payload formatting --------------------------------------------------------------

describe("payload formatting", () => {
  test("agentSelectItem carries identity detail", () => {
    const item = agentSelectItem(PANE, { ...AGENT });
    expect(item.label).toContain("w1:p1");
    expect(item.label).toContain("claude");
    expect(item.label).toContain("idle");
    expect(item.detail).toContain("state_change_seq: 3");
    expect(item.detail).toContain("sess-1");
  });
  test("shellPaneSelectItem disables agent panes honestly", () => {
    const free = shellPaneSelectItem(SHELL_PANE, false);
    expect(free.disabled).toBeUndefined();
    expect(free.detail).toContain("shell pane");
    const busy = shellPaneSelectItem(PANE, true);
    expect(busy.disabled).toBe(true);
    expect(busy.disabledReason).toContain("agent");
  });
  test("identityLines lists generation signals", () => {
    const lines = identityLines(AGENT).join("\n");
    expect(lines).toContain("pane: w1:p1");
    expect(lines).toContain("state_change_seq: 3");
    expect(lines).toContain("sess-1");
  });
});

// --- AgentListView -----------------------------------------------------------------

describe("AgentListView", () => {
  test("renders agents after load; empty session shows honest empty text", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => ({}));
    const view = new AgentListView(makeDeps(fn, ui), () => {});
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("w1:p1");
    expect(text).toContain("claude");

    const ui2 = fakeUi();
    const empty = new AgentListView(
      makeDeps(fn, ui2, {
        agents: () => Promise.resolve({ panes: [], agents: {}, sessionName: null }),
      }),
      () => {},
    );
    await empty.load();
    const emptyText = linesText(empty.render(100, 20)).join("\n");
    expect(emptyText).toContain("no agents reported");
  });

  test("load failure renders the real error, not a fake list", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => ({}));
    const view = new AgentListView(
      makeDeps(fn, ui, {
        agents: () => Promise.reject(new Error("socket gone")),
      }),
      () => {},
    );
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("failed to load agents");
    expect(text).toContain("socket gone");
  });

  test("enter opens the selected agent; s is gated when capability missing", async () => {
    const ui = fakeUi();
    const opened: string[] = [];
    const { fn } = fakeCli(() => ({}));
    const view = new AgentListView(makeDeps(fn, ui), (paneId) => opened.push(paneId));
    await view.load();
    feedKeys(view, "\r");
    expect(opened).toEqual(["w1:p1"]);

    // start flow with null capability → gated before any cli call
    const ui2 = fakeUi();
    const { calls, fn: fn2 } = fakeCli(() => ({}));
    const gated = new AgentListView(makeDeps(fn2, ui2, { capability: null }), () => {});
    await gated.load();
    feedKeys(gated, "s");
    await flush();
    expect(calls.some((c) => c[0] === "start")).toBe(false);
    expect(ui2.statuses.join(" ")).toContain("disabled");
  });

  test("start flow happy path: pane→kind→options→confirm→cli start", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "start") return { identity: { pane_id: "w1:p9", agent: "claude" } };
      return {};
    });
    const view = new AgentListView(makeDeps(fn, ui), () => {});
    await view.load();

    ui.selectResults.push(
      { value: SHELL_PANE, label: "w1:p9" }, // pane
      { value: "claude", label: "claude" }, // kind
      { value: "", label: "default" }, // permission mode
      { value: "none", label: "no resume" }, // resume
    );
    ui.promptResults.push("", "", ""); // name, model, reasoning → empty
    feedKeys(view, "s");
    await flush(30);

    const startCall = calls.find((c) => c[0] === "start");
    expect(startCall).toEqual(["start", "w1:p9", "--agent", "claude"]);
    expect(ui.confirms.length).toBe(1);
    expect(ui.confirms[0]?.target?.join(" ")).toContain("w1:p9");
    expect(ui.confirms[0]?.target?.join(" ")).toContain("claude");
  });
});

// --- AgentDetailView ----------------------------------------------------------------

function detailDeps(
  ui: FakeUi,
  cliHandler: CliHandler,
  agentGetImpl?: (target: string) => Promise<AgentGetResult>,
): { deps: ControlsTuiDeps; calls: string[][] } {
  const { calls, fn } = fakeCli(cliHandler);
  const deps = makeDeps(fn, ui, {
    agentGet: agentGetImpl ?? (() => Promise.resolve(AGENT)),
  });
  return { deps, calls };
}

describe("AgentDetailView", () => {
  test("renders agent identity after load", async () => {
    const ui = fakeUi();
    const { deps } = detailDeps(ui, () => ({}));
    const view = new AgentDetailView(deps, "w1:p1");
    await flush();
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("w1:p1");
    expect(text).toContain("claude");
    expect(text).toContain("state_change_seq: 3");
  });

  test("missing agent renders honest missing state", async () => {
    const ui = fakeUi();
    const { deps } = detailDeps(
      ui,
      () => ({}),
      () =>
        Promise.reject(Object.assign(new Error("agent not found"), { code: "agent_not_found" })),
    );
    const view = new AgentDetailView(deps, "w1:p9");
    await flush();
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("not found");
  });

  test("send flow: prompt → wait select → confirm → cli send with expect guards", async () => {
    const ui = fakeUi();
    const { deps, calls } = detailDeps(ui, (args) => {
      if (args[0] === "send") return { identity: AGENT, result: {} };
      return {};
    });
    const view = new AgentDetailView(deps, "w1:p1");
    await flush();

    ui.promptResults.push("hello agent");
    ui.selectResults.push({ value: "idle", label: "wait until idle" });
    feedKeys(view, "s");
    await flush(30);

    const sendCall = calls.find((c) => c[0] === "send");
    expect(sendCall).toEqual([
      "send",
      "w1:p1",
      "hello agent",
      "--expect-pane",
      "w1:p1",
      "--expect-state-seq",
      "3",
      "--expect-agent-session",
      "sess-1",
      "--wait-until",
      "idle",
      "--timeout-ms",
      "60000",
    ]);
    expect(ui.confirms[0]?.title).toContain("Send message");
    expect(ui.confirms[0]?.target?.join(" ")).toContain("w1:p1");
  });

  test("stale generation aborts mutation before the cli call", async () => {
    const ui = fakeUi();
    let getCalls = 0;
    const { deps, calls } = detailDeps(
      ui,
      (args) => (args[0] === "send" ? { identity: AGENT } : {}),
      () => {
        getCalls += 1;
        // First load: seq 3. Revalidation: seq bumped → stale.
        return Promise.resolve({
          ...AGENT,
          state_change_seq: getCalls === 1 ? 3 : 4,
        } as AgentGetResult);
      },
    );
    const view = new AgentDetailView(deps, "w1:p1");
    await flush();

    ui.promptResults.push("hi");
    ui.selectResults.push({ value: "", label: "send only" });
    feedKeys(view, "s");
    await flush(30);

    expect(calls.some((c) => c[0] === "send")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("stale");
  });

  test("mutations disabled when capability is null", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => ({}));
    const deps = makeDeps(fn, ui, { capability: null });
    const view = new AgentDetailView(deps, "w1:p1");
    await flush();
    ui.promptResults.push("hi");
    feedKeys(view, "s");
    await flush(20);
    expect(calls.some((c) => c[0] === "send")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });

  test("interrupt sends PTY keys with confirm; read pushes scrollback view", async () => {
    const ui = fakeUi();
    const { deps, calls } = detailDeps(ui, (args) => {
      if (args[0] === "interrupt") return { keys: ["esc"], result: {} };
      if (args[0] === "read") {
        return { read: { text: "line1\nline2", truncated: false } };
      }
      return {};
    });
    const view = new AgentDetailView(deps, "w1:p1");
    await flush();

    ui.selectResults.push({ value: "ctrl+c", label: "ctrl+c" });
    feedKeys(view, "i");
    await flush(30);
    const intCall = calls.find((c) => c[0] === "interrupt");
    expect(intCall).toEqual([
      "interrupt",
      "w1:p1",
      "--key",
      "ctrl+c",
      "--expect-pane",
      "w1:p1",
      "--expect-state-seq",
      "3",
      "--expect-agent-session",
      "sess-1",
    ]);
    expect(ui.confirms[0]?.danger).toBe(true);

    feedKeys(view, "v");
    await flush(20);
    expect(calls.some((c) => c[0] === "read")).toBe(true);
    expect(ui.pushed.length).toBe(1);
    const detail = ui.pushed[0];
    const text = linesText(detail?.render(100, 20) ?? []).join("\n");
    expect(text).toContain("line1");
    expect(text).toContain("line2");
  });
});
