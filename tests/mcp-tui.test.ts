/**
 * Tests for the rebuildup.mcp diagnostics TUI surface (#248,
 * contract docs/contracts/tui-v1.md).
 *
 * Covers the pure helpers (context pinning, pane-open params, access
 * ordering, capability-payload formatting) and the view layer with a
 * fake CLI/ui — no real herdr session, no TTY required. The surface is
 * diagnostics-only: no `serve`, no tool invocation, no mutations.
 */

import { describe, expect, test } from "bun:test";
import { type KeyEvent, KeyParser } from "../packages/tui/src/input";
import type { Line, ScreenView } from "../packages/tui/src/screen";
import { TaskRunner } from "../packages/tui/src/task";
import {
  accessRank,
  asPlugins,
  asTools,
  buildPaneOpenParams,
  formatOverviewLines,
  formatPluginLines,
  formatReferenceLines,
  formatTargetLabel,
  formatToolLines,
  McpCliError,
  parsePluginContext,
  pluginSelectItem,
  resolvePinnedTarget,
  runMcpCli,
  toolAvailableAt,
  toolSelectItem,
} from "../plugins/mcp/src/tui-support";
import {
  McpOverviewView,
  type McpTuiDeps,
  type McpTuiUi,
  PluginAvailabilityView,
  ToolTableView,
} from "../plugins/mcp/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const CAPABILITY = {
  contract: "herdr-plugins.mcp/v1",
  contract_status: "stable",
  surfaces: { read: "stable", mutation: "stable", events: "stable" },
  plugin: "rebuildup.mcp",
  version: "0.7.0",
  commands: ["capability", "serve", "help"],
  state_file: null,
  config_dir: "/cfg/plugins/rebuildup.mcp",
  socket: "/tmp/herdr.sock",
  session_resolution: {
    resolved_via: "env-socket",
    session_name_flag: null,
    rule: "--socket > --session/HERDR_SESSION > HERDR_SOCKET_PATH > default; pane env ignored",
  },
  session: { reachable: true, session_name: "default" },
  access_levels: {
    levels: ["read-only", "supervised", "full"],
    default: "read-only",
    semantics: "…",
  },
  negotiated_access_level: "read-only",
  tools: [
    {
      name: "herdr_capability",
      access: "read-only",
      read_only: true,
      status: "implemented",
      backs_onto: "contract + session.snapshot liveness",
    },
    {
      name: "agent_prompt",
      access: "supervised",
      read_only: false,
      status: "implemented",
      backs_onto: "rebuildup.controls send",
    },
    {
      name: "workspace_create",
      access: "supervised",
      read_only: false,
      status: "implemented",
      backs_onto: "herdr workspace.create",
    },
  ],
  plugins: [
    {
      plugin: "rebuildup.git",
      contract: "herdr-plugins.git/v1",
      available: true,
      resolved_via: "sibling",
    },
    {
      plugin: "rebuildup.controls",
      contract: "herdr-plugins.controls/v1",
      available: false,
      error: "rebuildup.controls plugin not found",
    },
  ],
  error_codes: ["capability_denied", "not_found"],
  upstream_gaps: [
    {
      id: "remote-mcp-http-oauth",
      summary: "no inbound HTTP/OAuth",
      tracking: "herdrdev/herdr#6199",
      v1: "excluded — local stdio only",
    },
  ],
  remote: {
    status: "excluded_v1",
    tracking: "herdrdev/herdr#6199",
    note: "local stdio only",
  },
  state: "no durable state in v1",
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends McpTuiUi {
  statuses: string[];
  pushed: ScreenView[];
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    statuses: [],
    pushed: [],
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
  fn: McpTuiDeps["cli"];
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

function makeDeps(cli: McpTuiDeps["cli"], ui: FakeUi): McpTuiDeps {
  return {
    cli,
    ui,
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

function keyEvent(key: string): KeyEvent {
  return { kind: "key", key, ctrl: false, shift: false, alt: false };
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
  test("tab placement + pinned env, workspace_id only when known", () => {
    const params = buildPaneOpenParams({
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      originCwd: "/repos/demo",
      socketPath: "/s",
      session: "default",
    });
    expect(params.plugin_id).toBe("rebuildup.mcp");
    expect(params.entrypoint).toBe("main");
    expect(params.placement).toBe("tab");
    expect(params.workspace_id).toBe("w1");
    const env = params.env as Record<string, string>;
    expect(env.HERDR_TUI_WORKSPACE_ID).toBe("w1");
    expect(env.HERDR_TUI_PANE_ID).toBe("w1:p9");
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

// --- access ordering ---------------------------------------------------------------

describe("access ordering", () => {
  test("rank follows contract order read-only < supervised < full", () => {
    expect(accessRank("read-only")).toBeLessThan(accessRank("supervised"));
    expect(accessRank("supervised")).toBeLessThan(accessRank("full"));
    expect(accessRank("bogus")).toBe(-1);
  });
  test("toolAvailableAt mirrors the server-side access floor", () => {
    expect(toolAvailableAt("read-only", "read-only")).toBe(true);
    expect(toolAvailableAt("supervised", "read-only")).toBe(false);
    expect(toolAvailableAt("supervised", "supervised")).toBe(true);
    expect(toolAvailableAt("supervised", "full")).toBe(true);
    expect(toolAvailableAt("full", "read-only")).toBe(false);
    expect(toolAvailableAt("bogus", "full")).toBeNull();
    expect(toolAvailableAt("read-only", 42)).toBeNull();
  });
});

// --- payload → view formatting ------------------------------------------------------

describe("payload parsing", () => {
  test("asTools/asPlugins tolerate missing and malformed entries", () => {
    expect(asTools(undefined)).toEqual([]);
    expect(asTools([null, { name: "x" }, "nope"])).toEqual([
      { name: "x", access: "unknown", readOnly: false, status: "unknown", backs_onto: "unknown" },
    ]);
    expect(asPlugins(undefined)).toEqual([]);
    expect(asPlugins([{ plugin: "p", available: true }])).toEqual([
      { plugin: "p", contract: "unknown", available: true, resolvedVia: null, error: null },
    ]);
  });
});

describe("payload formatting", () => {
  test("toolSelectItem + formatToolLines show the per-level matrix", () => {
    const tools = asTools(CAPABILITY.tools);
    const tool = tools[0] as (typeof tools)[number];
    const item = toolSelectItem(tool);
    expect(item.label).toBe("herdr_capability");
    expect(item.detail).toContain("read-only");

    const prompt = tools[1] as (typeof tools)[number];
    const lines = formatToolLines(prompt, "read-only");
    const text = lines.join("\n");
    expect(text).toContain("agent_prompt");
    expect(text).toContain("supervised");
    expect(text).toContain("read-only: capability_denied");
    expect(text).toContain("supervised: allowed");
    expect(text).toContain("full: allowed");
    expect(text).toContain("not screen-ified");
  });

  test("pluginSelectItem + formatPluginLines report availability honestly", () => {
    const plugins = asPlugins(CAPABILITY.plugins);
    expect(plugins).toHaveLength(2);
    const unavailable = plugins[1] as (typeof plugins)[number];
    const available = plugins[0] as (typeof plugins)[number];
    const item = pluginSelectItem(unavailable);
    expect(item.label).toContain("unavailable");
    const text = formatPluginLines(unavailable).join("\n");
    expect(text).toContain("available: no");
    expect(text).toContain("plugin not found");
    expect(text).toContain("plugin_unavailable");
    expect(formatPluginLines(available).join("\n")).toContain("resolved via: sibling");
  });

  test("formatOverviewLines summarizes the capability document", () => {
    const text = formatOverviewLines(CAPABILITY).join("\n");
    expect(text).toContain("herdr-plugins.mcp/v1");
    expect(text).toContain("stable");
    expect(text).toContain("reachable (session default)");
    expect(text).toContain("negotiated: read-only");
    expect(text).toContain("tools: 3 declared (3 implemented)");
    expect(text).toContain("plugins: 1 available / 1 unavailable");
    expect(text).toContain("unavailable: rebuildup.controls");
    expect(text).toContain("excluded_v1");
    expect(text).toContain("no durable state");
  });

  test("formatOverviewLines renders honest unknowns for absent fields", () => {
    const text = formatOverviewLines({}).join("\n");
    expect(text).toContain("contract: unknown");
    expect(text).toContain("session: unreachable");
    expect(text).toContain("tools: 0 declared");
  });

  test("formatReferenceLines lists error codes and upstream gaps", () => {
    const text = formatReferenceLines(CAPABILITY).join("\n");
    expect(text).toContain("capability_denied");
    expect(text).toContain("remote-mcp-http-oauth");
    expect(text).toContain("herdrdev/herdr#6199");
    expect(text).toContain("diagnostics only");
    expect(formatReferenceLines({}).join("\n")).toContain("(none reported)");
  });
});

// --- McpOverviewView -----------------------------------------------------------------

describe("McpOverviewView", () => {
  test("loads capability and renders the summary", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => CAPABILITY);
    const view = new McpOverviewView(makeDeps(fn, ui));
    await flush();
    expect(calls).toEqual([["capability"]]);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("herdr-plugins.mcp/v1");
    expect(text).toContain("negotiated: read-only");
    expect(text).toContain("1 available / 1 unavailable");
  });

  test("load failure renders the real error, not a fake summary", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => {
      throw new McpCliError("socket gone", "session_unreachable");
    });
    const view = new McpOverviewView(makeDeps(fn, ui));
    await flush();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("failed to load capability document");
    expect(text).toContain("session_unreachable");
    expect(text).toContain("socket gone");
  });

  test("t pushes the tool table; p pushes plugin availability; i pushes reference", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => CAPABILITY);
    const view = new McpOverviewView(makeDeps(fn, ui));
    await flush();

    view.handleKey?.(keyEvent("t"));
    expect(ui.pushed[0]).toBeInstanceOf(ToolTableView);
    view.handleKey?.(keyEvent("p"));
    expect(ui.pushed[1]).toBeInstanceOf(PluginAvailabilityView);
    view.handleKey?.(keyEvent("i"));
    expect(ui.pushed[2]).toBeDefined();
    view.handleKey?.(keyEvent("j"));
    expect(ui.pushed[3]).toBeDefined();
  });

  test("r re-fetches capability (refresh is user-triggered only)", async () => {
    const ui = fakeUi();
    let n = 0;
    const { calls, fn } = fakeCli(() => {
      n += 1;
      return { ...CAPABILITY, version: `0.7.0+${n}` };
    });
    const view = new McpOverviewView(makeDeps(fn, ui));
    await flush();
    view.handleKey?.(keyEvent("r"));
    await flush();
    expect(calls.filter((c) => c[0] === "capability")).toHaveLength(2);
  });
});

// --- ToolTableView ---------------------------------------------------------------------

describe("ToolTableView", () => {
  test("lists tools and enter pushes a detail view", async () => {
    const ui = fakeUi();
    const view = new ToolTableView(
      makeDeps(() => Promise.resolve({}), ui),
      CAPABILITY,
    );
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("agent_prompt");
    expect(text).toContain("workspace_create");

    feedKeys(view, "\r"); // enter on first item
    expect(ui.pushed).toHaveLength(1);
    const detail = ui.pushed[0] as ScreenView;
    const detailText = linesText(detail.render(100, 30)).join("\n");
    expect(detailText).toContain("herdr_capability");
    expect(detailText).toContain("read-only: allowed");
  });
});

// --- PluginAvailabilityView ---------------------------------------------------------------

describe("PluginAvailabilityView", () => {
  test("lists plugins with honest availability and enter pushes detail", async () => {
    const ui = fakeUi();
    const view = new PluginAvailabilityView(
      makeDeps(() => Promise.resolve({}), ui),
      CAPABILITY,
    );
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("rebuildup.git — available");
    expect(text).toContain("rebuildup.controls — unavailable");

    // move to the second (unavailable) entry, then enter
    view.handleKey?.(keyEvent("j"));
    feedKeys(view, "\r");
    expect(ui.pushed).toHaveLength(1);
    const pushed = ui.pushed[0] as ScreenView;
    const detailText = linesText(pushed.render(100, 30)).join("\n");
    expect(detailText).toContain("available: no");
    expect(detailText).toContain("plugin not found");
  });
});

// --- runMcpCli (real subprocess) ---------------------------------------------------------

describe("runMcpCli", () => {
  test("capability returns the contract document without a herdr session", async () => {
    const payload = await runMcpCli(["capability"], { timeoutMs: 60_000 });
    expect(payload.contract).toBe("herdr-plugins.mcp/v1");
    expect(payload.contract_status).toBe("stable");
    expect(payload.plugin).toBe("rebuildup.mcp");
    expect(Array.isArray(payload.tools)).toBe(true);
    expect((payload.tools as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(payload.plugins)).toBe(true);
    // No herdr session in tests: the probe reports honestly, never fakes reachability.
    const session = payload.session as Record<string, unknown>;
    expect(typeof session.reachable).toBe("boolean");
  });

  test("unknown command surfaces a structured cli error", async () => {
    try {
      await runMcpCli(["bogus-command"], { timeoutMs: 30_000 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(McpCliError);
      expect((err as McpCliError).exitCode).toBe(2);
    }
  });
});
