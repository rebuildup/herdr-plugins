/**
 * rebuildup.textgen interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the generation console (task picker →
 *                               input form → provider → confirm →
 *                               generate → result review/copy).
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget) and
 * forwarded as HERDR_TUI_* env pins; every read/generate goes through
 * the plugin's own CLI subprocess so the public contract
 * `herdr-plugins.textgen/v1` stays the single source of truth.
 * Generation is NEVER auto-applied — results are review/copy only and
 * the contract persists nothing (#249). Non-TTY stdin degrades to a
 * plain-text task list — never a fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import { PLUGIN_VERSION } from "./model";
import {
  buildPaneOpenParams,
  formatTargetLabel,
  openTextgenPane,
  resolvePinnedTarget,
  runTextgenCli,
} from "./tui-support";
import { TaskListView, type TextgenTuiDeps, type TextgenTuiUi } from "./tui-views";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openTextgenPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.textgen", pane: result })}\n`,
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

/** Plain-text fallback for non-TTY stdin (pipes/CI): honest, read-only. */
async function renderPlainList(): Promise<number> {
  try {
    const payload = await runTextgenCli(["capability"], { timeoutMs: 30_000 });
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    if (tasks.length === 0) {
      process.stdout.write("textgen: capability reported no tasks\n");
    }
    for (const t of tasks) {
      const rec = typeof t === "object" && t !== null ? (t as Record<string, unknown>) : {};
      const kind = typeof rec.kind === "string" ? rec.kind : "?";
      const optIn = rec.requires_opt_in === true ? "\t(opt-in)" : "";
      const desc = typeof rec.description === "string" ? rec.description : "";
      process.stdout.write(`${kind}${optIn}\t${desc}\n`);
    }
    process.stdout.write(
      "hint: run inside a herdr pane (or a TTY) for the interactive TUI; " +
        "CLI: bun run src/cli.ts generate --task <kind> --input <file|->\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`textgen tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList();
  }

  // Capability document for task/provider metadata + mutation gating
  // (fail closed on error — generate stays disabled, honestly).
  let capability: TextgenTuiDeps["capability"] = null;
  try {
    capability = await runTextgenCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `TextGen v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "enter", description: "configure + generate" },
      { keys: "/", description: "filter tasks" },
      { keys: ["r", "R"], description: "refresh capability" },
    ],
    farewell: ["textgen tui exited"],
  });

  const ui: TextgenTuiUi = app;
  const deps: TextgenTuiDeps = {
    cli: runTextgenCli,
    ui,
    capability,
    target,
  };

  app.setView(new TaskListView(deps));
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
