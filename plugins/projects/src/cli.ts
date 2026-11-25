/**
 * rebuildup.projects CLI — project registry contract
 * (`herdr-plugins.projects/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 */

import path from "node:path";
import {
  GitError,
  type RepoInfo,
  repoRemoteIdentity,
  resolveRepo,
} from "../../../packages/git-core/src/index";
import {
  type CallOptions,
  pluginDirs,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import { canonicalRepoRoot, discoverRepos, projectIdFromRoot, repoIndex } from "./model";
import { BUILTIN_SCRIPTS, type ResolvedScript, resolveScripts, ScriptError } from "./scripts";
import {
  loadSettings,
  loadState,
  PLUGIN_ID,
  type Project,
  type ProjectsState,
  SETTINGS_ALLOW_LIST,
  updateSettings,
  updateState,
} from "./state";
import { loadT3ProjectFile, T3JsonError, type T3ProjectFileScript } from "./t3json";

const CONTRACT = "herdr-plugins.projects/v1";
const PLUGIN_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 10_000;

interface PluginConfig {
  timeoutMs?: number | undefined;
  /** Env-default script list (`scripts list` layer 2); shape validated lazily. */
  defaultScripts?: unknown;
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

function fail(message: string, code = 1, kind?: string, extra?: Record<string, unknown>): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind) error.kind = kind;
  if (extra) Object.assign(error, extra);
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

/** Structured failure thrown inside updateState mutates; mapped to fail(). */
class CommandError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface ParsedArgs {
  positionals: string[];
  /** Last value per option name. */
  values: Map<string, string>;
  /** All values per option name, for repeatable options. */
  multi: Map<string, string[]>;
  flags: Set<string>;
}

/**
 * Split command args into positionals, `--name value`/`--name=value`
 * options, and bare boolean flags. Unknown `--x` tokens become flags;
 * their following token stays positional only when the flag is boolean —
 * callers declare value flags explicitly via `valueFlags`.
 */
function parseCommandArgs(args: string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const flags = new Set<string>();
  const push = (name: string, value: string): void => {
    values.set(name, value);
    const list = multi.get(name);
    if (list) list.push(value);
    else multi.set(name, [value]);
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        push(arg.slice(0, eq), arg.slice(eq + 1));
        continue;
      }
      if (valueFlags.has(arg)) {
        const value = args[++i];
        if (value === undefined) fail(`${arg} requires a value`, 2);
        push(arg, value);
      } else {
        flags.add(arg);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, values, multi, flags };
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
      defaultScripts: parsed.defaultScripts,
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

interface ResolvedRepo {
  root: string;
  remote: string | null;
}

/** Resolve a user-supplied path to a canonical repo root + remote identity. */
async function resolveRepoPath(input: string, timeoutMs: number): Promise<ResolvedRepo> {
  let info: RepoInfo;
  try {
    info = await resolveRepo(input, { timeoutMs });
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
  const root = canonicalRepoRoot(info.root);
  let remote: string | null = null;
  try {
    remote = await repoRemoteIdentity(info.root, { timeoutMs });
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
  return { root, remote };
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Repo-remove accepts either a live repo path (resolved to its worktree
 * root) or a stale/removed path canonicalized lexically, so membership
 * can be dropped after the checkout is gone.
 */
async function resolveRemovalRoot(input: string, timeoutMs: number): Promise<string> {
  try {
    return canonicalRepoRoot((await resolveRepo(input, { timeoutMs })).root);
  } catch (err) {
    if (err instanceof GitError) return canonicalRepoRoot(path.resolve(input));
    throw err;
  }
}

function emitProject(command: string, project: Project): void {
  emit({ contract: CONTRACT, command, project, generated_at: now() });
}

async function runMutation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CommandError) fail(err.message, 1, err.kind, err.extra);
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdRegister(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = effectiveTimeoutMs(options, config);
  const parsed = parseCommandArgs(options.args, new Set(["--path", "--title", "--id"]));
  const repoPath = parsed.values.get("--path") ?? parsed.positionals[0];
  if (!repoPath) fail("register requires a repo path (positional or --path)", 2);
  const explicitId = parsed.values.get("--id");
  if (explicitId !== undefined && !PROJECT_ID_RE.test(explicitId)) {
    fail(`invalid project id: ${explicitId}`, 2, "invalid_project_id");
  }
  const { root, remote } = await resolveRepoPath(repoPath as string, timeoutMs);

  const project = await runMutation(() =>
    updateState((state) => {
      const owner = repoIndex(state).get(root);
      if (owner) {
        throw new CommandError(
          `repo already registered to project: ${owner}`,
          "repo_already_registered",
          { project_id: owner },
        );
      }
      let id = explicitId ?? projectIdFromRoot(root);
      if (state.projects[id]) {
        if (explicitId) {
          throw new CommandError(`project id already exists: ${id}`, "project_exists", {
            project_id: id,
          });
        }
        let n = 2;
        while (state.projects[`${id}-${n}`] && n < 100) n += 1;
        if (n >= 100) {
          throw new CommandError(
            `could not derive a free project id for: ${root}`,
            "project_exists",
          );
        }
        id = `${id}-${n}`;
      }
      const timestamp = now();
      const created: Project = {
        id,
        title: parsed.values.get("--title") ?? root.split(/[\\/]/).filter(Boolean).pop() ?? id,
        repos: [{ root, remote, added_at: timestamp }],
        pinned: false,
        archived: false,
        created_at: timestamp,
        updated_at: timestamp,
      };
      state.projects[id] = created;
      return created;
    }),
  );
  emitProject("register", project as Project);
}

async function cmdUpdate(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = effectiveTimeoutMs(options, config);
  const parsed = parseCommandArgs(
    options.args,
    new Set(["--title", "--repo-add", "--repo-remove"]),
  );
  const id = parsed.positionals[0];
  if (!id) fail("update requires a project id", 2);
  if (parsed.flags.has("--pinned") && parsed.flags.has("--unpinned")) {
    fail("--pinned and --unpinned are mutually exclusive", 2);
  }
  if (parsed.flags.has("--archived") && parsed.flags.has("--unarchived")) {
    fail("--archived and --unarchived are mutually exclusive", 2);
  }

  // Resolve repo paths outside the state lock; membership checks run inside.
  const additions: ResolvedRepo[] = [];
  for (const p of parsed.multi.get("--repo-add") ?? []) {
    additions.push(await resolveRepoPath(p, timeoutMs));
  }
  const removals: string[] = [];
  for (const p of parsed.multi.get("--repo-remove") ?? []) {
    removals.push(await resolveRemovalRoot(p, timeoutMs));
  }

  const title = parsed.values.get("--title");
  const pinned = parsed.flags.has("--pinned")
    ? true
    : parsed.flags.has("--unpinned")
      ? false
      : undefined;
  const archived = parsed.flags.has("--archived")
    ? true
    : parsed.flags.has("--unarchived")
      ? false
      : undefined;

  const project = await runMutation(() =>
    updateState((state) => {
      const project = state.projects[id as string];
      if (!project) {
        throw new CommandError(`project not found: ${id}`, "project_not_found", {
          project_id: id,
        });
      }
      if (title !== undefined) project.title = title;
      if (pinned !== undefined) project.pinned = pinned;
      if (archived !== undefined) project.archived = archived;
      const index = repoIndex(state);
      for (const add of additions) {
        const existing = project.repos.find((r) => canonicalRepoRoot(r.root) === add.root);
        if (existing) continue;
        const owner = index.get(add.root);
        if (owner && owner !== project.id) {
          throw new CommandError(
            `repo already registered to project: ${owner}`,
            "repo_already_registered",
            { project_id: owner },
          );
        }
        project.repos.push({ root: add.root, remote: add.remote, added_at: now() });
        index.set(add.root, project.id);
      }
      for (const root of removals) {
        const before = project.repos.length;
        project.repos = project.repos.filter((r) => canonicalRepoRoot(r.root) !== root);
        if (project.repos.length === before) {
          throw new CommandError(`repo not registered to project: ${root}`, "repo_not_found", {
            project_id: project.id,
            root,
          });
        }
        index.delete(root);
      }
      project.updated_at = now();
      return project;
    }),
  );
  emitProject("update", project as Project);
}

async function flagCommand(
  options: CliOptions,
  command: string,
  field: "pinned" | "archived",
  value: boolean,
): Promise<void> {
  const id = positionals(options.args)[0];
  if (!id) fail(`${command} requires a project id`, 2);
  const project = await runMutation(() =>
    updateState((state) => {
      const project = state.projects[id as string];
      if (!project) {
        throw new CommandError(`project not found: ${id}`, "project_not_found", {
          project_id: id,
        });
      }
      project[field] = value;
      project.updated_at = now();
      return project;
    }),
  );
  emitProject(command, project as Project);
}

async function cmdSettings(options: CliOptions): Promise<void> {
  const [op, ...rest] = options.args;
  if (op !== "get" && op !== "set" && op !== "unset") {
    fail("settings requires a subcommand: get | set | unset", 2);
  }
  const state = await loadState();

  if (op === "get") {
    const [id, key] = rest;
    if (!id) fail("settings get requires a project id", 2);
    if (!state.projects[id]) {
      fail(`project not found: ${id}`, 1, "project_not_found", { project_id: id });
    }
    const settings = await loadSettings(id);
    emit({
      contract: CONTRACT,
      command: "settings",
      op: "get",
      project: id,
      ...(key !== undefined ? { key, value: settings[key] ?? null } : { settings }),
      generated_at: now(),
    });
    return;
  }

  const [id, key, ...valueParts] = rest;
  if (!id || !key || (op === "set" && valueParts.length === 0)) {
    fail(`settings ${op} requires <id> <key>${op === "set" ? " <value>" : ""}`, 2);
  }
  if (!state.projects[id]) {
    fail(`project not found: ${id}`, 1, "project_not_found", { project_id: id });
  }
  if (!SETTINGS_ALLOW_LIST.has(key)) {
    fail(`settings key not allowed: ${key}`, 1, "settings_key_not_allowed", { key });
  }
  if (op === "set") {
    const value = valueParts.join(" ");
    await updateSettings(id, (settings) => {
      settings[key] = value;
    });
  } else {
    await updateSettings(id, (settings) => {
      delete settings[key];
    });
  }
  const settings = await loadSettings(id);
  emit({
    contract: CONTRACT,
    command: "settings",
    op,
    project: id,
    key,
    settings,
    generated_at: now(),
  });
}

/**
 * `scripts list <project|repo>` — resolved project script definitions
 * (read-only). The positional matches a registered project id first;
 * otherwise it is treated as a repo path resolved via git-core. A repo
 * path owned by a project still picks up that project's settings
 * override. `--repo PATH` selects which member repo's t3.json to read
 * for multi-repo projects (default: first registered repo).
 */
async function cmdScriptsList(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = effectiveTimeoutMs(options, config);
  const parsed = parseCommandArgs(options.args, new Set(["--repo"]));
  const target = parsed.positionals[0];
  if (!target || parsed.positionals.length > 1) {
    fail("scripts list requires exactly one <project|repo> argument", 2);
  }
  const repoOption = parsed.values.get("--repo");

  const state = await loadState();
  let projectId: string | null = null;
  let root: string;

  const project = state.projects[target as string];
  if (project) {
    projectId = project.id;
    let memberRoot = project.repos[0]?.root;
    if (repoOption !== undefined) {
      const wanted = canonicalRepoRoot(path.resolve(repoOption));
      memberRoot = project.repos.find((r) => canonicalRepoRoot(r.root) === wanted)?.root;
      if (memberRoot === undefined) {
        fail(`repo not registered to project: ${repoOption}`, 1, "repo_not_found", {
          project_id: projectId,
          root: repoOption,
        });
      }
    }
    if (memberRoot === undefined) {
      fail(`project has no registered repos: ${projectId}`, 1, "no_repos", {
        project_id: projectId,
      });
    }
    root = memberRoot as string;
  } else {
    if (repoOption !== undefined) {
      fail("--repo requires a project id target, not a repo path", 2);
    }
    // Not a project id: treat as a repo path. Non-git/unknown paths
    // surface the git contract kinds (not_a_repo, bare_repo, ...).
    const resolved = await resolveRepoPath(target as string, timeoutMs);
    root = resolved.root;
    projectId = repoIndex(state).get(canonicalRepoRoot(root)) ?? null;
  }

  let overrideRaw: string | undefined;
  if (projectId !== null) {
    const settings = await loadSettings(projectId);
    const value = settings["defaultProjectScripts"];
    overrideRaw = typeof value === "string" ? value : undefined;
  }

  let t3Scripts: T3ProjectFileScript[] | undefined;
  try {
    const t3 = await loadT3ProjectFile(root);
    t3Scripts = t3?.scripts;
  } catch (err) {
    if (err instanceof T3JsonError) {
      fail(err.message, 1, "t3json_invalid", { path: err.file, reason: err.reason });
    }
    throw err;
  }

  let scripts: ResolvedScript[];
  try {
    scripts = resolveScripts({
      override: overrideRaw,
      envDefault: config.defaultScripts,
      t3Scripts,
      builtin: BUILTIN_SCRIPTS,
    });
  } catch (err) {
    if (err instanceof ScriptError) {
      fail(err.message, 1, err.reason, { layer: err.layer });
    }
    throw err;
  }

  emit({
    contract: CONTRACT,
    command: "scripts list",
    project_id: projectId,
    repo_root: root,
    scripts,
    generated_at: now(),
  });
}

async function cmdCapability(): Promise<void> {
  const config = await loadConfig();
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    commands: [
      "capability",
      "list",
      "show",
      "discover",
      "register",
      "update",
      "archive",
      "unarchive",
      "pin",
      "unpin",
      "settings",
      "scripts",
    ],
    read_only: false,
    mutation_commands: [
      "register",
      "update",
      "archive",
      "unarchive",
      "pin",
      "unpin",
      "settings set",
      "settings unset",
    ],
    requires: { git: true, bun: true, herdr: "session snapshot (discover only)" },
    defaults: { timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  });
}

const USAGE = `rebuildup.projects — project registry (contract ${CONTRACT})

Usage:
  projects list [--all]
  projects show <id>
  projects discover [--session NAME] [--timeout MS]
  projects register <repo-path> [--title T] [--id ID]
  projects update <id> [--title T] [--pinned|--unpinned]
      [--archived|--unarchived] [--repo-add PATH]... [--repo-remove PATH]...
  projects archive <id> | unarchive <id> | pin <id> | unpin <id>
  projects settings get <id> [key]
  projects settings set <id> <key> <value>
  projects settings unset <id> <key>
  projects scripts list <project|repo> [--repo PATH]
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
    case "register":
      return cmdRegister(options);
    case "update":
      return cmdUpdate(options);
    case "archive":
      return flagCommand(options, "archive", "archived", true);
    case "unarchive":
      return flagCommand(options, "unarchive", "archived", false);
    case "pin":
      return flagCommand(options, "pin", "pinned", true);
    case "unpin":
      return flagCommand(options, "unpin", "pinned", false);
    case "settings":
      return cmdSettings(options);
    case "scripts":
      if (options.args[0] !== "list") {
        fail(`unknown scripts subcommand: ${options.args[0] ?? ""}`, 2);
      }
      options.args = options.args.slice(1);
      return cmdScriptsList(options);
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
