/**
 * rebuildup.projects CLI — project registry contract
 * (`herdr-plugins.projects/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 */

import { GitError } from "../../../packages/git-core/src/index";
import {
  type CallOptions,
  pluginDirs,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import { discoverRepos } from "./model";
import { loadState, PLUGIN_ID, type Project, type ProjectsState } from "./state";

const CONTRACT = "herdr-plugins.projects/v1";
const PLUGIN_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 10_000;

interface PluginConfig {
  timeoutMs?: number | undefined;
}

interface CliOptions extends CallOptions {
  command: string;
  args: string[];
  session: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = { command, args, session: undefined };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--session") {
      options.session = args[++i];
    } else if (arg === "--socket") {
      options.socketPath = args[++i];
    } else if (arg === "--timeout") {
      const value = Number(args[++i]);
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else {
      rest.push(arg);
    }
  }
  options.args = rest;
  return options;
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message: string, code = 1, kind?: string): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind) error.kind = kind;
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function positionals(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("--"));
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function loadConfig(): Promise<PluginConfig> {
  const file = `${pluginDirs(PLUGIN_ID).configDir}/config.json`;
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(file, "utf8")) as PluginConfig;
    return {
      timeoutMs:
        typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0 ? parsed.timeoutMs : undefined,
    };
  } catch {
    return {};
  }
}

function effectiveTimeoutMs(options: CliOptions, config: PluginConfig): number {
  return options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function serializeProject(p: Project): Project {
  return p;
}

function sortedProjects(state: ProjectsState, includeArchived: boolean): Project[] {
  return Object.values(state.projects)
    .filter((p) => includeArchived || !p.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title));
}

async function cmdList(options: CliOptions): Promise<void> {
  const state = await loadState();
  const includeArchived = hasFlag(options.args, "--all");
  emit({
    contract: CONTRACT,
    command: "list",
    projects: sortedProjects(state, includeArchived).map(serializeProject),
    generated_at: new Date().toISOString(),
  });
}

async function cmdShow(options: CliOptions): Promise<void> {
  const id = positionals(options.args)[0];
  if (!id) fail("show requires a project id", 2);
  const state = await loadState();
  const project = state.projects[id as string];
  if (!project) fail(`project not found: ${id}`, 1, "project_not_found");
  emit({
    contract: CONTRACT,
    command: "show",
    project: serializeProject(project as Project),
    generated_at: new Date().toISOString(),
  });
}

async function cmdDiscover(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = effectiveTimeoutMs(options, config);
  const snapshot = (await sessionSnapshot(options)) as SessionSnapshot;
  const cwds = [
    ...new Set(
      (snapshot.panes ?? [])
        .map((p) => (p as { cwd?: string }).cwd)
        .filter((c): c is string => typeof c === "string" && c.length > 0),
    ),
  ];
  const state = await loadState();
  try {
    const { repos, skipped } = await discoverRepos(cwds, state, { timeoutMs });
    emit({
      contract: CONTRACT,
      command: "discover",
      repos,
      skipped,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdCapability(): Promise<void> {
  const config = await loadConfig();
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    commands: ["capability", "list", "show", "discover"],
    read_only: true,
    mutation_commands: [],
    requires: { git: true, bun: true, herdr: "session snapshot (discover only)" },
    defaults: { timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  });
}

const USAGE = `rebuildup.projects — project registry (contract ${CONTRACT})

Usage:
  projects list [--all]
  projects show <id>
  projects discover [--session NAME] [--timeout MS]
  projects capability
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "list":
      return cmdList(options);
    case "show":
      return cmdShow(options);
    case "discover":
      return cmdDiscover(options);
    case "capability":
      return cmdCapability();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      fail(`unknown command: ${options.command}\n${USAGE}`, 2);
  }
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({
      contract: CONTRACT,
      ok: false,
      error: { code: "error", message: String(err) },
    })}\n`,
  );
  process.exit(1);
});
