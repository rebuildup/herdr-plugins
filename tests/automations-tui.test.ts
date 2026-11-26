/**
 * Tests for the rebuildup.automations TUI surface (#243,
 * contract docs/contracts/tui-v1.md).
 *
 * Covers the pure helpers (context pinning, pane-open params, pinned
 * CLI args, mutation gating, payload formatting) and the view layer
 * with a fake CLI/ui — no real herdr session, no TTY required.
 */

import { describe, expect, test } from "bun:test";
import type {
  ConfirmOptions,
  SelectItem,
  SelectListOptions,
  TextInputOptions,
} from "../packages/tui/src/components";
import { type KeyEvent, KeyParser } from "../packages/tui/src/input";
import type { Line, ScreenView } from "../packages/tui/src/screen";
import { TaskRunner } from "../packages/tui/src/task";
import type { RunView, TaskView } from "../plugins/automations/src/model";
import {
  buildPaneOpenParams,
  destinationSummary,
  formatRunsPayload,
  formatTargetLabel,
  mutationAllowed,
  parsePluginContext,
  pinnedCliArgs,
  resolvePinnedTarget,
  runDetailLines,
  runSelectItem,
  scheduleSummary,
  taskHeaderLines,
  taskSelectItem,
} from "../plugins/automations/src/tui-support";
import {
  type AutomationsTuiDeps,
  type AutomationsTuiUi,
  DriversView,
  RunsView,
  TaskDetailView,
  TaskListView,
} from "../plugins/automations/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";

const TASK: TaskView = {
  contract: "herdr-plugins.automations/v1",
  task_id: "task-1",
  name: "Daily standup",
  prompt: "summarize yesterday",
  schedule: { type: "interval", every_ms: 3_600_000 },
  enabled: true,
  misfire: "skip",
  destination: { kind: "pane", pane_id: "w1:p9" },
  created_by: "tui",
  created_at: NOW,
  updated_at: NOW,
  enabled_at: NOW,
  disabled_at: null,
  schedule_anchor_at: NOW,
  last_run_at: null,
  run_count: 0,
  next_run_at: "2026-01-01T01:00:00.000Z",
  driver: { state: "os-scheduler", detail: "launchd agent loaded" },
  missed_total: 0,
  missed_truncated: false,
};

const RUN: RunView = {
  contract: "herdr-plugins.automations/v1",
  run_id: "run-1",
  task_id: "task-1",
  trigger: "schedule",
  scheduled_for: "2026-01-01T00:00:00.000Z",
  status: "success",
  created_at: NOW,
  started_at: NOW,
  finished_at: NOW,
  destination_snapshot: { pane_id: "w1:p9" },
  result: { summary: "done", agent_status: "idle" },
  error: null,
};

const DERIVED_MISSED: RunView = {
  contract: "herdr-plugins.automations/v1",
  run_id: null,
  task_id: "task-1",
  trigger: "schedule",
  scheduled_for: "2025-12-31T23:00:00.000Z",
  status: "missed",
  derived: true,
  created_at: null,
  started_at: null,
  finished_at: null,
  destination_snapshot: null,
  result: null,
  error: { code: "missed", message: "owed occurrence past grace" },
};

const CAPABILITY = {
  read_only: false,
  mutation_commands: [
    "create",
    "update",
    "set-enabled",
    "delete",
    "run-now",
    "reconcile",
    "fire",
    "tick",
    "watch",
    "schedule install",
    "schedule uninstall",
    "schedule status",
  ],
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends AutomationsTuiUi {
  statuses: string[];
  confirms: ConfirmOptions[];
  prompts: string[];
  selects: SelectListOptions<unknown>[];
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
    selects: [],
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
    select<T>(opts: SelectListOptions<T>) {
      ui.selects.push(opts as SelectListOptions<unknown>);
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
  fn: AutomationsTuiDeps["cli"];
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
  cli: AutomationsTuiDeps["cli"],
  ui: FakeUi,
  capability: AutomationsTuiDeps["capability"] = CAPABILITY,
): AutomationsTuiDeps {
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

function keyEvent(key: string): KeyEvent {
  return { kind: "key", key, ctrl: false, shift: false, alt: false };
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
  test("tab placement + pinned env, workspace_id only when known", () => {
    const params = buildPaneOpenParams({
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      originCwd: "/repos/demo",
      socketPath: "/s",
      session: "default",
    });
    expect(params.plugin_id).toBe("rebuildup.automations");
    expect(params.entrypoint).toBe("main");
    expect(params.placement).toBe("tab");
    expect(params.workspace_id).toBe("w1");
    const env = params.env as Record<string, string>;
    expect(env.HERDR_TUI_WORKSPACE_ID).toBe("w1");
    expect(env.HERDR_TUI_TAB_ID).toBe("w1:t1");
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
    expect(params.placement).toBe("tab");
  });
});

describe("pinnedCliArgs", () => {
  test("appends --socket when resolved, empty otherwise", () => {
    expect(
      pinnedCliArgs({
        workspaceId: null,
        tabId: null,
        originPaneId: null,
        originCwd: null,
        socketPath: "/tmp/herdr.sock",
        session: "default",
      }),
    ).toEqual(["--socket", "/tmp/herdr.sock"]);
    expect(
      pinnedCliArgs({
        workspaceId: null,
        tabId: null,
        originPaneId: null,
        originCwd: null,
        socketPath: null,
        session: null,
      }),
    ).toEqual([]);
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
        session: null,
      }),
    ).toBe("ws w1 · pane w1:p9");
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
    const gate = mutationAllowed(null, "run-now");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("unavailable");
  });
  test("read_only capability disables everything", () => {
    const gate = mutationAllowed({ read_only: true, mutation_commands: ["create"] }, "create");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("read_only");
  });
  test("listed command allowed, unlisted denied with reason", () => {
    expect(mutationAllowed(CAPABILITY, "run-now").allowed).toBe(true);
    const denied = mutationAllowed(CAPABILITY, "bogus");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("bogus");
  });
});

// --- payload formatting --------------------------------------------------------------

describe("payload formatting", () => {
  test("scheduleSummary covers every schedule type honestly", () => {
    expect(scheduleSummary({ type: "interval", every_ms: 3_600_000 })).toContain("3600000");
    expect(
      scheduleSummary({
        type: "fixed_time",
        time_of_day: "09:30",
        weekdays: [1, 2],
        time_zone: "Asia/Tokyo",
      }),
    ).toContain("09:30");
    expect(
      scheduleSummary({
        type: "fixed_time",
        time_of_day: "09:30",
        weekdays: [1, 2],
        time_zone: "Asia/Tokyo",
      }),
    ).toContain("Asia/Tokyo");
    expect(scheduleSummary({ type: "once", run_at: NOW })).toContain(NOW);
    expect(scheduleSummary({ type: "event", on: "pane.closed", debounce_ms: 5000 })).toContain(
      "pane.closed",
    );
    expect(scheduleSummary(null)).toBe("unknown");
  });

  test("destinationSummary covers pane + launch", () => {
    expect(destinationSummary({ kind: "pane", pane_id: "w1:p9" })).toBe("pane w1:p9");
    expect(
      destinationSummary({
        kind: "launch",
        surface: { workspace_id: "w1" },
        agent: "claude",
        via: "direct",
      }),
    ).toBe("launch claude → ws w1 via direct");
    expect(
      destinationSummary({
        kind: "launch",
        surface: { new_workspace: true },
        agent: "codex",
      }),
    ).toBe("launch codex → new workspace");
    expect(destinationSummary(null)).toBe("unknown");
  });

  test("taskSelectItem / taskHeaderLines carry identity + driver + missed", () => {
    const item = taskSelectItem({
      ...TASK,
      enabled: false,
      missed_total: 3,
      missed_truncated: true,
    });
    expect(item.label).toContain("Daily standup (task-1)");
    expect(item.label).toContain("disabled");
    expect(item.label).toContain("3 missed");
    expect(item.detail).toContain("os-scheduler");
    const header = taskHeaderLines(TASK).join("\n");
    expect(header).toContain("task_id: task-1");
    expect(header).toContain("next_run_at:");
    expect(header).toContain("missed: 0");
  });

  test("runSelectItem / runDetailLines label derived missed honestly", () => {
    const item = runSelectItem(DERIVED_MISSED);
    expect(item.label).toContain("(derived)");
    expect(item.detail).toContain("not stored");
    const lines = runDetailLines(DERIVED_MISSED).join("\n");
    expect(lines).toContain("derived: true");
    expect(lines).toContain("reconcile");
    const stored = runDetailLines(RUN).join("\n");
    expect(stored).toContain("run_id: run-1");
    expect(stored).toContain("agent_status: idle");
    expect(stored).toContain("destination_snapshot");
  });

  test("formatRunsPayload renders runs + empty state", () => {
    const lines = formatRunsPayload({ runs: [RUN, DERIVED_MISSED] });
    const text = lines.join("\n");
    expect(text).toContain("success");
    expect(text).toContain("missed (derived)");
    expect(formatRunsPayload({ runs: [] }).join("\n")).toContain("(no runs recorded)");
  });
});

// --- TaskListView -----------------------------------------------------------------

describe("TaskListView", () => {
  test("renders tasks after load; empty registry shows honest empty text", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => ({ tasks: [TASK] }));
    const view = new TaskListView(makeDeps(fn, ui), () => {});
    await view.load();
    const text = linesText(view.render(80, 20)).join("\n");
    expect(text).toContain("Daily standup (task-1)");

    const ui2 = fakeUi();
    const { fn: fn2 } = fakeCli(() => ({ tasks: [] }));
    const empty = new TaskListView(makeDeps(fn2, ui2), () => {});
    await empty.load();
    const emptyText = linesText(empty.render(80, 20)).join("\n");
    expect(emptyText).toContain("no automation tasks");
  });

  test("load failure renders the real error, not a fake list", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => {
      throw new Error("state lock timed out");
    });
    const view = new TaskListView(makeDeps(fn, ui), () => {});
    await view.load();
    const text = linesText(view.render(80, 20)).join("\n");
    expect(text).toContain("failed to load tasks");
    expect(text).toContain("state lock timed out");
  });

  test("enter opens the selected task; H pushes runs view; d pushes drivers", async () => {
    const ui = fakeUi();
    const opened: string[] = [];
    const { fn } = fakeCli(() => ({ tasks: [TASK] }));
    const view = new TaskListView(makeDeps(fn, ui), (t) => opened.push(t.task_id));
    await view.load();
    feedKeys(view, "\r");
    expect(opened).toEqual(["task-1"]);

    feedKeys(view, "H");
    expect(ui.pushed.length).toBe(1);
    feedKeys(view, "d");
    expect(ui.pushed.length).toBe(2);
  });

  test("create flow is gated + confirmed + builds CLI args", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "list") return { tasks: [] };
      if (args[0] === "create") return { task: TASK };
      return {};
    });
    const view = new TaskListView(makeDeps(fn, ui), () => {});
    await view.load();

    // n → prompts: name, prompt → schedule select+prompt → destination
    // select+prompts → misfire select → confirm → create.
    ui.promptResults.push(
      "Nightly", // name
      "do the thing", // prompt
      "5", // interval minutes
      "w1:p9", // pane_id (hint prefilled but prompt returns value)
      "claude", // not reached for pane kind
    );
    ui.selectResults.push(
      { value: "interval", label: "interval" }, // schedule type
      { value: "pane", label: "pane" }, // destination kind
      { value: "skip", label: "skip" }, // misfire
    );
    feedKeys(view, "n");
    await flush(30);

    const createCall = calls.find((c) => c[0] === "create");
    expect(createCall).toBeDefined();
    expect(createCall?.join(" ")).toContain("--name Nightly");
    expect(createCall?.join(" ")).toContain('"every_ms":300000');
    expect(createCall?.join(" ")).toContain('"pane_id":"w1:p9"');
    expect(ui.confirms.length).toBe(1);
    expect(ui.confirms[0]?.title).toContain("Create automation task");
  });

  test("create disabled when capability is null", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => ({ tasks: [] }));
    const deps = makeDeps(fn, ui, null);
    const view = new TaskListView(deps, () => {});
    await view.load();
    feedKeys(view, "n");
    await flush();
    expect(calls.some((c) => c[0] === "create")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });
});

// --- TaskDetailView -----------------------------------------------------------------

function detailCli(overrides: Partial<Record<string, unknown>> = {}): CliHandler {
  return (args) => {
    const key = args.join(" ");
    if (key === "get task-1") {
      const task = "task" in overrides ? (overrides.task as TaskView | null) : TASK;
      if (task === null) {
        const err = new Error("unknown task_id 'task-1'") as Error & { kind?: string };
        err.kind = "task_not_found";
        throw err;
      }
      return { task };
    }
    if (key.startsWith("runs --task task-1")) {
      return { runs: [RUN, DERIVED_MISSED] };
    }
    if (args[0] === "set-enabled" || args[0] === "run-now" || args[0] === "delete") {
      return {};
    }
    if (args[0] === "update") {
      return { task: TASK };
    }
    if (args[0] === "reconcile") {
      return { materialized: 2 };
    }
    return {};
  };
}

describe("TaskDetailView", () => {
  test("loads get + runs and renders task info with derived missed honestly", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(detailCli());
    const view = new TaskDetailView(makeDeps(fn, ui), "task-1");
    await flush(20);
    const text = linesText(view.render(100, 40)).join("\n");
    expect(text).toContain("Daily standup");
    expect(text).toContain("task_id: task-1");
    expect(text).toContain("(derived)");
    expect(calls.some((c) => c.join(" ").startsWith("runs --task task-1"))).toBe(true);
  });

  test("missing task renders honest missing state", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(detailCli({ task: null }));
    const view = new TaskDetailView(makeDeps(fn, ui), "task-1");
    await flush(20);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("task not found: task-1");
  });

  test("run-now: confirm → revalidate → cli run-now", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true); // run-now confirm
    ui.confirmResults.push(true); // updated_at unchanged? no second confirm needed
    const { calls, fn } = fakeCli(detailCli());
    const view = new TaskDetailView(makeDeps(fn, ui), "task-1");
    await flush(20);
    view.handleKey?.(keyEvent("x"));
    await flush(30);
    expect(calls.some((c) => c[0] === "run-now" && c[1] === "task-1")).toBe(true);
    expect(ui.confirms[0]?.title).toContain("Run task now");
    expect(ui.confirms[0]?.consequence).toContain("delivers the prompt");
  });

  test("run-now cancelled by Esc-equivalent (confirm false) never calls CLI", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(false);
    const { calls, fn } = fakeCli(detailCli());
    const view = new TaskDetailView(makeDeps(fn, ui), "task-1");
    await flush(20);
    view.handleKey?.(keyEvent("x"));
    await flush(20);
    expect(calls.some((c) => c[0] === "run-now")).toBe(false);
  });

  test("delete: danger confirm → cli delete → view reports missing", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true); // delete confirm
    let deleted = false;
    const { calls, fn } = fakeCli((args) => {
      const key = args.join(" ");
      if (key === "get task-1") {
        if (deleted) {
          const err = new Error("gone") as Error & { kind?: string };
          err.kind = "task_not_found";
          throw err;
        }
        return { task: TASK };
      }
      if (args[0] === "delete") {
        deleted = true;
        return {};
      }
      if (key.startsWith("runs --task")) return { runs: [] };
      return {};
    });
    const view = new TaskDetailView(makeDeps(fn, ui), "task-1");
    await flush(20);
    view.handleKey?.(keyEvent("D"));
    await flush(30);
    expect(calls.some((c) => c[0] === "delete" && c[1] === "task-1")).toBe(true);
    expect(ui.confirms[0]?.danger).toBe(true);
  });

  test("toggle enable→disable is gated + confirmed + revalidated", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true); // disable confirm
    const { calls, fn } = fakeCli(detailCli());
    const view = new TaskDetailView(makeDeps(fn, ui), "task-1");
    await flush(20);
    view.handleKey?.(keyEvent("t")); // task is enabled → disable
    await flush(30);
    expect(calls.some((c) => c[0] === "set-enabled" && c[2] === "false")).toBe(true);
    expect(ui.confirms[0]?.title).toContain("Disable task");
  });

  test("stale task aborts mutation with honest status", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true); // run-now confirm
    let getCalls = 0;
    const { calls, fn } = fakeCli((args) => {
      const key = args.join(" ");
      if (key === "get task-1") {
        getCalls += 1;
        if (getCalls === 1) return { task: TASK };
        const err = new Error("gone") as Error & { kind?: string };
        err.kind = "task_not_found";
        throw err;
      }
      if (key.startsWith("runs --task")) return { runs: [] };
      return {};
    });
    const view = new TaskDetailView(makeDeps(fn, ui), "task-1");
    await flush(20);
    view.handleKey?.(keyEvent("x"));
    await flush(30);
    expect(calls.some((c) => c[0] === "run-now")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("stale");
  });

  test("mutations disabled when capability is null", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(detailCli());
    const deps = makeDeps(fn, ui, null);
    const view = new TaskDetailView(deps, "task-1");
    await flush(20);
    view.handleKey?.(keyEvent("x"));
    await flush(20);
    expect(calls.some((c) => c[0] === "run-now")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });
});

// --- RunsView ------------------------------------------------------------------------

describe("RunsView", () => {
  test("lists runs incl. derived missed; enter pushes detail", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => ({ runs: [RUN, DERIVED_MISSED] }));
    const view = new RunsView(makeDeps(fn, ui), "task-1");
    await flush(20);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("success");
    expect(text).toContain("(derived)");
    expect(calls.some((c) => c.includes("--task") && c.includes("task-1"))).toBe(true);

    feedKeys(view, "\r");
    expect(ui.pushed.length).toBe(1);
  });
});

// --- DriversView -----------------------------------------------------------------------

describe("DriversView", () => {
  test("open is read-only: only `list` is called, no schedule status/tick", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => ({ tasks: [TASK] }));
    const view = new DriversView(makeDeps(fn, ui));
    await flush(20);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("os-scheduler");
    expect(text).toContain("launchd agent loaded");
    expect(calls.every((c) => c[0] === "list")).toBe(true);
    expect(calls.some((c) => c[0] === "schedule")).toBe(false);
    expect(calls.some((c) => c[0] === "tick")).toBe(false);
  });

  test("empty registry shows honest no-tasks note", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => ({ tasks: [] }));
    const view = new DriversView(makeDeps(fn, ui));
    await flush(20);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("no tasks");
    expect(text).toContain("schedule status");
  });

  test("tick now is gated + confirmed + calls cli tick", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true);
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "list") return { tasks: [TASK] };
      if (args[0] === "tick") return { fired: [], missed_materialized: 0 };
      return {};
    });
    const view = new DriversView(makeDeps(fn, ui));
    await flush(20);
    view.handleKey?.(keyEvent("t"));
    await flush(30);
    expect(calls.some((c) => c[0] === "tick")).toBe(true);
    expect(ui.confirms[0]?.title).toContain("Run tick now");
  });

  test("schedule install requires confirm and gates on mutation_commands", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true);
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "list") return { tasks: [TASK] };
      if (args[0] === "schedule") return { driver: "os-scheduler" };
      return {};
    });
    const view = new DriversView(makeDeps(fn, ui));
    await flush(20);
    view.handleKey?.(keyEvent("i"));
    await flush(30);
    expect(calls.some((c) => c[0] === "schedule" && c[1] === "install")).toBe(true);
    expect(ui.confirms[0]?.consequence).toContain("launchd");
  });

  test("schedule status is explicit-only and gated", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "list") return { tasks: [TASK] };
      if (args.join(" ") === "schedule status") {
        return { schedule: { platform: "darwin", state: "installed", detail: "loaded" } };
      }
      return {};
    });
    const deps = makeDeps(fn, ui, null); // capability unavailable → fail closed
    const view = new DriversView(deps);
    await flush(20);
    view.handleKey?.(keyEvent("s"));
    await flush(20);
    expect(calls.some((c) => c[0] === "schedule")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });
});
