/**
 * rebuildup.projects SCRIPTS interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md, issue #241).
 *
 * Dedicated script-first surface alongside the registry browser
 * (`tui.ts`/`main`). Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui-scripts.ts open   — `open-scripts` action helper:
 *                                       pins the origin context and
 *                                       calls `plugin.pane.open`
 *                                       (placement "tab"), then exits.
 *   bun run src/tui-scripts.ts main   — pane entrypoint
 *                                       (`[[panes]] id="scripts"`):
 *                                       the interactive scripts browser.
 *
 * `main` accepts an optional positional `<project|repo>` used ONLY by
 * the non-TTY fallback (plain `scripts list` output) — a GUI-less path
 * for dev-server repos (e.g. WSL) that never opens the alternate screen.
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget)
 * and forwarded as HERDR_TUI_* env pins; every read/mutation goes
 * through the plugin's own CLI subprocess so the public contract
 * `herdr-plugins.projects/v1` stays the single source of truth.
 * Non-TTY stdin degrades to plain text — never a fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import { type ProjectsTuiDeps, ScriptTargetView } from "./tui-scripts-views";
import {
  buildPaneOpenParams,
  formatScriptsPayload,
  formatTargetLabel,
  openProjectsPane,
  resolvePinnedTarget,
  runProjectsCli,
} from "./tui-support";

const PLUGIN_VERSION = "0.4.0";
const ENTRYPOINT = "scripts";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target, ENTRYPOINT);
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

// --- plain-text fallbacks (non-TTY) ----------------------------------------------

/** `scripts list <project|repo>` as plain text for pipes/CI/WSL shells. */
async function renderPlainScriptsList(target: string): Promise<number> {
  try {
    const payload = await runProjectsCli(["scripts", "list", target], { timeoutMs: 30_000 });
    for (const line of formatScriptsPayload(payload)) {
      process.stdout.write(`${line}\n`);
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`projects scripts tui: ${message}\n`);
    return 1;
  }
}

/** Registry overview when no target argument is given. */
async function renderPlainOverview(): Promise<number> {
  try {
    const payload = await runProjectsCli(["list", "--all"], { timeoutMs: 30_000 });
    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    if (projects.length === 0) {
      process.stdout.write("projects: registry empty\n");
    }
    for (const p of projects as Array<Record<string, unknown>>) {
      const repos = Array.isArray(p.repos) ? p.repos.length : 0;
      process.stdout.write(
        `${String(p.id)}\t${String(p.title)}\trepos=${repos}${p.archived === true ? "\tarchived" : ""}\n`,
      );
    }
    process.stdout.write(
      "hint: pass a <project|repo> argument for a plain script list, or run inside a herdr pane (TTY) for the interactive TUI; CLI: bun run src/cli.ts scripts <cmd>\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`projects scripts tui: ${message}\n`);
    return 1;
  }
}

// --- interactive main ------------------------------------------------------------

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();
  const positional = process.argv.slice(3).find((a) => !a.startsWith("-"));

  if (!process.stdin.isTTY) {
    return positional !== undefined ? renderPlainScriptsList(positional) : renderPlainOverview();
  }

  // Capability document for mutation gating (fail closed on error).
  let capability: ProjectsTuiDeps["capability"] = null;
  try {
    capability = await runProjectsCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Projects scripts v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: ["enter"], description: "open scripts for target" },
      { keys: "x", description: "run script (confirm)" },
      { keys: ["r", "R"], description: "refresh / runs" },
    ],
    farewell: ["projects scripts tui exited"],
  });

  const deps: ProjectsTuiDeps = {
    cli: runProjectsCli,
    ui: app,
    capability,
    target,
  };

  app.setView(new ScriptTargetView(deps));
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
        "usage: bun run src/tui-scripts.ts <open|main> [project|repo]\n" +
          "  open — `open-scripts` action helper: plugin.pane.open (tab) for the TUI\n" +
          "  main — interactive pane entrypoint (default); optional <project|repo>\n" +
          "         prints a plain scripts list when stdin is not a TTY\n",
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
