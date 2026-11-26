/**
 * rebuildup.secrets interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033 + ADR-0027 secret boundary, issue #247).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the interactive bindings browser
 *                               (list/select, metadata-only resolve
 *                               preview, explicit run/inject).
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget)
 * and forwarded as HERDR_TUI_* env pins; every read/mutation goes
 * through the plugin's own CLI subprocess so the public contract
 * `herdr-plugins.secrets/v1` stays the single source of truth.
 * Non-TTY stdin degrades to a plain-text binding list — never a fake
 * UI, and NEVER secret values.
 *
 * `run` hand-off: the TUI closes (restoring the terminal), spawns
 * `cli.ts run --binding … -- <cmd>` with inherited stdio, waits, then
 * respawns `src/tui.ts main`. Resolved values flow only into the
 * child's environment — never argv, render, logs, or scrollback
 * (ADR-0027).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { TuiApp } from "../../../packages/tui/src/index";
import type { BindingView } from "./tui-support";
import {
  bindingSelectItem,
  buildPaneOpenParams,
  formatTargetLabel,
  openSecretsPane,
  parseBindings,
  pluginRoot,
  resolvePinnedTarget,
  runSecretsCli,
  spawnSecretsCliInherit,
} from "./tui-support";
import {
  BindingDetailView,
  SecretsListView,
  type SecretsTuiDeps,
  type SecretsTuiUi,
} from "./tui-views";

const PLUGIN_VERSION = "0.2.0";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openSecretsPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.secrets", pane: result })}\n`,
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

/**
 * Plain-text fallback for non-TTY stdin (pipes/CI): honest, read-only,
 * metadata only — binding names/env/ref, never values.
 */
async function renderPlainList(): Promise<number> {
  try {
    const payload = await runSecretsCli(["config"], { timeoutMs: 30_000 });
    const config =
      typeof payload.config === "object" && payload.config !== null
        ? (payload.config as Record<string, unknown>)
        : {};
    const bindings = parseBindings(config.bindings, payload.invalid_bindings);
    if (bindings.length === 0) {
      process.stdout.write("secrets: no bindings declared\n");
    }
    for (const b of bindings) {
      const item = bindingSelectItem(b);
      process.stdout.write(`${item.label}\n`);
      if (item.detail !== undefined) {
        for (const line of item.detail.split("\n")) {
          process.stdout.write(`\t${line}\n`);
        }
      }
    }
    process.stdout.write(
      "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts <cmd>\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`secrets tui: ${message}\n`);
    return 1;
  }
}

/**
 * `run` hand-off (ADR-0027): close the TUI so the terminal is restored,
 * run `cli.ts run --binding … -- <cmd>` with inherited stdio (values →
 * child env only), then respawn the TUI fresh and stay alive until the
 * respawned UI exits. `pending()` lets runMain wait for the whole
 * hand-off instead of exiting when `app.closed` resolves.
 */
function makeRunExternal(app: TuiApp): {
  run: (args: readonly string[]) => Promise<number>;
  pending: () => Promise<number> | null;
} {
  let handoff: Promise<number> | null = null;
  const run = (args: readonly string[]): Promise<number> => {
    const p = (async (): Promise<number> => {
      await app.close();
      process.stdout.write("\n");
      const result = await spawnSecretsCliInherit(args);
      if (result.error !== undefined) {
        process.stderr.write(`secrets run: spawn failed: ${result.error}\n`);
        return 1;
      }
      // Respawn the TUI so the user lands back on the bindings browser.
      const root = pluginRoot();
      const child = spawn(process.execPath, [path.join(root, "src", "tui.ts"), "main"], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      });
      return await new Promise<number>((resolve) => {
        child.on("error", () => resolve(1));
        child.on("close", (code) => resolve(code ?? 0));
      });
    })();
    handoff = p;
    return p;
  };
  return { run, pending: () => handoff };
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList();
  }

  const app = await TuiApp.create({
    title: `Secrets v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "r", description: "resolve preview (metadata only)" },
      { keys: "n", description: "run command w/ env (confirm)" },
      { keys: "i", description: "inject into new surface (confirm)" },
      { keys: "c", description: "capability / provider info" },
      { keys: "w", description: "init starter config (confirm)" },
      { keys: ["R"], description: "refresh" },
    ],
    farewell: ["secrets tui exited"],
  });

  const ui: SecretsTuiUi = app;
  const external = makeRunExternal(app);
  const deps: SecretsTuiDeps = {
    cli: runSecretsCli,
    ui,
    capability: null,
    target,
    bindings: [],
    runExternal: external.run,
  };

  let listView: SecretsListView | null = null;
  listView = new SecretsListView(deps, (binding: BindingView) => {
    app.push(new BindingDetailView(deps, binding.name));
  });
  app.setView(listView);
  void listView.load();
  await app.closed;
  // A `run` hand-off closes the app first; wait for the wrapped command
  // AND the respawned TUI so this process does not exit mid-flight.
  const handoff = external.pending();
  if (handoff !== null) return await handoff;
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
