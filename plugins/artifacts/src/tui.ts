/**
 * rebuildup.artifacts interactive TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md, issue #247).
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui.ts open   — `open` action helper: pins the origin
 *                               context and calls `plugin.pane.open`
 *                               (placement "tab"), then exits promptly.
 *   bun run src/tui.ts main   — pane entrypoint (`[[panes]] id="main"`):
 *                               the interactive artifact registry
 *                               browser (list/search/detail/verify +
 *                               register/deliver/delete/gc).
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget) and
 * forwarded as HERDR_TUI_* env pins; every read/mutation goes through
 * the plugin's own CLI subprocess so the public contract
 * `herdr-plugins.artifacts/v1` stays the single source of truth.
 * Non-TTY stdin degrades to a plain-text artifact list — never a fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import type { ArtifactView } from "./tui-support";
import {
  artifactSelectItem,
  asArtifact,
  buildPaneOpenParams,
  formatTargetLabel,
  openArtifactsPane,
  resolvePinnedTarget,
  runArtifactsCli,
} from "./tui-support";
import {
  ArtifactDetailView,
  ArtifactListView,
  type ArtifactsTuiDeps,
  type ArtifactsTuiUi,
} from "./tui-views";

const PLUGIN_VERSION = "0.2.0";

// --- `open` action helper -------------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openArtifactsPane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.artifacts", pane: result })}\n`,
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
    const payload = await runArtifactsCli(["list", "--limit", "0"], { timeoutMs: 30_000 });
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    if (artifacts.length === 0) {
      process.stdout.write("artifacts: registry empty\n");
    }
    for (const raw of artifacts) {
      const artifact = asArtifact(raw);
      if (artifact === null) continue;
      const item = artifactSelectItem(artifact);
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
    process.stderr.write(`artifacts tui: ${message}\n`);
    return 1;
  }
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList();
  }

  // Capability document for mutation gating (fail closed on error).
  let capability: ArtifactsTuiDeps["capability"] = null;
  try {
    capability = await runArtifactsCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Artifacts v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: "s", description: "search artifacts" },
      { keys: "n", description: "register artifact" },
      { keys: "v", description: "verify all" },
      { keys: "g", description: "gc expired (dry-run first)" },
      { keys: ["r", "R"], description: "refresh" },
    ],
    farewell: ["artifacts tui exited"],
  });

  const ui: ArtifactsTuiUi = app;
  let listView: ArtifactListView | null = null;
  const deps: ArtifactsTuiDeps = {
    cli: runArtifactsCli,
    ui,
    capability,
    target,
    onChanged: () => {
      void listView?.load();
    },
  };

  listView = new ArtifactListView(deps, (artifact: ArtifactView) => {
    app.push(new ArtifactDetailView(deps, artifact.artifact_id, artifact));
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
