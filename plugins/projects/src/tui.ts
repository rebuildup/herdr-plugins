/**
 * rebuildup.projects interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the interactive registry browser.
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget) and
 * forwarded as HERDR_TUI_* env pins; every read/mutation goes through
 * the plugin's own CLI subprocess so the public contract
 * `herdr-plugins.projects/v1` stays the single source of truth.
 * Non-TTY stdin degrades to a plain-text project list — never a fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import type { Project } from "./state";
import {
  buildPaneOpenParams,
  formatTargetLabel,
  openProjectsPane,
  resolvePinnedTarget,
  runProjectsCli,
} from "./tui-support";
import {
  ProjectDetailView,
  ProjectListView,
  type ProjectsTuiDeps,
  type ProjectsTuiUi,
} from "./tui-views";

const PLUGIN_VERSION = "0.4.0";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openProjectsPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.projects", pane: result })}\n`,
    );
    return 0;
  } catch (err) {
    const kind =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "pane_open_failed";
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ ok: false, error: { kind, message } })}\n`);
    return 1;
  }
}

// --- interactive main ------------------------------------------------------------

function asProjects(value: unknown): Project[] {
  return Array.isArray(value)
    ? (value.filter(
        (p): p is Project =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as Project).id === "string" &&
          typeof (p as Project).title === "string",
      ) as Project[])
    : [];
}

/** Plain-text fallback for non-TTY stdin (pipes/CI): honest, read-only. */
async function renderPlainList(): Promise<number> {
  try {
    const payload = await runProjectsCli(["list", "--all"], { timeoutMs: 30_000 });
    const projects = asProjects(payload.projects);
    if (projects.length === 0) {
      process.stdout.write("projects: registry empty\n");
    }
    for (const p of projects) {
      const badges = [p.pinned ? "pinned" : null, p.archived ? "archived" : null]
        .filter((b): b is string => b !== null)
        .join(",");
      process.stdout.write(
        `${p.id}\t${p.title}\trepos=${p.repos.length}${badges ? `\t${badges}` : ""}\n`,
      );
      for (const r of p.repos) {
        process.stdout.write(`\t${r.root}${r.remote !== null ? `\t${r.remote}` : ""}\n`);
      }
    }
    process.stdout.write(
      "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts <cmd>\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`projects tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList();
  }

  // Capability document for mutation gating (fail closed on error).
  let capability: ProjectsTuiDeps["capability"] = null;
  try {
    capability = await runProjectsCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Projects v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "n", description: "register repo as project" },
      { keys: "d", description: "discover repos from session" },
      { keys: "a", description: "toggle archived" },
      { keys: ["r", "R"], description: "refresh" },
    ],
    farewell: ["projects tui exited"],
  });

  const ui: ProjectsTuiUi = app;
  let listView: ProjectListView | null = null;
  const deps: ProjectsTuiDeps = {
    cli: runProjectsCli,
    ui,
    capability,
    target,
    onChanged: () => {
      void listView?.load();
    },
  };

  listView = new ProjectListView(deps, (project: Project) => {
    app.push(new ProjectDetailView(deps, project.id));
  });
  app.setView(listView);
  void listView.load();
  await app.closed;
  return 0;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? "main";
  switch (command) {
    case "open":
      return runOpen();
    case "main":
    case "--help":
    case "-h":
    case "help":
      if (command === "main") return runMain();
      process.stdout.write(
        "usage: bun run src/tui.ts <open|main>\n" +
          "  open — `open` action helper: plugin.pane.open (tab) for the TUI\n" +
          "  main — interactive pane entrypoint (default)\n",
      );
      return 0;
    default:
      process.stderr.write(`unknown tui command: ${command}\n`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { kind: "tui_error", message: String(err) } })}\n`,
    );
    process.exit(1);
  });
