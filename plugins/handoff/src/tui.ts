/**
 * rebuildup.handoff interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the interactive record browser.
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget) and
 * forwarded as HERDR_TUI_* env pins; every contract operation goes
 * through the plugin's own CLI subprocess so
 * `herdr-plugins.handoff/v1` stays the single source of truth.
 * Pane/workspace enumeration for execute target pickers and
 * `pane.focus` for returning to the origin agent go through the
 * documented socket API. Detail open is strictly read-only
 * (`status --no-reconcile --no-resolve-refs`); ref resolution,
 * remote probes, and the delivered→done reconcile are explicit keys.
 * Non-TTY stdin degrades to a plain-text record list — never a fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import {
  buildPaneOpenParams,
  focusPane,
  formatTargetLabel,
  openHandoffPane,
  PLUGIN_VERSION,
  readSessionSurfaces,
  resolvePinnedTarget,
  runHandoffCli,
} from "./tui-support";
import {
  type HandoffTuiDeps,
  type HandoffTuiUi,
  RecordDetailView,
  RecordListView,
} from "./tui-views";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openHandoffPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.handoff", pane: result })}\n`,
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
    const payload = await runHandoffCli(["list", "--limit", "200"], { timeoutMs: 30_000 });
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length === 0) {
      process.stdout.write("handoff: no records\n");
    }
    for (const raw of items) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const transfer =
        typeof item.transfer === "object" && item.transfer !== null
          ? (item.transfer as Record<string, unknown>)
          : {};
      process.stdout.write(
        `${String(item.id)}\t${String(item.status)}\t${String(item.strategy)}\tpane ${String(transfer.pane_id ?? "?")}\n`,
      );
    }
    process.stdout.write(
      "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts <cmd>\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`handoff tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList();
  }

  // Capability document for mutation gating (fail closed on error).
  let capability: HandoffTuiDeps["capability"] = null;
  try {
    capability = await runHandoffCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Handoff v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "c", description: "create record from pane" },
      { keys: "f", description: "status filter" },
      { keys: ["r", "R"], description: "refresh" },
    ],
    farewell: ["handoff tui exited"],
  });

  const ui: HandoffTuiUi = app;
  let listView: RecordListView | null = null;
  const deps: HandoffTuiDeps = {
    cli: runHandoffCli,
    ui,
    capability,
    target,
    surfaces: readSessionSurfaces,
    focusPane,
    onChanged: () => {
      void listView?.load();
    },
  };

  listView = new RecordListView(deps, (id: string) => {
    app.push(new RecordDetailView(deps, id));
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
