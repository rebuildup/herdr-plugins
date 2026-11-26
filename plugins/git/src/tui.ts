#!/usr/bin/env bun
/**
 * rebuildup.git TUI entrypoint (`herdr-plugins.tui/v1`).
 *
 * Modes:
 *   bun run src/tui.ts            — open the interactive UI (pane `main`)
 *   bun run src/tui.ts --open     — action helper: `herdr plugin pane open`
 *                                   for the pinned origin target, then exit
 *   bun run src/tui.ts --cwd DIR  — explicit repo cwd (no herdr pane needed)
 *   bun run src/tui.ts --help     — usage
 *
 * Contract notes (docs/contracts/tui-v1.md):
 * - `--open` MUST return promptly and never block on the UI; it invokes
 *   `plugin pane open` through HERDR_BIN_PATH (falls back to `herdr`).
 * - The UI process terminates when the UI exits; herdr closes the pane.
 * - Non-TTY invocation prints an honest message and exits non-zero —
 *   the CLI (`src/cli.ts`) remains the non-interactive path.
 */

import { spawn } from "node:child_process";
import { buildPaneOpenArgs, parsePluginContext, resolveTargetSpec } from "./tui/model";

const PLUGIN_ID = "rebuildup.git";
const ENTRYPOINT = "main";
const PLACEMENT = "tab";

const USAGE = `rebuildup.git TUI — interactive git surface (contract herdr-plugins.tui/v1)

usage:
  bun run src/tui.ts [--cwd <path>]   open the UI (manifest pane entrypoint)
  bun run src/tui.ts --open           open a UI pane for the origin target
  bun run src/tui.ts --help           this text

environment:
  HERDR_PLUGIN_CONTEXT_JSON   origin workspace/tab/focused pane (pinned target)
  HERDR_TUI_TARGET_PANE_ID    explicit origin pane override
  HERDR_TUI_TARGET_CWD        explicit repo cwd override
  HERDR_BIN_PATH              herdr binary for --open (default: herdr on PATH)
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`git-tui: ${message}\n`);
  process.exit(code);
}

interface CliArgs {
  open: boolean;
  cwd: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { open: false, cwd: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--open") out.open = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--cwd") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) fail("--cwd requires a path", 2);
      out.cwd = value;
      i += 1;
    } else if (arg.startsWith("--cwd=")) {
      out.cwd = arg.slice("--cwd=".length);
      if (out.cwd === "") fail("--cwd requires a path", 2);
    } else if (arg === "main" || arg === "--") {
      // entrypoint id / separator — ignored
    } else {
      fail(`unknown argument: ${arg}`, 2);
    }
  }
  return out;
}

/** `--open`: spawn `herdr plugin pane open` and return its exit status. */
async function runOpen(): Promise<number> {
  const context = parsePluginContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  const spec = resolveTargetSpec(process.env);
  const args = buildPaneOpenArgs({
    pluginId: PLUGIN_ID,
    entrypoint: ENTRYPOINT,
    placement: PLACEMENT,
    workspaceId: context?.workspaceId ?? spec.workspaceId,
    targetPaneId: spec.paneId,
  });
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  return await new Promise<number>((resolve) => {
    const child = spawn(herdrBin, args, {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 30_000,
    });
    child.on("error", (err) => {
      process.stderr.write(
        `git-tui: failed to run ${herdrBin}: ${err.message}\n` +
          `fall back to CLI: bun run src/cli.ts status <pane_id>\n`,
      );
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.open) {
    process.exitCode = await runOpen();
    return;
  }

  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) {
    // Honest unsupported state (contract item 9): never fake a TUI on a
    // pipe. The CLI is the non-interactive path.
    process.stderr.write(
      "git-tui: interactive UI requires a TTY.\n" +
        "Use the CLI instead: bun run src/cli.ts status|files|diff|log|compare|stage|commit|branch|push <pane_id>\n",
    );
    process.exitCode = 1;
    return;
  }

  const { GitTui } = await import("./tui/app");
  const spec = resolveTargetSpec(process.env, args.cwd ?? undefined);
  const tui = await GitTui.create({ spec });
  await tui.app.closed;
}

main().catch((err) => {
  process.stderr.write(`git-tui: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
