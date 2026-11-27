/**
 * Tests for the rebuildup.projects TUI surface (#240,
 * contract docs/contracts/tui-v1.md).
 *
 * Covers the pure helpers (context pinning, pane-open params, mutation
 * gating, payload formatting) and the view layer with a fake CLI/ui —
 * no real herdr session, no TTY required.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import type { Project } from "../plugins/projects/src/state";
import {
  buildPaneOpenParams,
  formatDiscoverPayload,
  formatReposPayload,
  formatRunsPayload,
  formatScriptsPayload,
  formatTargetLabel,
  mutationAllowed,
  ProjectsCliError,
  parsePluginContext,
  projectHeaderLines,
  projectSelectItem,
  resolvePinnedTarget,
  runProjectsCli,
} from "../plugins/projects/src/tui-support";
import {
  ProjectDetailView,
  ProjectListView,
  type ProjectsTuiDeps,
  type ProjectsTuiUi,
} from "../plugins/projects/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "demo",
  title: "Demo Project",
  repos: [
    {
      root: "/repos/demo",
      remote: "github.com/example/demo",
      added_at: NOW,
    },
  ],
  pinned: false,
  archived: false,
  created_at: NOW,
  updated_at: NOW,
};

const CAPABILITY = {
  read_only: false,
  mutation_commands: [
    "register",
    "update",
    "repos add",
    "repos remove",
    "archive",
    "unarchive",
    "pin",
    "unpin",
    "settings set",
    "settings unset",
    "scripts run",
    "scripts stop",
  ],
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends ProjectsTuiUi {
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
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function fakeCli(handler: CliHandler): {
  calls: string[][];
  fn: ProjectsTuiDeps["cli"];
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
  cli: ProjectsTuiDeps["cli"],
  ui: FakeUi,
  capability: ProjectsTuiDeps["capability"] = CAPABILITY,
): ProjectsTuiDeps {
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
    expect(params.plugin_id).toBe("rebuildup.projects");
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
    const gate = mutationAllowed(null, "pin");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("unavailable");
  });
  test("read_only capability disables everything", () => {
    const gate = mutationAllowed({ read_only: true, mutation_commands: ["pin"] }, "pin");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("read_only");
  });
  test("listed command allowed, unlisted denied with reason", () => {
    expect(mutationAllowed(CAPABILITY, "pin").allowed).toBe(true);
    const denied = mutationAllowed(CAPABILITY, "scripts tick");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("scripts tick");
  });
});

// --- payload formatting --------------------------------------------------------------

describe("payload formatting", () => {
  test("projectSelectItem carries badges and repo detail", () => {
    const item = projectSelectItem({ ...PROJECT, pinned: true, archived: true });
    expect(item.label).toContain("Demo Project (demo)");
    expect(item.label).toContain("pinned");
    expect(item.label).toContain("archived");
    expect(item.detail).toContain("/repos/demo");
  });
  test("projectHeaderLines lists identity fields", () => {
    const lines = projectHeaderLines(PROJECT);
    expect(lines[0]).toContain("id: demo");
    expect(lines.join("\n")).toContain("repos: 1");
  });
  test("formatReposPayload renders live + worktree + skip data honestly", () => {
    const lines = formatReposPayload({
      project_id: "demo",
      repos: [
        {
          root: "/repos/demo",
          remote: "github.com/example/demo",
          added_at: NOW,
          branch: "main",
          dirty: true,
          has_submodules: false,
          worktree_submodules: null,
          worktrees_error: null,
          worktrees: [
            {
              path: "/repos/demo-wt",
              branch: "feature",
              dirty: false,
              open_workspace_id: "w1",
              panes_unavailable: false,
              panes: [
                {
                  pane_id: "w1:p2",
                  cwd: "/repos/demo-wt",
                  status: { branch: "feature" },
                  status_error: null,
                },
              ],
            },
            {
              path: "/repos/demo-closed",
              branch: null,
              dirty: null,
              open_workspace_id: null,
              panes_unavailable: false,
              panes: [],
            },
          ],
        },
        {
          root: "/repos/gone",
          remote: null,
          added_at: NOW,
          branch: null,
          dirty: null,
          has_submodules: null,
          worktrees: null,
          worktrees_error: { reason: "session_unreachable", detail: "socket gone" },
        },
      ],
      skipped: [{ root: "/repos/gone", reason: "not_a_repo" }],
      worktrees_skipped: [{ path: "/x", reason: "repo_mismatch", detail: "foreign" }],
    });
    const text = lines.join("\n");
    expect(text).toContain("/repos/demo");
    expect(text).toContain("branch: main");
    expect(text).toContain("/repos/demo-wt");
    expect(text).toContain("w1:p2");
    expect(text).toContain("not open");
    expect(text).toContain("session_unreachable");
    expect(text).toContain("not_a_repo");
    expect(text).toContain("repo_mismatch");
  });
  test("formatReposPayload empty + unknown fields stay honest", () => {
    const lines = formatReposPayload({ project_id: "demo", repos: [] });
    expect(lines.join("\n")).toContain("(no registered repos)");
    const lines2 = formatReposPayload({
      project_id: "demo",
      repos: [{ root: "/r", worktrees: null, worktrees_error: null }],
    });
    expect(lines2.join("\n")).toContain("worktrees: unknown");
    expect(lines2.join("\n")).toContain("branch: unknown");
  });
  test("formatScriptsPayload / formatRunsPayload / formatDiscoverPayload", () => {
    const scripts = formatScriptsPayload({
      project_id: "demo",
      repo_root: "/repos/demo",
      scripts: [
        {
          name: "test",
          id: "builtin:test",
          command: "bun test",
          source: "builtin",
          runOnWorktreeCreate: true,
        },
      ],
    });
    expect(scripts.join("\n")).toContain("test (builtin:test)");
    expect(scripts.join("\n")).toContain("runOnWorktreeCreate");

    const runs = formatRunsPayload({
      project_id: "demo",
      runs: [
        {
          run_id: "r1",
          script: { name: "test" },
          result: "success",
          exit_code: 0,
          repo: { root: "/repos/demo" },
          pane_id: "w1:p3",
          started_at: NOW,
          finished_at: NOW,
          trigger: { kind: "worktree.created" },
        },
      ],
    });
    const runsText = runs.join("\n");
    expect(runsText).toContain("r1");
    expect(runsText).toContain("success");
    expect(runsText).toContain("worktree.created");

    const discover = formatDiscoverPayload({
      repos: [{ root: "/repos/demo", remote: null, registered_project_id: "demo" }],
      skipped: [{ cwd: "/nowhere", reason: "not_a_repo" }],
    });
    const dText = discover.join("\n");
    expect(dText).toContain("registered → demo");
    expect(dText).toContain("not_a_repo");

    expect(formatRunsPayload({ runs: [] }).join("\n")).toContain("(no runs recorded)");
    expect(formatScriptsPayload({ scripts: [] }).join("\n")).toContain("(no scripts resolved)");
  });
});

// --- ProjectListView -----------------------------------------------------------------

describe("ProjectListView", () => {
  test("renders projects after load; empty registry shows honest empty text", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => ({ projects: [PROJECT] }));
    const view = new ProjectListView(makeDeps(fn, ui), () => {});
    await view.load();
    const text = linesText(view.render(80, 20)).join("\n");
    expect(text).toContain("Demo Project (demo)");

    const ui2 = fakeUi();
    const { fn: fn2 } = fakeCli(() => ({ projects: [] }));
    const empty = new ProjectListView(makeDeps(fn2, ui2), () => {});
    await empty.load();
    const emptyText = linesText(empty.render(80, 20)).join("\n");
    expect(emptyText).toContain("registry empty");
  });

  test("load failure renders the real error, not a fake list", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => {
      throw new ProjectsCliError("state lock timed out", "lock_timeout");
    });
    const view = new ProjectListView(makeDeps(fn, ui), () => {});
    await view.load();
    const text = linesText(view.render(80, 20)).join("\n");
    expect(text).toContain("failed to load projects");
    expect(text).toContain("lock_timeout");
  });

  test("enter opens the selected project; n runs gated register flow", async () => {
    const ui = fakeUi();
    const opened: string[] = [];
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "list") return { projects: [PROJECT] };
      if (args[0] === "register") return { project: { ...PROJECT, id: "new" } };
      return {};
    });
    const view = new ProjectListView(makeDeps(fn, ui), (p) => opened.push(p.id));
    await view.load();
    feedKeys(view, "\r"); // enter on first item
    expect(opened).toEqual(["demo"]);

    // register flow: gate → prompt path → prompt title → confirm → cli
    ui.promptResults.push("/tmp/newrepo", "");
    feedKeys(view, "n");
    await flush();
    const registerCall = calls.find((c) => c[0] === "register");
    expect(registerCall).toEqual(["register", "/tmp/newrepo"]);
    expect(ui.confirms.length).toBe(1);
    expect(ui.confirms[0]?.target?.join(" ")).toContain("/tmp/newrepo");
    // list reloaded after mutation
    expect(calls.filter((c) => c[0] === "list").length).toBeGreaterThanOrEqual(2);
  });

  test("mutations disabled when capability is null", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => ({ projects: [PROJECT] }));
    const deps = makeDeps(fn, ui, null);
    const view = new ProjectListView(deps, () => {});
    await view.load();
    ui.promptResults.push("/tmp/x");
    feedKeys(view, "n");
    await flush();
    expect(calls.some((c) => c[0] === "register")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });
});

// --- ProjectDetailView ---------------------------------------------------------------

function detailCli(overrides: Partial<Record<string, unknown>> = {}): CliHandler {
  return (args) => {
    const key = args.join(" ");
    if (key === "show demo") {
      const project = "project" in overrides ? (overrides.project as Project | null) : PROJECT;
      if (project === null) {
        throw new ProjectsCliError("project not found: demo", "project_not_found");
      }
      return { project };
    }
    if (key === "repos list demo") {
      return (
        (overrides.reposList as Record<string, unknown> | undefined) ?? {
          project_id: "demo",
          repos: [],
          skipped: [],
          worktrees_skipped: [],
        }
      );
    }
    if (args[0] === "pin" || args[0] === "unpin" || args[0] === "update") {
      return { project: PROJECT };
    }
    return {};
  };
}

describe("ProjectDetailView", () => {
  test("loads show + repos list and renders project info", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(detailCli());
    const view = new ProjectDetailView(makeDeps(fn, ui), "demo");
    await flush();
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("Demo Project");
    expect(text).toContain("/repos/demo");
    expect(calls.some((c) => c.join(" ") === "repos list demo")).toBe(true);
  });

  test("missing project renders honest missing state", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(detailCli({ project: null }));
    const view = new ProjectDetailView(makeDeps(fn, ui), "demo");
    await flush();
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("project not found: demo");
  });

  test("pin mutation: confirm → revalidate → cli pin → reload", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true); // pin confirm
    const { calls, fn } = fakeCli(detailCli());
    const view = new ProjectDetailView(makeDeps(fn, ui), "demo");
    await flush();
    view.handleKey?.(keyEvent("p"));
    await flush(20);
    expect(calls.some((c) => c[0] === "pin" && c[1] === "demo")).toBe(true);
    expect(ui.confirms[0]?.title).toContain("Pin project");
  });

  test("stale project aborts mutation with honest status", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true); // pin confirm
    let showCalls = 0;
    const { calls, fn } = fakeCli((args) => {
      if (args.join(" ") === "show demo") {
        showCalls += 1;
        if (showCalls === 1) return { project: PROJECT };
        throw new ProjectsCliError("project not found: demo", "project_not_found");
      }
      if (args.join(" ") === "repos list demo") {
        return { project_id: "demo", repos: [], skipped: [], worktrees_skipped: [] };
      }
      return {};
    });
    const view = new ProjectDetailView(makeDeps(fn, ui), "demo");
    await flush();
    view.handleKey?.(keyEvent("p"));
    await flush(20);
    expect(calls.some((c) => c[0] === "pin")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("stale");
  });

  test("changed updated_at asks before applying; cancel aborts", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true, false); // pin confirm, then "apply anyway" → no
    let showCalls = 0;
    const { calls, fn } = fakeCli((args) => {
      if (args.join(" ") === "show demo") {
        showCalls += 1;
        // First load sees the original; the pre-mutation revalidation sees
        // a newer updated_at — the stale-generation path.
        return {
          project:
            showCalls === 1 ? PROJECT : { ...PROJECT, updated_at: "2026-01-02T00:00:00.000Z" },
        };
      }
      if (args.join(" ") === "repos list demo") {
        return { project_id: "demo", repos: [], skipped: [], worktrees_skipped: [] };
      }
      return {};
    });
    const view = new ProjectDetailView(makeDeps(fn, ui), "demo");
    await flush();
    view.handleKey?.(keyEvent("p"));
    await flush(20);
    expect(calls.some((c) => c[0] === "pin")).toBe(false);
    expect(ui.confirms.length).toBe(2);
    expect(ui.confirms[1]?.title).toContain("changed since");
  });

  test("capability null disables mutations before any cli call", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(detailCli());
    const view = new ProjectDetailView(makeDeps(fn, ui, null), "demo");
    await flush();
    view.handleKey?.(keyEvent("p"));
    await flush(10);
    expect(calls.some((c) => c[0] === "pin")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });
});

// --- runProjectsCli (real subprocess, isolated state dir) ----------------------------

describe("runProjectsCli", () => {
  const dirs: string[] = [];
  const savedState = process.env.HERDR_PLUGIN_STATE_DIR;
  const savedConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    if (savedState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = savedState;
    if (savedConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = savedConfig;
  });

  function useIsolatedDirs(): void {
    const dir = mkdtempSync(path.join(tmpdir(), "projects-tui-cli-"));
    dirs.push(dir);
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
  }

  test("capability returns the contract document", async () => {
    useIsolatedDirs();
    const payload = await runProjectsCli(["capability"], { timeoutMs: 30_000 });
    expect(payload.contract).toBe("herdr-plugins.projects/v1");
    expect(Array.isArray(payload.mutation_commands)).toBe(true);
    expect((payload.mutation_commands as string[]).includes("pin")).toBe(true);
  });

  test("show on missing project throws ProjectsCliError with kind", async () => {
    useIsolatedDirs();
    try {
      await runProjectsCli(["show", "nope"], { timeoutMs: 30_000 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectsCliError);
      expect((err as ProjectsCliError).kind).toBe("project_not_found");
    }
  });

  test("list on empty registry returns empty projects", async () => {
    useIsolatedDirs();
    const payload = await runProjectsCli(["list"], { timeoutMs: 30_000 });
    expect(payload.command).toBe("list");
    expect(payload.projects).toEqual([]);
  });
});
