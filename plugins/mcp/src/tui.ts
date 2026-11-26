/**
 * rebuildup.mcp diagnostics TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the read-only diagnostics browser.
 *
 * Scope (issue #248): DIAGNOSTICS ONLY. The stdio MCP server is never
 * screen-ified (ADR-0025/0033) — no `serve`, no tool invocation, no
 * mutations. Every read goes through the plugin's own `capability`
 * CLI so the public contract stays the single source of truth.
 * Non-TTY stdin degrades to a plain-text capability summary — never a
 * fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import { PLUGIN_VERSION } from "./model";
import {
  buildPaneOpenParams,
  formatOverviewLines,
  formatTargetLabel,
  openMcpPane,
  PLUGIN_ID,
  resolvePinnedTarget,
  runMcpCli,
} from "./tui-support";
import { McpOverviewView, type McpTuiDeps } from "./tui-views";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openMcpPane(params);
    process.stdout.write(`${JSON.stringify({ ok: true, plugin: PLUGIN_ID, pane: result })}\n`);
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
async function renderPlainSummary(): Promise<number> {
  try {
    const payload = await runMcpCli(["capability"], { timeoutMs: 120_000 });
    for (const line of formatOverviewLines(payload)) {
      process.stdout.write(`${line}\n`);
    }
    process.stdout.write(
      "hint: run inside a herdr pane (or a TTY) for the interactive TUI; diagnostics only — the MCP server itself is not screen-ified\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`mcp tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainSummary();
  }

  const app = await TuiApp.create({
    title: `MCP diagnostics v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "t", description: "tool table" },
      { keys: "p", description: "plugin availability" },
      { keys: "i", description: "contract reference" },
      { keys: ["r", "R"], description: "refresh" },
    ],
    farewell: ["mcp diagnostics tui exited"],
  });

  const ui: McpTuiDeps["ui"] = app;
  const deps: McpTuiDeps = { cli: runMcpCli, ui, target };
  app.setView(new McpOverviewView(deps));
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
          "  open — `open` action helper: plugin.pane.open (tab) for the diagnostics TUI\n" +
          "  main — interactive pane entrypoint (default); diagnostics only, read-only\n",
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
