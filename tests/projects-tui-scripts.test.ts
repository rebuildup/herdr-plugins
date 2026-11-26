/**
 * Tests for the dedicated rebuildup.projects SCRIPTS TUI surface
 * (#241, contract docs/contracts/tui-v1.md).
 *
 * Covers the target picker (project / repo-path / all-runs), the script
 * list view (run gating + confirm + explicit --repo), the runs/results
 * view (project arg + client-side repo narrowing), the single-run view
 * (stop gating/confirm, honest active/unknown states, logs viewer),
 * and the paged text view — all with a fake CLI/ui, no real herdr.
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
import type { Project } from "../plugins/projects/src/state";
import {
  PagedTextView,
  ScriptListView,
  ScriptRunsView,
  ScriptRunView,
  type ScriptTarget,
  ScriptTargetView,
} from "../plugins/projects/src/tui-scripts-views";
import { buildPaneOpenParams } from "../plugins/projects/src/tui-support";
import type { ProjectsTuiDeps, ProjectsTuiUi } from "../plugins/projects/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "demo",
  title: "Demo Project",
  repos: [
    { root: "/repos/demo", remote: "github.com/example/demo", added_at: NOW },
    { root: "/repos/demo-api", remote: null, added_at: NOW },
  ],
  pinned: false,
  archived: false,
  created_at: NOW,
  updated_at: NOW,
};

const SINGLE_REPO_PROJECT: Project = {
  ...PROJECT,
  id: "solo",
  title: "Solo",
  repos: [{ root: "/repos/solo", remote: null, added_at: NOW }],
};

const CAPABILITY = {
  read_only: false,
  mutation_commands: ["scripts run", "scripts stop", "scripts tick"],
};

const SCRIPT_PAYLOAD = {
  contract: "herdr-plugins.projects/v1",
  command: "scripts list",
  project_id: "demo",
  repo_root: "/repos/demo",
  scripts: [
    {
      id: "t3.json:dev",
      name: "dev",
      command: "bun run dev",
      icon: null,
      runOnWorktreeCreate: false,
      source: "t3.json",
    },
    {
      id: "t3.json:test",
      name: "test",
      command: "bun test",
      icon: null,
      runOnWorktreeCreate: true,
      source: "t3.json",
    },
  ],
};

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run-abc123",
    project_id: "demo",
    script: { id: "t3.json:dev", name: "dev", command: "bun run dev", source: "t3.json" },
    repo: { root: "/repos/demo", remote: "github.com/example/demo" },
    pane_id: "w1:p7",
    workspace_id: "w1",
    tab_id: "w1:t1",
    cwd: "/repos/demo",
    command_line: "bun run dev # herdr-run run-abc123",
    script_path: null,
    shell_family: "posix",
    shell_source: "process_info",
    started_at: NOW,
    finished_at: null,
    exit_code: null,
    result: "running",
    host: "testhost",
    session_key: "testhost|/tmp/herdr.sock",
    stop_requested_at: null,
    log_path: null,
    error: null,
    ...overrides,
  };
}

const RESULTS_PAYLOAD = {
  contract: "herdr-plugins.projects/v1",
  command: "scripts results",
  project_id: "demo",
  runs: [
    makeRun(),
    makeRun({
      run_id: "run-old",
      result: "success",
      exit_code: 0,
      finished_at: NOW,
      repo: { root: "/repos/demo-api", remote: null },
    }),
    makeRun({
      run_id: "run-other",
      project_id: "other",
      repo: { root: "/repos/other", remote: null },
    }),
  ],
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends ProjectsTuiUi {
  statuses: string[];
  confirms: ConfirmOptions[];
  prompts: Array<{ text: string; opts: TextInputOptions | undefined }>;
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
    prompt(text: string, opts?: TextInputOptions) {
      ui.prompts.push({ text, opts });
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

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function projectTarget(overrides: Partial<ScriptTarget> = {}): ScriptTarget {
  return {
    listArg: "demo",
    repoRoot: "/repos/demo",
    projectId: "demo",
    projectTitle: "Demo Project",
    repos: PROJECT.repos,
    label: "Demo Project (demo)",
    ...overrides,
  };
}

// --- buildPaneOpenParams entrypoint ----------------------------------------------

describe("buildPaneOpenParams entrypoint", () => {
  test("defaults to main, accepts scripts entrypoint", () => {
    const base = {
      workspaceId: "w1",
      tabId: null,
      originPaneId: null,
      originCwd: null,
      socketPath: null,
      session: null,
    };
    expect(buildPaneOpenParams(base).entrypoint).toBe("main");
    expect(buildPaneOpenParams(base, "scripts").entrypoint).toBe("scripts");
  });
});

// --- PagedTextView -----------------------------------------------------------------

describe("PagedTextView", () => {
  test("renders title + lines, scrolls, closes on q", () => {
    let closed = 0;
    const view = new PagedTextView("t", ["l1", "l2", "l3"], () => {
      closed += 1;
    });
    const text = linesText(view.render(40, 10)).join("\n");
    expect(text).toContain("t");
    expect(text).toContain("l1");
    expect(text).toContain("l3");
    feedKeys(view, "j", "j");
    expect(view.handleKey(keyEvent("q"))).toBe(true);
    expect(closed).toBe(1);
  });
});

// --- ScriptTargetView ---------------------------------------------------------------

describe("ScriptTargetView", () => {
  test("loads projects + repo-path + all-runs choices", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "list") return { projects: [PROJECT] };
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptTargetView(makeDeps(cli.fn, ui));
    await flush();
    const text = linesText(view.render(80, 20)).join("\n");
    expect(text).toContain("Demo Project (demo)");
    expect(text).toContain("repo path…");
    expect(text).toContain("all runs");
  });

  test("project select with single repo pushes ScriptListView pinned to repo", async () => {
    const ui = fakeUi();
    ui.selectResult = { value: { kind: "project", project: SINGLE_REPO_PROJECT }, label: "x" };
    const cli = fakeCli((args) => {
      if (args[0] === "list") return { projects: [SINGLE_REPO_PROJECT] };
      if (args[0] === "scripts" && args[1] === "list") return SCRIPT_PAYLOAD;
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptTargetView(makeDeps(cli.fn, ui));
    await flush();
    feedKeys(view, "\r"); // enter on first item — but selection is via onSelect; simulate directly
    // SelectList onSelect fires on enter; ensure a ScriptListView got pushed.
    await flush();
    const pushed = ui.pushed.filter((v) => v instanceof ScriptListView);
    expect(pushed.length).toBe(1);
    const inner = pushed[0] as ScriptListView;
    await flush();
    expect(cli.calls.some((c) => c.join(" ") === "scripts list solo --repo /repos/solo")).toBe(
      true,
    );
    expect(inner).toBeDefined();
  });

  test("multi-repo project prompts repo pick before pushing list view", async () => {
    const ui = fakeUi();
    ui.selectResult = { value: "/repos/demo-api", label: "/repos/demo-api" };
    const cli = fakeCli((args) => {
      if (args[0] === "list") return { projects: [PROJECT] };
      if (args[0] === "scripts" && args[1] === "list") {
        return { ...SCRIPT_PAYLOAD, repo_root: "/repos/demo-api" };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptTargetView(makeDeps(cli.fn, ui));
    await flush();
    // select the project item programmatically through its onSelect path:
    // enter selects current item (first = project).
    feedKeys(view, "\r");
    await flush();
    // repo picker consumed ui.selectResult
    const pushed = ui.pushed.filter((v) => v instanceof ScriptListView);
    expect(pushed.length).toBe(1);
    await flush();
    expect(cli.calls.some((c) => c.join(" ") === "scripts list demo --repo /repos/demo-api")).toBe(
      true,
    );
  });

  test("repo-path choice prompts and pushes list view for the path", async () => {
    const ui = fakeUi();
    ui.promptResults = ["/repos/wsl-app"];
    const cli = fakeCli((args) => {
      if (args[0] === "list") return { projects: [] };
      if (args[0] === "scripts" && args[1] === "list") {
        return { project_id: null, repo_root: "/repos/wsl-app", scripts: [] };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptTargetView(makeDeps(cli.fn, ui));
    await flush();
    // move cursor to "repo path…" (index 0 when no projects) then enter
    feedKeys(view, "\r");
    await flush();
    expect(ui.prompts.length).toBe(1);
    const pushed = ui.pushed.filter((v) => v instanceof ScriptListView);
    expect(pushed.length).toBe(1);
    await flush();
    expect(cli.calls.some((c) => c.join(" ") === "scripts list /repos/wsl-app")).toBe(true);
  });
});

// --- ScriptListView -----------------------------------------------------------------

describe("ScriptListView", () => {
  test("loads scripts and renders name/command/source", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "scripts" && args[1] === "list") return SCRIPT_PAYLOAD;
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptListView(makeDeps(cli.fn, ui), projectTarget());
    await flush();
    const text = linesText(view.render(80, 20)).join("\n");
    expect(text).toContain("dev");
    expect(text).toContain("bun run dev");
    expect(cli.calls[0]?.join(" ")).toBe("scripts list demo --repo /repos/demo");
  });

  test("run is gated when capability unavailable", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => SCRIPT_PAYLOAD);
    const view = new ScriptListView(makeDeps(cli.fn, ui, null), projectTarget());
    await flush();
    feedKeys(view, "x");
    await flush();
    expect(ui.confirms.length).toBe(0);
    expect(ui.statuses.join("\n")).toContain("mutations disabled");
    expect(cli.calls.every((c) => c[1] !== "run")).toBe(true);
  });

  test("run confirm shows exact target and invokes scripts run --repo", async () => {
    const ui = fakeUi();
    ui.confirmResults = [true];
    const cli = fakeCli((args) => {
      if (args[1] === "list") return SCRIPT_PAYLOAD;
      if (args[1] === "run") {
        return {
          command: "scripts run",
          run: { run_id: "run-new", result: "running" },
        };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptListView(makeDeps(cli.fn, ui), projectTarget());
    await flush();
    feedKeys(view, "x");
    await flush(20);
    expect(ui.confirms.length).toBe(1);
    const confirm = ui.confirms[0] as ConfirmOptions;
    expect(confirm.title).toContain("dev");
    expect(confirm.target?.join("\n")).toContain("project: demo");
    expect(confirm.target?.join("\n")).toContain("/repos/demo");
    const runCall = cli.calls.find((c) => c[1] === "run");
    expect(runCall).toEqual(["scripts", "run", "demo", "dev", "--repo", "/repos/demo"]);
    expect(ui.statuses.join("\n")).toContain("run-new");
  });

  test("unregistered repo-path target cannot run — honest status", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[1] === "list") {
        return { project_id: null, repo_root: "/repos/wsl-app", scripts: SCRIPT_PAYLOAD.scripts };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptListView(
      makeDeps(cli.fn, ui),
      projectTarget({
        listArg: "/repos/wsl-app",
        repoRoot: null,
        projectId: null,
        projectTitle: null,
        repos: [],
        label: "/repos/wsl-app",
      }),
    );
    await flush();
    feedKeys(view, "x");
    await flush();
    expect(ui.confirms.length).toBe(0);
    expect(ui.statuses.join("\n")).toContain("not a registered project");
  });

  test("repo-path target owned by a project resolves project_id and runs with --repo", async () => {
    const ui = fakeUi();
    ui.confirmResults = [true];
    const cli = fakeCli((args) => {
      if (args[1] === "list") {
        return { ...SCRIPT_PAYLOAD, project_id: "demo", repo_root: "/repos/demo" };
      }
      if (args[1] === "run") {
        return { command: "scripts run", run: { run_id: "run-x", result: "running" } };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptListView(
      makeDeps(cli.fn, ui),
      projectTarget({
        listArg: "/repos/demo",
        repoRoot: null,
        projectId: null,
        projectTitle: null,
        repos: [],
        label: "/repos/demo",
      }),
    );
    await flush();
    feedKeys(view, "x");
    await flush(20);
    const runCall = cli.calls.find((c) => c[1] === "run");
    expect(runCall).toEqual(["scripts", "run", "demo", "dev", "--repo", "/repos/demo"]);
  });
});

// --- ScriptRunsView -------------------------------------------------------------------

describe("ScriptRunsView", () => {
  test("passes project filter and narrows by repo client-side", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[1] === "results") return RESULTS_PAYLOAD;
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptRunsView(makeDeps(cli.fn, ui), {
      projectId: "demo",
      repoRoot: "/repos/demo",
      label: "demo @ /repos/demo",
    });
    await flush(20);
    expect(cli.calls[0]).toEqual(["scripts", "results", "demo"]);
    const text = linesText(view.render(100, 20)).join("\n");
    // run-abc123 (repo /repos/demo) shown; run-old (/repos/demo-api) and
    // run-other (other repo) filtered out.
    expect(text).toContain("run-abc123");
    expect(text).not.toContain("run-old");
    expect(text).not.toContain("run-other");
  });

  test("no repo filter shows all project runs including other repos", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[1] === "results") {
        // Emulate the CLI contract: `scripts results <project>` filters
        // server-side by project_id.
        return {
          ...RESULTS_PAYLOAD,
          runs: RESULTS_PAYLOAD.runs.filter((r) => r.project_id === "demo"),
        };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptRunsView(makeDeps(cli.fn, ui), {
      projectId: "demo",
      label: "demo",
    });
    await flush(20);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("run-abc123");
    expect(text).toContain("run-old");
    expect(text).not.toContain("run-other"); // different project_id
  });

  test("selecting a run pushes ScriptRunView", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[1] === "results") return RESULTS_PAYLOAD;
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptRunsView(makeDeps(cli.fn, ui), { label: "all" });
    await flush(20);
    feedKeys(view, "\r");
    await flush();
    const pushed = ui.pushed.filter((v) => v instanceof ScriptRunView);
    expect(pushed.length).toBe(1);
  });
});

// --- ScriptRunView ---------------------------------------------------------------------

describe("ScriptRunView", () => {
  test("detail lines render honest running state", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => {
      throw new Error("no cli expected");
    });
    const view = new ScriptRunView(makeDeps(cli.fn, ui), makeRun());
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("run-abc123");
    expect(text).toContain("result: running");
    expect(text).toContain("may finalize");
    expect(text).toContain("w1:p7");
  });

  test("unknown result renders honest note", () => {
    const ui = fakeUi();
    const cli = fakeCli(() => {
      throw new Error("no cli expected");
    });
    const view = new ScriptRunView(
      makeDeps(cli.fn, ui),
      makeRun({ result: "unknown", error: "pane gone before stop could be confirmed" }),
    );
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("result: unknown");
    expect(text).toContain("rather than guessing");
    expect(text).toContain("pane gone before stop could be confirmed");
  });

  test("stop on inactive run refuses without confirm", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => {
      throw new Error("no cli expected");
    });
    const view = new ScriptRunView(
      makeDeps(cli.fn, ui),
      makeRun({ result: "success", exit_code: 0, finished_at: NOW }),
    );
    feedKeys(view, "s");
    await flush();
    expect(ui.confirms.length).toBe(0);
    expect(ui.statuses.join("\n")).toContain("not active");
  });

  test("stop is gated, confirmed with pane identity, then refreshes", async () => {
    const ui = fakeUi();
    ui.confirmResults = [true];
    const stoppedRun = makeRun({ result: "stopped", finished_at: NOW });
    const cli = fakeCli((args) => {
      if (args[1] === "stop") {
        return {
          command: "scripts stop",
          outcomes: [{ run: { run_id: "run-abc123" }, action: "stopped" }],
        };
      }
      if (args[1] === "logs") {
        return {
          command: "scripts logs",
          run_id: "run-abc123",
          run: stoppedRun,
          log: null,
          log_path: null,
        };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptRunView(makeDeps(cli.fn, ui), makeRun());
    feedKeys(view, "s");
    await flush(25);
    expect(ui.confirms.length).toBe(1);
    const confirm = ui.confirms[0] as ConfirmOptions;
    expect(confirm.danger).toBe(true);
    expect(confirm.target?.join("\n")).toContain("run: run-abc123");
    expect(confirm.target?.join("\n")).toContain("w1:p7");
    expect(cli.calls.some((c) => c.join(" ") === "scripts stop run-abc123")).toBe(true);
    expect(cli.calls.some((c) => c.join(" ") === "scripts logs run-abc123")).toBe(true);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("result: stopped");
    expect(ui.statuses.join("\n")).toContain("stopped");
  });

  test("stop denied when capability lacks scripts stop", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => {
      throw new Error("no cli expected");
    });
    const view = new ScriptRunView(
      makeDeps(cli.fn, ui, { read_only: false, mutation_commands: ["scripts run"] }),
      makeRun(),
    );
    feedKeys(view, "s");
    await flush();
    expect(ui.confirms.length).toBe(0);
    expect(ui.statuses.join("\n")).toContain("mutations disabled");
  });

  test("logs view renders bounded tail and honest empty log", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[1] === "logs") {
        return {
          command: "scripts logs",
          run_id: "run-abc123",
          run: makeRun({ result: "success", exit_code: 0, finished_at: NOW }),
          log_path: "runs/run-abc123.log",
          log: "line1\nline2\n",
        };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptRunView(makeDeps(cli.fn, ui), makeRun());
    feedKeys(view, "l");
    await flush(20);
    const logsView = ui.pushed[ui.pushed.length - 1];
    expect(logsView).toBeInstanceOf(PagedTextView);
    const text = linesText((logsView as PagedTextView).render(100, 30)).join("\n");
    expect(text).toContain("logs — run-abc123");
    expect(text).toContain("line1");
    expect(text).toContain("line2");
    expect(text).toContain("runs/run-abc123.log");
  });

  test("logs view reports null log honestly", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[1] === "logs") {
        return {
          command: "scripts logs",
          run_id: "run-abc123",
          run: makeRun(),
          log_path: null,
          log: null,
        };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const view = new ScriptRunView(makeDeps(cli.fn, ui), makeRun());
    feedKeys(view, "l");
    await flush(20);
    const logsView = ui.pushed[ui.pushed.length - 1];
    const text = linesText((logsView as PagedTextView).render(100, 30)).join("\n");
    expect(text).toContain("no log captured");
    expect(text).toContain("nothing is fabricated");
  });
});
