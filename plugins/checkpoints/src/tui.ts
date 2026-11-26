/**
 * rebuildup.checkpoints interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the interactive checkpoint browser.
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget) and
 * forwarded as HERDR_TUI_* env pins; every read/mutation goes through
 * the plugin's own CLI subprocess so the public contract
 * `herdr-plugins.checkpoints/v1` stays the single source of truth.
 * Reads always pass `--no-drain` (read-only open — the lazy
 * pending-capture drain never fires implicitly); mutations name the
 * pinned pane id or an explicit repo path, never the UI pane's own
 * HERDR_PANE_ID. Non-TTY stdin degrades to a plain-text checkpoint
 * list — never a fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import type { CheckpointEntry } from "./state";
import {
  buildPaneOpenParams,
  checkpointKind,
  formatTargetLabel,
  openCheckpointsPane,
  readArgs,
  resolvePinnedTarget,
  runCheckpointsCli,
  shortId,
} from "./tui-support";
import { CheckpointListView, type CheckpointsTuiDeps, type CheckpointsTuiUi } from "./tui-views";

const PLUGIN_VERSION = "0.4.0";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openCheckpointsPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.checkpoints", pane: result })}\n`,
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

function asCheckpoints(value: unknown): CheckpointEntry[] {
  return Array.isArray(value)
    ? (value.filter(
        (e): e is CheckpointEntry =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as CheckpointEntry).id === "string" &&
          typeof (e as CheckpointEntry).repo_root === "string",
      ) as CheckpointEntry[])
    : [];
}

/** Plain-text fallback for non-TTY stdin (pipes/CI): honest, read-only. */
async function renderPlainList(): Promise<number> {
  try {
    const payload = await runCheckpointsCli(readArgs(["list", "--limit", "200"]), {
      timeoutMs: 30_000,
    });
    const checkpoints = asCheckpoints(payload.checkpoints);
    if (checkpoints.length === 0) {
      process.stdout.write("checkpoints: none\n");
    }
    for (const e of checkpoints) {
      const group = e.group_id !== undefined ? ` group:${shortId(e.group_id)}` : "";
      process.stdout.write(
        `${e.id}\t[${checkpointKind(e)}]${group}\t${e.repo_root}\t${e.created_at}\n`,
      );
    }
    process.stdout.write(
      "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts <cmd>\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`checkpoints tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList();
  }

  // Capability document for mutation gating (fail closed on error).
  // `capability` never drains pending captures, so this read is safe.
  let capability: CheckpointsTuiDeps["capability"] = null;
  try {
    capability = await runCheckpointsCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Checkpoints v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "c", description: "capture pinned pane repo" },
      { keys: "w", description: "capture by repo path" },
      { keys: "s", description: "save checkpoint group" },
      { keys: "g", description: "groups" },
      { keys: "G", description: "gc (dry-run first)" },
      { keys: "p", description: "prune (dry-run first)" },
      { keys: "a", description: "drain pending auto-captures" },
      { keys: "f", description: "repo filter" },
      { keys: ["r", "R"], description: "refresh" },
    ],
    farewell: ["checkpoints tui exited"],
  });

  const ui: CheckpointsTuiUi = app;
  const deps: CheckpointsTuiDeps = {
    cli: runCheckpointsCli,
    ui,
    capability,
    target,
  };

  const listView = new CheckpointListView(deps);
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
