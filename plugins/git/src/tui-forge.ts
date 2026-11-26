/**
 * rebuildup.git forge TUI — `herdr-plugins.tui/v1`
 * (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md), issue #239.
 *
 * Two entry modes, both argv-only (no shell):
 *
 *   bun run src/tui-forge.ts open   — `open-forge` action helper: pins
 *                                     the origin context and calls
 *                                     `plugin.pane.open` (placement
 *                                     "tab", entrypoint "forge"), then
 *                                     exits promptly.
 *   bun run src/tui-forge.ts main   — pane entrypoint (`[[panes]]
 *                                     id="forge"`): the interactive
 *                                     PR/issue browser.
 *
 * Identity: the launch context is pinned once (resolvePinnedTarget) and
 * forwarded as HERDR_TUI_* env pins; the pinned ORIGIN pane id is passed
 * explicitly to every CLI call — never HERDR_PANE_ID (the UI pane's own
 * id), because the forge repo resolves from the target pane's cwd.
 * Every read/mutation goes through the plugin's own CLI subprocess so
 * the public contract `herdr-plugins.git/v1` stays the single source of
 * truth. Non-TTY stdin degrades to a plain-text PR/issue list — never a
 * fake UI.
 */

import { TuiApp } from "../../../packages/tui/src/index";
import {
  buildPaneOpenParams,
  formatTargetLabel,
  GitCliError,
  openForgePane,
  type PinnedTarget,
  resolvePinnedTarget,
  runGitCli,
} from "./tui-forge-support";
import {
  type ForgeHomeTarget,
  ForgeHomeView,
  type ForgeTuiDeps,
  type ForgeTuiUi,
  IssueDetailView,
  IssueListView,
  PrBranchStatusView,
  PrDetailView,
  PrListView,
} from "./tui-forge-views";

const PLUGIN_VERSION = "0.7.0";

// --- `open-forge` action helper -------------------------------------------------

async function runOpen(): Promise<number> {
  const target = resolvePinnedTarget();
  const params = buildPaneOpenParams(target);
  try {
    const result = await openForgePane(params);
    process.stdout.write(
      `${JSON.stringify({ ok: true, plugin: "rebuildup.git", pane: result })}\n`,
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

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "unknown";
  return String(value);
}

/**
 * Plain-text fallback for non-TTY stdin (pipes/CI): honest, read-only.
 * Prints the open PR list and issue list for the pinned pane; gh_missing
 * and other failures surface as real error lines, never fake data.
 */
async function renderPlainList(target: PinnedTarget): Promise<number> {
  const pane = target.originPaneId;
  if (pane === null) {
    process.stdout.write(
      "git forge tui: no pane pinned — launch from a pane context (or set HERDR_TUI_PANE_ID)\n" +
        "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts pr list <pane_id>\n",
    );
    return 0;
  }
  let failures = 0;
  try {
    const payload = await runGitCli(["pr", "list", pane, "--state", "open", "--limit", "30"]);
    const prs = asRecords(payload.prs);
    process.stdout.write(`prs (${fmt(payload.repo)}):\n`);
    if (prs.length === 0) process.stdout.write("  (none)\n");
    for (const pr of prs) {
      const draft = pr.isDraft === true ? " [draft]" : "";
      process.stdout.write(
        `  #${fmt(pr.number)} ${fmt(pr.title)} (${fmt(pr.state).toLowerCase()})${draft}\n`,
      );
    }
  } catch (err) {
    failures += 1;
    const kind = err instanceof GitCliError ? err.kind : "error";
    process.stderr.write(
      `pr list failed (${kind}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  try {
    const payload = await runGitCli(["issue", "list", pane, "--state", "open", "--limit", "30"]);
    const issues = asRecords(payload.issues);
    process.stdout.write(`issues (${fmt(payload.repo)}):\n`);
    if (issues.length === 0) process.stdout.write("  (none)\n");
    for (const issue of issues) {
      process.stdout.write(
        `  #${fmt(issue.number)} ${fmt(issue.title)} (${fmt(issue.state).toLowerCase()})\n`,
      );
    }
  } catch (err) {
    failures += 1;
    const kind = err instanceof GitCliError ? err.kind : "error";
    process.stderr.write(
      `issue list failed (${kind}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  process.stdout.write(
    "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: bun run src/cli.ts <cmd>\n",
  );
  return failures > 0 ? 1 : 0;
}

async function runMain(): Promise<number> {
  const target = resolvePinnedTarget();

  if (!process.stdin.isTTY) {
    return renderPlainList(target);
  }

  // Capability document for mutation gating (fail closed on error).
  let capability: ForgeTuiDeps["capability"] = null;
  try {
    capability = await runGitCli(["capability"], { timeoutMs: 30_000 });
  } catch {
    capability = null;
  }

  const app = await TuiApp.create({
    title: `Git Forge v${PLUGIN_VERSION} — ${formatTargetLabel(target)}`,
    keymap: [
      { keys: ["r", "R"], description: "refresh (in views)" },
      { keys: "p", description: "set forge pane id" },
      { keys: "o", description: "set repo override" },
    ],
    farewell: ["git forge tui exited"],
  });

  const ui: ForgeTuiUi = app;
  const deps: ForgeTuiDeps = {
    cli: runGitCli,
    ui,
    capability,
    target,
    forge: { paneId: target.originPaneId, repoOverride: null },
  };

  const openTarget = (which: ForgeHomeTarget): void => {
    switch (which) {
      case "prs":
        app.push(
          new PrListView(deps, (n) => {
            app.push(new PrDetailView(deps, n));
          }),
        );
        break;
      case "issues":
        app.push(
          new IssueListView(deps, (n) => {
            app.push(new IssueDetailView(deps, n));
          }),
        );
        break;
      case "pr-status":
        app.push(new PrBranchStatusView(deps));
        break;
    }
  };

  deps.onChanged = () => {
    // Mutations refresh their own view; ancestor lists reload on re-entry.
  };

  const home = new ForgeHomeView(deps, openTarget);
  app.setView(home);
  if (deps.forge.paneId === null) {
    app.setStatus("no pane pinned — press p to set a pane id (its cwd resolves the repo)");
  }
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
        "usage: bun run src/tui-forge.ts <open|main>\n" +
          "  open — `open-forge` action helper: plugin.pane.open (tab) for the forge TUI\n" +
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
