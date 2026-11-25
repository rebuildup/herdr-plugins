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
  sessionKeyFor,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import {
  canonicalRepoRoot,
  discoverRepos,
  inspectRepo,
  projectIdFromRoot,
  repoIndex,
} from "./model";
import {
  herdrTransport,
  listRuns,
  type RunnerDeps,
  runLog,
  SHELL_OVERRIDE_VALUES,
  type ShellOverride,
  type StopOutcome,
  startRun,
  stopRuns,
} from "./runner";
import { loadRuns, type ScriptRun } from "./runs";
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
const PLUGIN_VERSION = "0.3.0";
const DEFAULT_TIMEOUT_MS = 10_000;

interface PluginConfig {
  timeoutMs?: number | undefined;
  /** Env-default script list (`scripts list` layer 2); shape validated lazily. */
  defaultScripts?: unknown;
  /** `scripts run` marker-wait ceiling; default 600_000 (10 min). */
  runTimeoutMs?: number | undefined;
  /** Byte cap for persisted run logs (tail kept); default 65_536. */
  runLogMaxBytes?: number | undefined;
  /** ctrl+c→close grace on `scripts stop`; default 2_000. */
  stopGraceMs?: number | undefined;
  /** Bounded stop-exit confirmation window; default 5_000. */
  stopConfirmMs?: number | undefined;
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
      runTimeoutMs:
        typeof parsed.runTimeoutMs === "number" && parsed.runTimeoutMs > 0
          ? parsed.runTimeoutMs
          : undefined,
      runLogMaxBytes:
        typeof parsed.runLogMaxBytes === "number" && parsed.runLogMaxBytes > 0
          ? parsed.runLogMaxBytes
          : undefined,
      stopGraceMs:
        typeof parsed.stopGraceMs === "number" && parsed.stopGraceMs >= 0
          ? parsed.stopGraceMs
          : undefined,
      stopConfirmMs:
        typeof parsed.stopConfirmMs === "number" && parsed.stopConfirmMs > 0
          ? parsed.stopConfirmMs
          : undefined,
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

/**
 * Append resolved repos to `project.repos`, enforcing cross-project
 * ownership. Shared by `update --repo-add` and `repos add`.
 */
function addReposToProject(
  state: ProjectsState,
  project: Project,
  additions: ResolvedRepo[],
): void {
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
}

/**
 * Drop canonical repo roots from `project.repos`. Shared by
 * `update --repo-remove` and `repos remove`.
 */
function removeReposFromProject(state: ProjectsState, project: Project, removals: string[]): void {
  const index = repoIndex(state);
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
}

function lookupProject(state: ProjectsState, id: string): Project {
  const project = state.projects[id];
  if (!project) {
    throw new CommandError(`project not found: ${id}`, "project_not_found", { project_id: id });
  }
  return project;
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
      addReposToProject(state, project, additions);
      removeReposFromProject(state, project, removals);
      project.updated_at = now();
      return project;
    }),
  );
  emitProject("update", project as Project);
}

/**
 * `repos list <project>` — registered members plus cheap live git
 * inspection (branch, dirty, submodules). Unreachable repos keep their
 * stored identity with null live fields and are reported in `skipped`.
 */
async function cmdReposList(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = effectiveTimeoutMs(options, config);
  const parsed = parseCommandArgs(options.args, new Set());
  const id = parsed.positionals[0];
  if (!id || parsed.positionals.length > 1) {
    fail("repos list requires exactly one <project> argument", 2);
  }
  const state = await loadState();
  const project = state.projects[id as string];
  if (!project) {
    fail(`project not found: ${id}`, 1, "project_not_found", { project_id: id });
  }

  const repos: Record<string, unknown>[] = [];
  const skipped: { root: string; reason: string }[] = [];
  for (const member of (project as Project).repos) {
    const entry: Record<string, unknown> = {
      root: member.root,
      remote: member.remote,
      added_at: member.added_at,
      branch: null,
      dirty: null,
      has_submodules: null,
    };
    try {
      const live = await inspectRepo(member.root, { timeoutMs });
      entry.branch = live.branch;
      entry.dirty = live.dirty;
      entry.has_submodules = live.has_submodules;
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      skipped.push({ root: member.root, reason: err.kind });
    }
    repos.push(entry);
  }
  emit({
    contract: CONTRACT,
    command: "repos list",
    project_id: (project as Project).id,
    repos,
    skipped,
    generated_at: now(),
  });
}

/**
 * `repos add|remove <project> --path DIR` (repeatable) — explicit repo
 * membership management. Thin aliases over the same locked helpers as
 * `update --repo-add/--repo-remove`; errors are identical.
 */
async function cmdReposMutate(options: CliOptions, op: "add" | "remove"): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = effectiveTimeoutMs(options, config);
  const parsed = parseCommandArgs(options.args, new Set(["--path"]));
  const id = parsed.positionals[0];
  const paths = parsed.multi.get("--path") ?? [];
  if (!id || parsed.positionals.length > 1 || paths.length === 0) {
    fail(`repos ${op} requires <project> and at least one --path DIR`, 2);
  }

  // Resolve repo paths outside the state lock; membership checks run inside.
  const project = await runMutation(async () => {
    if (op === "add") {
      const additions = await Promise.all(paths.map((p) => resolveRepoPath(p, timeoutMs)));
      return updateState((state) => {
        const project = lookupProject(state, id as string);
        addReposToProject(state, project, additions);
        project.updated_at = now();
        return project;
      });
    }
    const removals = await Promise.all(paths.map((p) => resolveRemovalRoot(p, timeoutMs)));
    return updateState((state) => {
      const project = lookupProject(state, id as string);
      removeReposFromProject(state, project, removals);
      project.updated_at = now();
      return project;
    });
  });
  emitProject(`repos ${op}`, project as Project);
}

async function cmdRepos(options: CliOptions): Promise<void> {
  const [sub, ...rest] = options.args;
  options.args = rest;
  switch (sub) {
    case "list":
      return cmdReposList(options);
    case "add":
    case "remove":
      return cmdReposMutate(options, sub);
    default:
      fail(`unknown repos subcommand: ${sub ?? ""}`, 2);
  }
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

  const scripts = await resolveScriptsForRepo(root, projectId, config);

  emit({
    contract: CONTRACT,
    command: "scripts list",
    project_id: projectId,
    repo_root: root,
    scripts,
    generated_at: now(),
  });
}

/**
 * Resolve the effective script list for one repo root: project settings
 * override (when `projectId` is known) → plugin env default → the repo's
 * `t3.json` → builtin. Shared by `scripts list` and `scripts run`.
 */
async function resolveScriptsForRepo(
  root: string,
  projectId: string | null,
  config: PluginConfig,
): Promise<ResolvedScript[]> {
  let overrideRaw: string | undefined;
  if (projectId !== null) {
    const settings = await loadSettings(projectId);
    const value = settings.defaultProjectScripts;
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

  try {
    return resolveScripts({
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
}

function runnerError(err: unknown): never {
  const kind = (err as { kind?: string }).kind;
  fail(err instanceof Error ? err.message : String(err), 1, kind ?? "script_run_error");
}

function runnerDeps(options: CliOptions, config: PluginConfig): RunnerDeps {
  return {
    transport: herdrTransport(options),
    waitTimeoutMs: config.runTimeoutMs,
    logMaxBytes: config.runLogMaxBytes,
    stopGraceMs: config.stopGraceMs,
    stopConfirmMs: config.stopConfirmMs,
    // Session discriminator recorded on new runs and enforced before
    // every pane action (#66): records from another session/socket are
    // foreign and never receive input/close through this socket.
    sessionKey: sessionKeyFor({ session: options.session, socketPath: options.socketPath }),
  };
}

/**
 * Pick the execution member repo for `scripts run`. `--repo` must
 * canonicalize to a registered member; without it a single-repo project
 * uses that repo, and a multi-repo project FAILS `repo_ambiguous` —
 * the runner never silently picks the first repo (issue #53).
 */
function selectRunRepo(
  project: Project,
  repoOption: string | undefined,
): { root: string; remote: string | null } {
  if (project.repos.length === 0) {
    throw new CommandError(`project has no registered repos: ${project.id}`, "no_repos", {
      project_id: project.id,
    });
  }
  if (repoOption !== undefined) {
    const wanted = canonicalRepoRoot(path.resolve(repoOption));
    const member = project.repos.find((r) => canonicalRepoRoot(r.root) === wanted);
    if (member === undefined) {
      throw new CommandError(`repo not registered to project: ${repoOption}`, "repo_not_found", {
        project_id: project.id,
        root: repoOption,
      });
    }
    return { root: member.root, remote: member.remote };
  }
  if (project.repos.length > 1) {
    throw new CommandError(
      `project has ${project.repos.length} repos; pass --repo PATH to choose the execution target`,
      "repo_ambiguous",
      {
        project_id: project.id,
        repos: project.repos.map((r) => r.root),
      },
    );
  }
  const member = project.repos[0] as Project["repos"][number];
  return { root: member.root, remote: member.remote };
}

/** Match a script by `name` or `id`; exact name wins over id collisions. */
function pickScript(scripts: ResolvedScript[], wanted: string): ResolvedScript {
  const matches = scripts.filter((s) => s.name === wanted || s.id === wanted);
  if (matches.length === 0) {
    throw new CommandError(`no script named: ${wanted}`, "unknown_script", { name: wanted });
  }
  const byName = matches.filter((s) => s.name === wanted);
  if (byName.length === 1) return byName[0] as ResolvedScript;
  if (matches.length === 1) return matches[0] as ResolvedScript;
  throw new CommandError(`ambiguous script name: ${wanted}`, "ambiguous_script", {
    name: wanted,
    matches: matches.map((s) => s.id),
  });
}

/**
 * `scripts run <project> <name> [--repo PATH]` — execute a resolved
 * project script in a dedicated herdr pane (ADR-0010). Waits up to
 * `runTimeoutMs` (config, default 10 min) for the completion marker;
 * on timeout the run stays `running` and is never killed implicitly.
 */
async function cmdScriptsRun(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const parsed = parseCommandArgs(options.args, new Set(["--repo", "--shell"]));
  const [projectId, name] = parsed.positionals;
  if (!projectId || !name || parsed.positionals.length > 2) {
    fail("scripts run requires <project> <name> [--repo PATH] [--shell auto|sh|cmd|powershell]", 2);
  }
  const shellOpt = parsed.values.get("--shell");
  if (shellOpt !== undefined && !(SHELL_OVERRIDE_VALUES as readonly string[]).includes(shellOpt)) {
    fail(
      `invalid --shell value: ${shellOpt} (expected ${SHELL_OVERRIDE_VALUES.join("|")})`,
      1,
      "invalid_shell",
    );
  }

  const state = await loadState();
  const project = state.projects[projectId as string];
  if (!project) {
    fail(`project not found: ${projectId}`, 1, "project_not_found", {
      project_id: projectId,
    });
  }

  let member: { root: string; remote: string | null };
  try {
    member = selectRunRepo(project, parsed.values.get("--repo"));
  } catch (err) {
    if (err instanceof CommandError) fail(err.message, 1, err.kind, err.extra);
    throw err;
  }

  const scripts = await resolveScriptsForRepo(member.root, project.id, config);
  let script: ResolvedScript;
  try {
    script = pickScript(scripts, name as string);
  } catch (err) {
    if (err instanceof CommandError) fail(err.message, 1, err.kind, err.extra);
    throw err;
  }

  let run: ScriptRun;
  try {
    run = await startRun(
      {
        project,
        script: {
          id: script.id,
          name: script.name,
          command: script.command,
          source: script.source,
        },
        repoRoot: member.root,
        remote: member.remote,
        shell: shellOpt as ShellOverride | undefined,
      },
      runnerDeps(options, config),
    );
  } catch (err) {
    runnerError(err);
  }
  emit({ contract: CONTRACT, command: "scripts run", run, generated_at: now() });
}

/**
 * `scripts stop <run-id|project>` — request stop on active runs, then
 * confirm exit before recording `stopped` (#66). Ownership is
 * re-validated via `pane.get` first: foreign/mismatched panes yield a
 * `stale_pane` outcome with zero side effects. ctrl+c alone never counts
 * as stopped — confirmation comes from pane absence or an empty
 * foreground process list within `stopConfirmMs`; otherwise the run is
 * `stop_unconfirmed`. Only pane ids persisted in run records are
 * addressed; nothing else in the session can be hit.
 */
async function cmdScriptsStop(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const parsed = parseCommandArgs(options.args, new Set());
  const target = parsed.positionals[0];
  if (!target || parsed.positionals.length > 1) {
    fail("scripts stop requires <run-id|project>", 2);
  }
  let outcomes: StopOutcome[];
  try {
    outcomes = await stopRuns(target as string, runnerDeps(options, config));
  } catch (err) {
    runnerError(err);
  }
  const HANDLED = new Set(["stopped", "stop_unconfirmed", "stale_pane", "pane_gone"]);
  if (!outcomes.some((o) => HANDLED.has(o.action))) {
    fail(`no running runs matched: ${target}`, 1, "no_running_runs", { target });
  }
  emit({
    contract: CONTRACT,
    command: "scripts stop",
    outcomes: outcomes.map((o) => ({ run: o.run, action: o.action })),
    generated_at: now(),
  });
}

/** `scripts results [project]` — run records, lazily reconciling panes. */
async function cmdScriptsResults(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const parsed = parseCommandArgs(options.args, new Set());
  const projectId = parsed.positionals[0];
  if (parsed.positionals.length > 1) {
    fail("scripts results accepts at most one <project> argument", 2);
  }
  if (projectId !== undefined) {
    const state = await loadState();
    if (!state.projects[projectId]) {
      fail(`project not found: ${projectId}`, 1, "project_not_found", {
        project_id: projectId,
      });
    }
  }
  const runs = await listRuns(runnerDeps(options, config), {
    projectId: projectId as string | undefined,
  });
  emit({
    contract: CONTRACT,
    command: "scripts results",
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    runs,
    generated_at: now(),
  });
}

/** `scripts logs <run-id>` — bounded stored/captured log for one run. */
async function cmdScriptsLogs(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const parsed = parseCommandArgs(options.args, new Set());
  const wanted = parsed.positionals[0];
  if (!wanted || parsed.positionals.length > 1) {
    fail("scripts logs requires <run-id>", 2);
  }
  // Accept a unique run-id prefix, matching `scripts stop` ergonomics.
  const state = await loadRuns();
  const all = Object.values(state.runs);
  const exact = all.find((r) => r.run_id === wanted);
  const byPrefix = exact ? [exact] : all.filter((r) => r.run_id.startsWith(wanted as string));
  if (byPrefix.length === 0) {
    fail(`run not found: ${wanted}`, 1, "run_not_found", { run_id: wanted });
  }
  if (byPrefix.length > 1) {
    fail(`ambiguous run id prefix: ${wanted}`, 1, "ambiguous_run", { run_id: wanted });
  }
  const runId = (byPrefix[0] as { run_id: string }).run_id;
  const result = await runLog(runId, runnerDeps(options, config)).catch(runnerError);
  emit({
    contract: CONTRACT,
    command: "scripts logs",
    run_id: runId,
    run: result.run,
    log_path: result.log_path,
    log: result.log,
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
      "repos",
    ],
    read_only: false,
    mutation_commands: [
      "register",
      "update",
      "repos add",
      "repos remove",
      "archive",
      "unarchive",
      "pin",
      "unpin",
      "settings set",
      "settings unset",
      "scripts run",
      "scripts stop",
    ],
    requires: {
      git: true,
      bun: true,
      herdr: "session snapshot (discover); pane execution (scripts run/stop/results/logs)",
    },
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
  projects scripts run <project> <name> [--repo PATH] [--shell auto|sh|cmd|powershell]
  projects scripts stop <run-id|project>
  projects scripts results [project]
  projects scripts logs <run-id>
  projects repos list <project>
  projects repos add <project> --path DIR [--path DIR]...
  projects repos remove <project> --path DIR [--path DIR]...
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
    case "scripts": {
      const [sub, ...rest] = options.args;
      options.args = rest;
      switch (sub) {
        case "list":
          return cmdScriptsList(options);
        case "run":
          return cmdScriptsRun(options);
        case "stop":
          return cmdScriptsStop(options);
        case "results":
          return cmdScriptsResults(options);
        case "logs":
          return cmdScriptsLogs(options);
        default:
          return fail(`unknown scripts subcommand: ${sub ?? ""}`, 2);
      }
    }
    case "repos":
      return cmdRepos(options);
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
