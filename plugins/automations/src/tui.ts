/**
 * rebuildup.automations interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the interactive automations browser.
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget)
 * and forwarded as HERDR_TUI_* env pins; every read/mutation goes
 * through the plugin's own CLI subprocess with `--socket <resolved>`
 * appended, so the UI always targets the SAME herdr session (and
 * session-namespaced task registry) it was launched in — schedule
 * management works GUI-less on WSL/SSH/headless hosts. Non-TTY stdin
 * degrades to a plain-text task list — never a fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import type { TaskView } from "./model";
import {
  buildPaneOpenParams,
  formatTargetLabel,
  openAutomationsPane,
  pinnedCliArgs,
  resolvePinnedTarget,
  runAutomationsCli,
} from "./tui-support";
import {
  type AutomationsTuiDeps,
  type AutomationsTuiUi,
  TaskDetailView,
  TaskListView,
} from "./tui-views";

const PLUGIN_VERSION = "0.8.0";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openAutomationsPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.automations", pane: result })}\n`,
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

function asTasks(value: unknown): TaskView[] {
  return Array.isArray(value)
    ? (value.filter(
        (t): t is TaskView =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as TaskView).task_id === "string" &&
          typeof (t as TaskView).name === "string",
      ) as TaskView[])
    : [];
}

/** Plain-text fallback for non-TTY stdin (pipes/CI): honest, read-only. */
async function renderPlainList(target: ReturnType<typeof resolvePinnedTarget>): Promise<number> {
  try {
    const cliArgs = pinnedCliArgs(target);
    const payload = await runAutomationsCli(["list", ...cliArgs], { timeoutMs: 30_000 });
    const tasks = asTasks(payload.tasks);
    if (tasks.length === 0) {
      process.stdout.write("automations: no tasks registered\n");
    }
    for (const t of tasks) {
      process.stdout.write(
        `${t.task_id}\t${t.name}\t${t.enabled ? "enabled" : "disabled"}\tnext=${t.next_run_at ?? "-"}\n`,
      );
    }
    process.stdout.write(
      `target: ${formatTargetLabel(target)}\n` +
        "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts <cmd>\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`automations tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList(target);
  }

  // Every CLI call pins the resolved socket so reads/mutations hit the
  // same herdr session the UI was launched in (tui-v1 §3.1).
  const sessionArgs = pinnedCliArgs(target);
  const cli = (
    args: readonly string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) => runAutomationsCli([...args, ...sessionArgs], options);

  // Capability document for mutation gating (fail closed on error).
  // `capability` output is the bare document (no ok-envelope).
  let capability: AutomationsTuiDeps["capability"] = null;
  try {
    capability = await cli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Automations v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "n", description: "new task" },
      { keys: "H", description: "run history" },
      { keys: "d", description: "driver diagnostics" },
      { keys: ["r", "R"], description: "refresh" },
    ],
    farewell: ["automations tui exited"],
  });

  const ui: AutomationsTuiUi = app;
  let listView: TaskListView | null = null;
  const deps: AutomationsTuiDeps = {
    cli,
    ui,
    capability,
    target,
    onChanged: () => {
      void listView?.load();
    },
  };

  listView = new TaskListView(deps, (task: TaskView) => {
    app.push(new TaskDetailView(deps, task.task_id));
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
