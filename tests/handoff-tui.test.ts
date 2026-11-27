/**
 * Tests for the rebuildup.handoff TUI surface (#245,
 * contract docs/contracts/tui-v1.md).
 *
 * Covers the pure helpers (context pinning, pane-open params, mutation
 * gating, record/status formatting, remote machine items, resume-info,
 * dry-run lines, focus guard) and the view layer with a fake
 * CLI/ui/surfaces — no real herdr session, no TTY required.
 */

import { describe, expect, test } from "bun:test";
import os from "node:os";
import type { PaneInfo, WorkspaceInfo } from "../packages/herdr-client/src/index";
import type {
  ConfirmOptions,
  SelectItem,
  SelectListOptions,
  TextInputOptions,
} from "../packages/tui/src/components";
import { type KeyEvent, KeyParser } from "../packages/tui/src/input";
import type { Line, ScreenView } from "../packages/tui/src/screen";
import { TaskRunner } from "../packages/tui/src/task";
import type { HandoffRecord } from "../plugins/handoff/src/model";
import {
  buildPaneOpenParams,
  canFocusSource,
  formatDryRunLines,
  formatResumeInfoLines,
  formatStatusLines,
  machineSelectItems,
  mutationAllowed,
  mutationTargetLines,
  parsePluginContext,
  recordSelectItem,
  resolvePinnedTarget,
  type SessionSurfaces,
} from "../plugins/handoff/src/tui-support";
import {
  type HandoffTuiDeps,
  type HandoffTuiUi,
  RecordDetailView,
  RecordListView,
} from "../plugins/handoff/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";

const RECORD: HandoffRecord = {
  contract: "herdr-plugins.handoff/v1",
  id: "ho-test1",
  created_at: NOW,
  updated_at: NOW,
  status: "ready",
  strategy: "portable_context",
  transfer: {
    host: os.hostname(),
    herdr_session: "work",
    session_key: "host+/tmp/herdr.sock",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p9",
    cwd: "/repo",
    provider_kind: "claude",
    agent_session: { agent: "claude", kind: "id", value: "sess-1" },
    state_change_seq: 3,
  },
  target: { pane_id: "w1:p2", provider_hint: "claude" },
  payload: { refs: [], excerpt: { text: "note", truncated: false, source: "note" } },
};

const LIST_ITEM = {
  id: "ho-test1",
  status: "ready",
  strategy: "portable_context",
  created_at: NOW,
  updated_at: NOW,
  relationship: null,
  child_count: 0,
  transfer: {
    host: os.hostname(),
    herdr_session: "work",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p9",
    provider_kind: "claude",
    agent_session: { value: "sess-1" },
    state_change_seq: 3,
  },
  target: { pane_id: "w1:p2" },
  target_pane_id: null,
  ref_count: 0,
  has_excerpt: true,
  transfer_check: { state: "ok" },
};

const STATUS_PAYLOAD = {
  contract: "herdr-plugins.handoff/v1",
  command: "status",
  handoff: RECORD,
  lineage: { relationship: null, parent: null, parent_missing: false, children: [] },
  transfer_check: { state: "ok" },
  target_check: { state: "ok", agent_status: "idle" },
  remote_check: { state: "unchecked", reason: "remote_flag_missing" },
  payload_resolution: null,
  missing_refs: null,
  state_file: "/tmp/state.json",
  generated_at: NOW,
};

const CAPABILITY = {
  read_only: false,
  mutation_commands: ["create", "status", "execute", "delegate", "merge-back"],
};

const PANE: PaneInfo = { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo" };
const WS: WorkspaceInfo = { workspace_id: "w1", title: "main", cwd: "/repo" };
const SURFACES: SessionSurfaces = {
  panes: [PANE],
  workspaces: [WS],
  agents: {},
  sessionName: "work",
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends HandoffTuiUi {
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
  fn: HandoffTuiDeps["cli"];
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
  cli: HandoffTuiDeps["cli"],
  ui: FakeUi,
  overrides: Partial<HandoffTuiDeps> = {},
): HandoffTuiDeps {
  return {
    cli,
    ui,
    capability: CAPABILITY,
    target: {
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      socketPath: "/tmp/herdr.sock",
      session: "work",
    },
    surfaces: () => Promise.resolve(SURFACES),
    focusPane: () => Promise.resolve({}),
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

function statusCli(overrides: Record<string, unknown> = {}): CliHandler {
  return (args) => {
    if (args[0] === "status") {
      return { ...STATUS_PAYLOAD, handoff: RECORD, ...overrides };
    }
    if (args[0] === "list") {
      return { items: [LIST_ITEM], total: 1, count: 1, truncated: false };
    }
    if (args[0] === "remote-probe") {
      return {
        mode: "list",
        machines: [
          { id: "m1", label: "build-box", target: "build@host", session: "remote", enabled: true },
        ],
      };
    }
    if (args[0] === "resume-info") {
      return {
        providers: [
          {
            kind: "claude",
            native_resume: "supported",
            session_id_source: "agent_session.value",
            resume_args_template: ["--resume", "{session_id}"],
            model_flag: "--model",
            notes: "claude resume",
          },
        ],
        notes: ["fallback note"],
      };
    }
    if (args[0] === "execute" && args.includes("--dry-run")) {
      return {
        dry_run: true,
        plan: { kind: "existing_pane", pane: { pane_id: "w1:p2", workspace_id: "w1" } },
        decision: { used: "portable_context", reason: "no resume", provider_kind: "claude" },
        prompt_text: "handoff payload…",
      };
    }
    if (args[0] === "delegate" && args.includes("--dry-run")) {
      return { dry_run: true, handoff: { ...RECORD, id: "ho-child" }, parent: RECORD.id };
    }
    if (args[0] === "merge-back" && args.includes("--dry-run")) {
      return {
        dry_run: true,
        handoff: { ...RECORD, id: "ho-result" },
        child: RECORD.id,
        parent: "ho-parent",
        prompt_text: "result…",
      };
    }
    if (
      args[0] === "execute" ||
      args[0] === "delegate" ||
      args[0] === "merge-back" ||
      args[0] === "create"
    ) {
      return { outcome: "delivered", handoff: { ...RECORD, status: "delivered" } };
    }
    return {};
  };
}

// --- context pinning -------------------------------------------------------------

describe("parsePluginContext / resolvePinnedTarget", () => {
  test("parses and pins with env precedence; HERDR_PANE_ID ignored", () => {
    expect(parsePluginContext('{"workspace_id":"w1"}').workspace_id).toBe("w1");
    expect(parsePluginContext("bad")).toEqual({});
    const target = resolvePinnedTarget({
      HERDR_TUI_WORKSPACE_ID: "w-pin",
      HERDR_PANE_ID: "ui:pane",
      HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_id":"w-ctx","focused_pane_id":"w-ctx:p2"}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w-pin");
    expect(target.originPaneId).toBe("w-ctx:p2");
  });
});

describe("buildPaneOpenParams", () => {
  test("tab placement + plugin id + env pins", () => {
    const params = buildPaneOpenParams({
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      socketPath: null,
      session: "work",
    });
    expect(params.plugin_id).toBe("rebuildup.handoff");
    expect(params.placement).toBe("tab");
    expect(params.entrypoint).toBe("main");
    const env = params.env as Record<string, string>;
    expect(env.HERDR_TUI_PANE_ID).toBe("w1:p9");
  });
});

describe("mutationAllowed", () => {
  test("fail closed / read_only / listed-unlisted", () => {
    expect(mutationAllowed(null, "execute").allowed).toBe(false);
    expect(mutationAllowed({ read_only: true }, "execute").allowed).toBe(false);
    expect(mutationAllowed(CAPABILITY, "execute").allowed).toBe(true);
    expect(mutationAllowed(CAPABILITY, "list").allowed).toBe(false);
  });
});

// --- payload formatting --------------------------------------------------------------

describe("record + status formatting", () => {
  test("recordSelectItem shows status/strategy/lineage badges", () => {
    const item = recordSelectItem({
      ...LIST_ITEM,
      relationship: { kind: "subagent_spawn", parent_id: "ho-parent" },
      child_count: 2,
    });
    expect(item.label).toContain("ho-test1");
    expect(item.label).toContain("ready");
    expect(item.label).toContain("subagent_spawn");
    expect(item.label).toContain("children:2");
    expect(item.detail).toContain("w1:p9");
  });

  test("formatStatusLines renders identity, execution, checks, ops", () => {
    const withExec = {
      ...STATUS_PAYLOAD,
      handoff: {
        ...RECORD,
        execution: {
          decided_at: NOW,
          strategy_used: "portable_context",
          provider_kind: "claude",
          decision: "no resume",
          resume_args: null,
          target: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", created: true },
          agent: {
            name: "ho-x",
            kind: "claude",
            pane_id: "w1:p2",
            agent_session: null,
            state_change_seq: 1,
            agent_status: "idle",
          },
          prompt: null,
          error: null,
          cleaned_up: false,
          observed: null,
        },
      },
    };
    const text = formatStatusLines(withExec).join("\n");
    expect(text).toContain("ho-test1");
    expect(text).toContain("w1:p9");
    expect(text).toContain("sess-1");
    expect(text).toContain("w1:p2");
    expect(text).toContain("portable_context");
    expect(text).toContain("target_check: ok");
    expect(text).toContain("payload refs: unresolved");
  });

  test("mutationTargetLines shows host/session/pane + remote explicitly", () => {
    const remoteRecord: HandoffRecord = {
      ...RECORD,
      execution: {
        decided_at: NOW,
        strategy_used: "portable_context",
        provider_kind: "claude",
        decision: "d",
        resume_args: null,
        target: null,
        agent: null,
        prompt: null,
        error: null,
        cleaned_up: false,
        observed: null,
        remote: {
          machine_id: "m1",
          label: "build-box",
          target: "build@host",
          session: "remote",
          enabled: true,
          probed_at: NOW,
          server_version: "0.9.5",
          protocol: 22,
        },
      },
    };
    const text = mutationTargetLines(remoteRecord, [
      "execute target: REMOTE machine build-box",
    ]).join("\n");
    expect(text).toContain("ho-test1");
    expect(text).toContain("w1:p9");
    expect(text).toContain("build-box");
    expect(text).toContain("build@host");
    expect(text).toContain("REMOTE machine");
  });

  test("machineSelectItems / formatResumeInfoLines / formatDryRunLines", () => {
    const items = machineSelectItems({
      machines: [
        { id: "m1", label: "box", target: "h", session: "s", enabled: true },
        { id: "m2", label: "off", target: "h2", session: "s2", enabled: false },
      ],
    });
    expect(items[0]?.value).toBe("m1");
    expect(items[1]?.disabled).toBe(true);

    const resume = formatResumeInfoLines({
      providers: [
        {
          kind: "claude",
          native_resume: "supported",
          session_id_source: "agent_session.value",
          resume_args_template: ["--resume", "{session_id}"],
          notes: "n",
        },
      ],
      notes: ["note1"],
    }).join("\n");
    expect(resume).toContain("claude");
    expect(resume).toContain("native_resume=supported");
    expect(resume).toContain("--resume");
    expect(resume).toContain("note1");

    const dry = formatDryRunLines({
      dry_run: true,
      plan: { kind: "existing_pane", pane: { pane_id: "w1:p2" } },
      decision: { used: "portable_context", reason: "r" },
      prompt_text: "hello",
    }).join("\n");
    expect(dry).toContain("existing_pane");
    expect(dry).toContain("w1:p2");
    expect(dry).toContain("hello");
    expect(dry).toContain("dry-run");
  });

  test("canFocusSource guards host+session", () => {
    const rec = RECORD;
    expect(canFocusSource(rec, { host: os.hostname(), session: "work" })).toBe(true);
    expect(canFocusSource(rec, { host: os.hostname(), session: "other" })).toBe(false);
    expect(canFocusSource(rec, { host: "elsewhere", session: "work" })).toBe(false);
    const nullSession: HandoffRecord = {
      ...RECORD,
      transfer: { ...RECORD.transfer, herdr_session: null },
    };
    expect(canFocusSource(nullSession, { host: os.hostname(), session: null })).toBe(true);
    expect(canFocusSource(nullSession, { host: os.hostname(), session: "work" })).toBe(false);
  });
});

// --- RecordListView -----------------------------------------------------------------

describe("RecordListView", () => {
  test("renders records; status filter passes --status; enter opens detail", async () => {
    const ui = fakeUi();
    const opened: string[] = [];
    const { calls, fn } = fakeCli(statusCli());
    const view = new RecordListView(makeDeps(fn, ui), (id) => opened.push(id));
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("ho-test1");

    feedKeys(view, "\r");
    expect(opened).toEqual(["ho-test1"]);

    ui.selectResults.push({ value: "ready", label: "ready" });
    feedKeys(view, "f");
    await flush();
    expect(calls.some((c) => c.join(" ") === "list --limit 200 --status ready")).toBe(true);
  });

  test("load failure renders real error", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => {
      throw new Error("state lock timeout");
    });
    const view = new RecordListView(makeDeps(fn, ui), () => {});
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("failed to load records");
    expect(text).toContain("state lock timeout");
  });

  test("create flow gated when capability null; happy path creates", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(statusCli());
    const gated = new RecordListView(makeDeps(fn, ui, { capability: null }), () => {});
    await gated.load();
    feedKeys(gated, "c");
    await flush();
    expect(calls.some((c) => c[0] === "create")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");

    // happy path
    const ui2 = fakeUi();
    const { calls: calls2, fn: fn2 } = fakeCli(statusCli());
    const view = new RecordListView(makeDeps(fn2, ui2), () => {});
    await view.load();
    ui2.selectResults.push(
      { value: PANE, label: "w1:p2" }, // source pane
      { value: "portable_context", label: "portable_context" }, // strategy
    );
    ui2.promptResults.push("my note", "", ""); // note, requirement, external
    feedKeys(view, "c");
    await flush(30);
    const createCall = calls2.find((c) => c[0] === "create");
    expect(createCall).toEqual([
      "create",
      "w1:p2",
      "--strategy",
      "portable_context",
      "--note",
      "my note",
    ]);
    expect(ui2.confirms[0]?.target?.join(" ")).toContain("w1:p2");
  });
});

// --- RecordDetailView -----------------------------------------------------------------

function detailDeps(
  ui: FakeUi,
  handler: CliHandler = statusCli(),
  overrides: Partial<HandoffTuiDeps> = {},
): { deps: HandoffTuiDeps; calls: string[][] } {
  const { calls, fn } = fakeCli(handler);
  const deps = makeDeps(fn, ui, overrides);
  return { deps, calls };
}

describe("RecordDetailView", () => {
  test("open is read-only: status --no-reconcile --no-resolve-refs", async () => {
    const ui = fakeUi();
    const { deps, calls } = detailDeps(ui);
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();
    const statusCalls = calls.filter((c) => c[0] === "status");
    expect(statusCalls[0]).toEqual(["status", "ho-test1", "--no-reconcile", "--no-resolve-refs"]);
    const text = linesText(view.render(110, 40)).join("\n");
    expect(text).toContain("ho-test1");
    expect(text).toContain("w1:p9");
    expect(text).toContain("sess-1");
    expect(text).toContain("target hint: pane w1:p2");
  });

  test("missing record renders honest missing state", async () => {
    const ui = fakeUi();
    const { deps } = detailDeps(ui, () => {
      throw new Error("handoff not found: ho-x");
    });
    const view = new RecordDetailView(deps, "ho-x");
    await flush();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("handoff not found: ho-x");
  });

  test("execute flow: auto target → dry-run → confirm identity → execute", async () => {
    const ui = fakeUi();
    const { deps, calls } = detailDeps(ui);
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();

    ui.selectResults.push({ value: "auto", label: "recorded target" }); // target mode
    ui.promptResults.push("", ""); // provider (prefilled→empty? no: prompt returns queued), model
    feedKeys(view, "x");
    await flush(40);

    // provider prompt had a prefilled value but our fake ignores opts and
    // returns the queued "" → providerValue "" → no --provider flag.
    const execCalls = calls.filter((c) => c[0] === "execute");
    expect(execCalls.some((c) => c.includes("--dry-run"))).toBe(true);
    const real = execCalls.find((c) => !c.includes("--dry-run"));
    expect(real).toEqual(["execute", "ho-test1"]);
    expect(ui.confirms.length).toBe(1);
    const confirmText = ui.confirms[0]?.target?.join(" ") ?? "";
    expect(confirmText).toContain("ho-test1");
    expect(confirmText).toContain("w1:p9");
    expect(confirmText).toContain("sess-1");
    expect(confirmText).toContain("existing_pane");
  });

  test("execute remote target shows machine identity in confirm", async () => {
    const ui = fakeUi();
    const { deps, calls } = detailDeps(ui);
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();

    ui.selectResults.push(
      { value: "remote", label: "remote machine" }, // mode
      { value: "m1", label: "build-box" }, // machine
    );
    ui.promptResults.push("", "");
    feedKeys(view, "x");
    await flush(40);

    const real = calls.find((c) => c[0] === "execute" && !c.includes("--dry-run"));
    expect(real).toEqual(["execute", "ho-test1", "--remote", "m1"]);
    const confirmText = ui.confirms[0]?.target?.join(" ") ?? "";
    expect(confirmText).toContain("build-box");
    expect(confirmText).toContain("build@host");
    expect(confirmText).toContain("REMOTE machine");
    expect(ui.confirms[0]?.danger).toBe(true);
  });

  test("stale record (updated_at drift) aborts execute", async () => {
    const ui = fakeUi();
    let statusCalls = 0;
    const { deps, calls } = detailDeps(ui, (args) => {
      if (args[0] === "status") {
        statusCalls += 1;
        return {
          ...STATUS_PAYLOAD,
          handoff: { ...RECORD, updated_at: statusCalls <= 1 ? NOW : "2026-01-02T00:00:00.000Z" },
        };
      }
      return statusCli()(args);
    });
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();

    ui.selectResults.push({ value: "auto", label: "auto" });
    ui.promptResults.push("", "");
    ui.confirmResults.push(false); // drift confirm → "Refresh instead"
    feedKeys(view, "x");
    await flush(40);

    expect(calls.some((c) => c[0] === "execute")).toBe(false);
    expect(ui.confirms[0]?.title).toContain("changed since this view opened");
  });

  test("merge-back requires a child record; gated ops refuse honestly", async () => {
    const ui = fakeUi();
    const { deps } = detailDeps(ui);
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();
    feedKeys(view, "m");
    await flush(20);
    // RECORD has no relationship → early honest status, no merge-back call yet.
    // (revalidate runs first: status payload still has no relationship)
    expect(ui.statuses.join(" ")).toContain("child record");

    // capability null → execute gated before any cli call
    const ui2 = fakeUi();
    const { calls: calls2, fn: fn2 } = fakeCli(statusCli());
    const gatedDeps = makeDeps(fn2, ui2, { capability: null });
    const view2 = new RecordDetailView(gatedDeps, "ho-test1");
    await flush();
    feedKeys(view2, "x");
    await flush(20);
    expect(calls2.some((c) => c[0] === "execute")).toBe(false);
    expect(ui2.statuses.join(" ")).toContain("disabled");
  });

  test("merge-back on a child record confirms parent delivery", async () => {
    const child: HandoffRecord = {
      ...RECORD,
      id: "ho-child",
      relationship: { kind: "subagent_spawn", parent_id: "ho-parent" },
    };
    const ui = fakeUi();
    const { deps, calls } = detailDeps(ui, (args) => {
      if (args[0] === "status") return { ...STATUS_PAYLOAD, handoff: child };
      if (args[0] === "merge-back" && args.includes("--dry-run")) {
        return { dry_run: true, handoff: { ...child, id: "ho-result" }, parent: "ho-parent" };
      }
      if (args[0] === "merge-back") {
        return { outcome: "delivered", handoff: { ...child, status: "delivered" } };
      }
      return {};
    });
    const view = new RecordDetailView(deps, "ho-child");
    await flush();
    ui.promptResults.push("done: shipped");
    feedKeys(view, "m");
    await flush(40);
    const mb = calls.find((c) => c[0] === "merge-back" && !c.includes("--dry-run"));
    expect(mb).toEqual(["merge-back", "ho-child", "--task", "done: shipped"]);
    const confirmText = ui.confirms[0]?.target?.join(" ") ?? "";
    expect(confirmText).toContain("ho-parent");
    expect(ui.confirms[0]?.consequence).toContain("agent.prompt");
  });

  test("resume-info is on-demand and pushes a detail view", async () => {
    const ui = fakeUi();
    const { deps, calls } = detailDeps(ui);
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();
    feedKeys(view, "i");
    await flush(20);
    expect(calls.some((c) => c[0] === "resume-info" && c.includes("--provider"))).toBe(true);
    expect(ui.pushed.length).toBe(1);
    const text = linesText(ui.pushed[0]?.render(100, 30) ?? []).join("\n");
    expect(text).toContain("claude");
    expect(text).toContain("native_resume=supported");
  });

  test("focus source pane guarded by host+session then pane.focus", async () => {
    const ui = fakeUi();
    const focused: string[] = [];
    const { deps } = detailDeps(ui, statusCli(), {
      focusPane: (paneId: string) => {
        focused.push(paneId);
        return Promise.resolve({});
      },
    });
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();
    feedKeys(view, "f");
    await flush(30);
    // RECORD host = os.hostname(), session "work" matches deps.target.session
    expect(focused).toEqual(["w1:p9"]);
    expect(ui.statuses.join(" ")).toContain("focused source pane");
  });

  test("focus refused for foreign-session record", async () => {
    const foreign: HandoffRecord = {
      ...RECORD,
      transfer: { ...RECORD.transfer, host: "other-host", herdr_session: "elsewhere" },
    };
    const ui = fakeUi();
    const focused: string[] = [];
    const { deps } = detailDeps(
      ui,
      (args) => (args[0] === "status" ? { ...STATUS_PAYLOAD, handoff: foreign } : {}),
      {
        focusPane: (paneId: string) => {
          focused.push(paneId);
          return Promise.resolve({});
        },
      },
    );
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();
    feedKeys(view, "f");
    await flush(20);
    expect(focused).toEqual([]);
    expect(ui.statuses.join(" ")).toContain("cannot focus source pane");
  });

  test("R refresh resolves refs; s reconcile is gated", async () => {
    const ui = fakeUi();
    const { deps, calls } = detailDeps(ui);
    const view = new RecordDetailView(deps, "ho-test1");
    await flush();
    view.handleKey?.(keyEvent("R"));
    await flush(20);
    const rCall = calls.filter((c) => c[0] === "status").pop();
    expect(rCall).toEqual(["status", "ho-test1", "--no-reconcile"]);

    view.handleKey?.(keyEvent("s"));
    await flush(20);
    const sCall = calls.filter((c) => c[0] === "status").pop();
    expect(sCall).toEqual(["status", "ho-test1"]);
  });
});
