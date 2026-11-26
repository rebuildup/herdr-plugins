/**
 * rebuildup.controls interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the interactive agent browser.
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget) and
 * forwarded as HERDR_TUI_* env pins; every contract operation goes
 * through the plugin's own CLI subprocess so
 * `herdr-plugins.controls/v1` stays the single source of truth
 * (including its `--expect-*` stale-generation guards). Agent/pane
 * enumeration is a read-only `session.snapshot` via the documented
 * socket API — the controls contract has no list command by design.
 * Non-TTY stdin degrades to a plain-text agent list — never a fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import {
  buildPaneOpenParams,
  formatTargetLabel,
  openControlsPane,
  PLUGIN_VERSION,
  readAgent,
  readSessionAgents,
  resolvePinnedTarget,
  runControlsCli,
} from "./tui-support";
import {
  AgentDetailView,
  AgentListView,
  type ControlsTuiDeps,
  type ControlsTuiUi,
} from "./tui-views";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openControlsPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.controls", pane: result })}\n`,
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
    const session = await readSessionAgents();
    const agents = Object.entries(session.agents);
    if (agents.length === 0) {
      process.stdout.write("controls: no agents reported in session\n");
    }
    for (const [paneId, agent] of agents) {
      const kind = typeof agent.agent === "string" ? agent.agent : "agent";
      const status = typeof agent.agent_status === "string" ? agent.agent_status : "unknown";
      const seq = typeof agent.state_change_seq === "number" ? agent.state_change_seq : "?";
      process.stdout.write(`${paneId}\t${kind}\t${status}\tseq=${seq}\n`);
    }
    process.stdout.write(
      "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts <cmd>\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`controls tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList();
  }

  // Capability document for mutation gating (fail closed on error).
  let capability: ControlsTuiDeps["capability"] = null;
  try {
    capability = await runControlsCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Controls v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "s", description: "start agent on shell pane" },
      { keys: ["r", "R"], description: "refresh" },
    ],
    farewell: ["controls tui exited"],
  });

  const ui: ControlsTuiUi = app;
  let listView: AgentListView | null = null;
  const deps: ControlsTuiDeps = {
    cli: runControlsCli,
    ui,
    capability,
    target,
    agents: readSessionAgents,
    agentGet: readAgent,
    onChanged: () => {
      void listView?.load();
    },
  };

  listView = new AgentListView(deps, (paneId: string) => {
    app.push(new AgentDetailView(deps, paneId));
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
