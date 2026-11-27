/**
 * rebuildup.machines interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033 + ADR-0028 read-only inventory, issue #247).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the interactive machines inventory
 *                               (list + on-demand probe + capability).
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget)
 * and forwarded as HERDR_TUI_* env pins; every read goes through the
 * plugin's own CLI subprocess so the public contract
 * `herdr-plugins.machines/v1` stays the single source of truth.
 * Non-TTY stdin degrades to a plain-text machine list — never a fake
 * UI. The plugin is READ-ONLY: machine lifecycle stays with the herdr
 * CLI; the TUI exposes no mutating affordance.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import type { MachineItem } from "./tui-support";
import {
  buildPaneOpenParams,
  formatTargetLabel,
  openMachinesPane,
  resolvePinnedTarget,
  runMachinesCli,
} from "./tui-support";
import {
  MachineDetailView,
  MachinesListView,
  type MachinesTuiDeps,
  type MachinesTuiUi,
} from "./tui-views";

const PLUGIN_VERSION = "0.1.0";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openMachinesPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.machines", pane: result })}\n`,
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
    const payload = await runMachinesCli(["list"], { timeoutMs: 30_000 });
    const machines = Array.isArray(payload.machines) ? payload.machines : [];
    if (machines.length === 0) {
      process.stdout.write("machines: no saved machines\n");
    }
    for (const raw of machines) {
      const rec = raw as Record<string, unknown>;
      const m = (rec.machine ?? {}) as Record<string, unknown>;
      const probe = (rec.last_probe ?? null) as Record<string, unknown> | null;
      const id = typeof m.id === "string" ? m.id : "?";
      const label = typeof m.label === "string" ? m.label : id;
      const target = typeof m.target === "string" ? m.target : "?";
      const enabled = m.enabled !== false;
      const probeState = probe !== null && typeof probe.state === "string" ? probe.state : "never";
      process.stdout.write(
        `${label} (${id})\ttarget=${target}\tenabled=${enabled}\tprobe=${probeState}\n`,
      );
    }
    process.stdout.write(
      "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts <cmd>\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`machines tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList();
  }

  // Capability document for the info view (offline; fail soft — the
  // list itself reports reachability honestly).
  let capability: MachinesTuiDeps["capability"] = null;
  try {
    capability = await runMachinesCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Machines v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "p", description: "probe selected machine" },
      { keys: "a", description: "probe all machines" },
      { keys: "i", description: "capability / contract info" },
      { keys: ["r", "R"], description: "refresh" },
    ],
    farewell: ["machines tui exited"],
  });

  const ui: MachinesTuiUi = app;
  let listView: MachinesListView | null = null;
  const deps: MachinesTuiDeps = {
    cli: runMachinesCli,
    ui,
    capability,
    target,
    onChanged: () => {
      void listView?.load();
    },
  };

  listView = new MachinesListView(deps, (item: MachineItem) => {
    app.push(new MachineDetailView(deps, item));
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
