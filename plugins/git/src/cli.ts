/**
 * rebuildup.git CLI — Git status/diff plus local mutation contract
 * (`herdr-plugins.git/v1`) shared by the herdr TUI (via manifest actions),
 * agents, and external clients such as herdr-t3. Single JSON document on
 * stdout; diagnostics on stderr. Exit 0 success, 1 handled error, 2 usage.
 *
 * Pane selection: explicit <pane_id> argument, else HERDR_PANE_ID, else
 * HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id (manifest action context).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CallOptions,
  type PaneInfo,
  pluginDirs,
  reportPaneMetadata,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import {
  assertSafeGitArg,
  collectBranchCreate,
  collectBranchSwitch,
  collectCommit,
  collectCompare,
  collectDiff,
  collectFetch,
  collectFiles,
  collectLog,
  collectPush,
  collectRemotes,
  collectStage,
  collectStatus,
  collectUnstage,
  collectUpstream,
  type DiffFormat,
  type DiffRequest,
  GitError,
  resolveRepo,
  type StatusReport,
} from "./git";

const CONTRACT = "herdr-plugins.git/v1";
const PLUGIN_ID = "rebuildup.git";
const PLUGIN_VERSION = "0.2.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 60_000;
const DEFAULT_DIFF_MAX_BYTES = 256 * 1024;

interface PluginConfig {
  timeoutMs?: number | undefined;
  remoteTimeoutMs?: number | undefined;
  diffMaxBytes?: number | undefined;
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

function emitError(message: string, code: number, kind?: string): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind) error.kind = kind;
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function fail(message: string, code = 1, kind?: string): never {
  emitError(message, code, kind);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

/** All values of a repeatable value flag (e.g. --path a --path b). */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length) out.push(args[i + 1] as string);
  }
  return out;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Positional args, skipping flag values. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (valueFlags.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

interface PluginContext {
  focused_pane_id?: string;
}

function invocationContext(): PluginContext {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PluginContext;
  } catch {
    return {};
  }
}

async function resolvePaneId(args: string[], valueFlags: string[] = []): Promise<string> {
  const explicit =
    positionals(args, valueFlags)[0] ??
    process.env.HERDR_PANE_ID ??
    invocationContext().focused_pane_id;
  if (!explicit) {
    fail("pane id required (argument, HERDR_PANE_ID, or plugin context)", 2);
  }
  return explicit;
}

async function loadConfig(): Promise<PluginConfig> {
  const file = path.join(pluginDirs(PLUGIN_ID).configDir, "config.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as PluginConfig;
    return {
      timeoutMs:
        typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0 ? parsed.timeoutMs : undefined,
      remoteTimeoutMs:
        typeof parsed.remoteTimeoutMs === "number" && parsed.remoteTimeoutMs > 0
          ? parsed.remoteTimeoutMs
          : undefined,
      diffMaxBytes:
        typeof parsed.diffMaxBytes === "number" && parsed.diffMaxBytes > 0
          ? parsed.diffMaxBytes
          : undefined,
    };
  } catch {
    return {};
  }
}

function effectiveTimeoutMs(options: CliOptions, config: PluginConfig): number {
  return options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

/** Network-facing git ops (fetch/push) get a longer default budget. */
function effectiveRemoteTimeoutMs(options: CliOptions, config: PluginConfig): number {
  return options.timeoutMs ?? config.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
}

async function findPane(snapshot: SessionSnapshot, paneId: string): Promise<PaneInfo> {
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
  if (!pane) fail(`pane not found in session snapshot: ${paneId}`, 1, "pane_not_found");
  return pane;
}

function paneCwd(pane: PaneInfo): string {
  const cwd = pane.cwd ?? (pane as { foreground_cwd?: string }).foreground_cwd;
  if (!cwd || typeof cwd !== "string") {
    fail(`pane has no cwd in session snapshot: ${pane.pane_id}`, 1, "no_pane_cwd");
  }
  return cwd;
}

function statusPayload(
  paneId: string,
  report: StatusReport,
  generatedAt: Date,
): Record<string, unknown> {
  return {
    contract: CONTRACT,
    command: "status",
    pane_id: paneId,
    generated_at: generatedAt.toISOString(),
    repo: {
      root: report.repo.root,
      git_dir: report.repo.gitDir,
      git_common_dir: report.repo.gitCommonDir,
      bare: report.repo.bare,
    },
    branch: report.branch,
    changes: report.changes,
    warnings: [],
  };
}

async function cmdStatus(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const paneId = await resolvePaneId(options.args);
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const cwd = paneCwd(pane);
  try {
    const report = await collectStatus(cwd, {
      timeoutMs: effectiveTimeoutMs(options, config),
    });
    emit(statusPayload(paneId, report, new Date()));
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

// Only flags that consume a value belong here; boolean flags are skipped
// by the `--` prefix check in positionals().
const DIFF_VALUE_FLAGS = ["--path", "--max-bytes"];

async function cmdFiles(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const paneId = await resolvePaneId(options.args, ["--path"]);
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const cwd = paneCwd(pane);

  const pathspec = flagValues(options.args, "--path");
  for (const p of pathspec) {
    if (p.startsWith("-")) fail(`invalid --path value (option-like rejected): ${p}`, 2);
  }

  let repoRoot: string;
  try {
    repoRoot = (await resolveRepo(cwd, { timeoutMs: effectiveTimeoutMs(options, config) })).root;
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }

  try {
    const result = await collectFiles(
      repoRoot,
      { pathspec: pathspec.length > 0 ? pathspec : undefined },
      { timeoutMs: effectiveTimeoutMs(options, config) },
    );
    emit({
      contract: CONTRACT,
      command: "files",
      pane_id: paneId,
      repo_root: repoRoot,
      pathspec,
      files: result.files,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdDiff(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const paneId = await resolvePaneId(options.args, DIFF_VALUE_FLAGS);
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const cwd = paneCwd(pane);

  // Revision args: positionals after the pane id that do not look like
  // flags. Anything starting with '-' is rejected — git options must be
  // expressed through the explicit flags above.
  const pos = positionals(options.args, DIFF_VALUE_FLAGS);
  const revisions = pos.slice(1);
  for (const rev of revisions) {
    if (rev.startsWith("-")) {
      fail(`invalid revision (option-like value rejected): ${rev}`, 2);
    }
  }
  if (revisions.length > 2) {
    fail("diff accepts at most two revisions", 2);
  }

  const formats = ["--stat", "--name-status", "--numstat"].filter((f) => hasFlag(options.args, f));
  if (formats.length > 1) {
    fail(`diff accepts only one output format flag (got ${formats.join(", ")})`, 2);
  }
  const format: DiffFormat | undefined =
    formats[0] === "--stat"
      ? "stat"
      : formats[0] === "--name-status"
        ? "name-status"
        : formats[0] === "--numstat"
          ? "numstat"
          : undefined;

  const paths = flagValues(options.args, "--path");
  for (const p of paths) {
    if (p.startsWith("-")) fail(`invalid --path value (option-like rejected): ${p}`, 2);
  }

  const maxBytesRaw = flagValue(options.args, "--max-bytes");
  const maxBytes = maxBytesRaw ? Number(maxBytesRaw) : undefined;
  if (maxBytesRaw && (!Number.isFinite(maxBytes) || (maxBytes as number) <= 0)) {
    fail(`invalid --max-bytes: ${maxBytesRaw}`, 2);
  }

  const request: DiffRequest = {
    staged: hasFlag(options.args, "--staged"),
    stat: hasFlag(options.args, "--stat"),
    format,
    revisions: revisions.length > 0 ? revisions : undefined,
    paths: paths.length > 0 ? paths : undefined,
    maxBytes: (maxBytes as number | undefined) ?? config.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES,
  };

  let repoRoot: string;
  try {
    repoRoot = (await resolveRepo(cwd, { timeoutMs: effectiveTimeoutMs(options, config) })).root;
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }

  try {
    const result = await collectDiff(repoRoot, request, {
      timeoutMs: effectiveTimeoutMs(options, config),
    });
    emit({
      contract: CONTRACT,
      command: "diff",
      pane_id: paneId,
      repo_root: repoRoot,
      staged: request.staged ?? false,
      stat: request.stat ?? false,
      revisions: request.revisions ?? [],
      format: format ?? "patch",
      output: format === undefined ? result.output : null,
      stat_output: format === "stat" ? result.output : null,
      name_status_output: format === "name-status" ? result.output : null,
      numstat_output: format === "numstat" ? result.output : null,
      paths,
      truncated: result.truncated,
      bytes: result.bytes,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

const LOG_VALUE_FLAGS = ["--limit", "--skip", "--author", "--grep", "--since", "--until", "--path"];

function positiveIntFlag(args: string[], name: string): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`invalid ${name}: ${raw}`, 2);
  }
  return value;
}

async function cmdLog(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const paneId = await resolvePaneId(options.args, LOG_VALUE_FLAGS);
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const cwd = paneCwd(pane);

  const pathspec = flagValues(options.args, "--path");
  for (const p of pathspec) {
    if (p.startsWith("-")) fail(`invalid --path value (option-like rejected): ${p}`, 2);
  }
  const limit = positiveIntFlag(options.args, "--limit");
  if (limit === 0) fail("--limit must be >= 1", 2);
  const skip = positiveIntFlag(options.args, "--skip");

  let repoRoot: string;
  try {
    repoRoot = (await resolveRepo(cwd, { timeoutMs: effectiveTimeoutMs(options, config) })).root;
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }

  try {
    const result = await collectLog(
      repoRoot,
      {
        limit,
        skip,
        all: hasFlag(options.args, "--all"),
        firstParent: hasFlag(options.args, "--first-parent"),
        author: flagValue(options.args, "--author"),
        grep: flagValue(options.args, "--grep"),
        since: flagValue(options.args, "--since"),
        until: flagValue(options.args, "--until"),
        pathspec: pathspec.length > 0 ? pathspec : undefined,
      },
      { timeoutMs: effectiveTimeoutMs(options, config) },
    );
    emit({
      contract: CONTRACT,
      command: "log",
      pane_id: paneId,
      repo_root: repoRoot,
      limit: limit ?? 50,
      skip: skip ?? 0,
      commits: result.commits,
      has_more: result.hasMore,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdCompare(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const paneId = await resolvePaneId(options.args, ["--max-bytes"]);
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const cwd = paneCwd(pane);

  const pos = positionals(options.args, ["--max-bytes"]);
  const revs = pos.slice(1);
  if (revs.length > 2) fail("compare accepts at most two revisions (base head)", 2);
  for (const rev of revs) {
    if (rev.startsWith("-")) {
      fail(`invalid revision (option-like value rejected): ${rev}`, 2);
    }
  }
  const maxBytesRaw = flagValue(options.args, "--max-bytes");
  const maxBytes = maxBytesRaw ? Number(maxBytesRaw) : undefined;
  if (maxBytesRaw && (!Number.isFinite(maxBytes) || (maxBytes as number) <= 0)) {
    fail(`invalid --max-bytes: ${maxBytesRaw}`, 2);
  }

  let repoRoot: string;
  try {
    repoRoot = (await resolveRepo(cwd, { timeoutMs: effectiveTimeoutMs(options, config) })).root;
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }

  try {
    const result = await collectCompare(
      repoRoot,
      {
        base: revs[0],
        head: revs[1],
        maxBytes: (maxBytes as number | undefined) ?? config.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES,
      },
      { timeoutMs: effectiveTimeoutMs(options, config) },
    );
    emit({
      contract: CONTRACT,
      command: "compare",
      pane_id: paneId,
      repo_root: repoRoot,
      base: result.base,
      head: result.head,
      merge_base: result.mergeBase,
      ahead: result.ahead,
      behind: result.behind,
      files: result.files,
      stat: result.stat,
      patch: result.patch.output,
      patch_truncated: result.patch.truncated,
      patch_bytes: result.patch.bytes,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

/** Resolve pane → snapshot → repo root; shared by all repo commands. */
async function repoRootForPane(
  options: CliOptions,
  config: PluginConfig,
  valueFlags: string[] = [],
): Promise<{ paneId: string; repoRoot: string }> {
  const paneId = await resolvePaneId(options.args, valueFlags);
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const cwd = paneCwd(pane);
  try {
    const repoRoot = (await resolveRepo(cwd, { timeoutMs: effectiveTimeoutMs(options, config) }))
      .root;
    return { paneId, repoRoot };
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

function mutationPayload(
  command: string,
  paneId: string,
  repoRoot: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    contract: CONTRACT,
    command,
    pane_id: paneId,
    repo_root: repoRoot,
    ok: true,
    ...fields,
    generated_at: new Date().toISOString(),
  };
}

function pathspecArgs(args: string[]): string[] {
  const paths = flagValues(args, "--path");
  for (const p of paths) {
    if (p.startsWith("-")) fail(`invalid --path value (option-like rejected): ${p}`, 2);
  }
  return paths;
}

async function cmdStageOrUnstage(options: CliOptions, unstaging: boolean): Promise<void> {
  const command = unstaging ? "unstage" : "stage";
  const config = await loadConfig();
  const { paneId, repoRoot } = await repoRootForPane(options, config, ["--path"]);
  const paths = pathspecArgs(options.args);
  const all = hasFlag(options.args, "--all");
  try {
    const run = unstaging ? collectUnstage : collectStage;
    const output = await run(
      repoRoot,
      { all, paths: paths.length > 0 ? paths : undefined },
      { timeoutMs: effectiveTimeoutMs(options, config) },
    );
    emit(mutationPayload(command, paneId, repoRoot, { all, paths, output }));
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdCommit(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const { paneId, repoRoot } = await repoRootForPane(options, config, ["-m"]);
  const messages = flagValues(options.args, "-m");
  const allowEmpty = hasFlag(options.args, "--allow-empty");
  try {
    const result = await collectCommit(
      repoRoot,
      { messages, allowEmpty },
      { timeoutMs: effectiveTimeoutMs(options, config) },
    );
    emit(
      mutationPayload("commit", paneId, repoRoot, {
        sha: result.sha,
        summary: result.summary,
      }),
    );
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

/**
 * `branch create|switch <pane> <name>` and `upstream <pane> <ref>` share
 * the "optional pane positional + required trailing value" shape: when a
 * pane is resolvable from env/context the first positional is the value,
 * otherwise the first positional is the pane and the second is the value.
 */
async function resolvePaneAndValue(
  options: CliOptions,
  config: PluginConfig,
  what: string,
): Promise<{ paneId: string; repoRoot: string; value: string }> {
  const envPane = process.env.HERDR_PANE_ID ?? invocationContext().focused_pane_id;
  const pos = positionals(options.args, []);
  let paneId: string;
  let value: string | undefined;
  if (envPane) {
    paneId = envPane;
    value = pos[0];
  } else {
    paneId = pos[0] ?? "";
    value = pos[1];
  }
  if (!paneId) fail(`pane id required for ${what}`, 2);
  if (!value) fail(`${what} requires a ${what === "upstream" ? "ref" : "name"} argument`, 2);
  try {
    assertSafeGitArg(value, what === "upstream" ? "upstream ref" : "branch name");
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 2, err.kind);
    throw err;
  }
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const cwd = paneCwd(pane);
  try {
    const repoRoot = (await resolveRepo(cwd, { timeoutMs: effectiveTimeoutMs(options, config) }))
      .root;
    return { paneId, repoRoot, value };
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdBranch(options: CliOptions): Promise<void> {
  const sub = options.args[0];
  if (sub !== "create" && sub !== "switch") {
    fail("branch requires a subcommand: create <pane> <name> [--switch] | switch <pane> <name>", 2);
  }
  const rest: CliOptions = { ...options, args: options.args.slice(1) };
  const config = await loadConfig();
  const { paneId, repoRoot, value: name } = await resolvePaneAndValue(rest, config, "branch");
  try {
    const output =
      sub === "create"
        ? await collectBranchCreate(
            repoRoot,
            { name, switchTo: hasFlag(rest.args, "--switch") },
            { timeoutMs: effectiveTimeoutMs(options, config) },
          )
        : await collectBranchSwitch(
            repoRoot,
            { name },
            {
              timeoutMs: effectiveTimeoutMs(options, config),
            },
          );
    emit(mutationPayload("branch", paneId, repoRoot, { action: sub, name, output }));
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdUpstream(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const { paneId, repoRoot, value } = await resolvePaneAndValue(options, config, "upstream");
  try {
    const output = await collectUpstream(
      repoRoot,
      { upstream: value },
      { timeoutMs: effectiveTimeoutMs(options, config) },
    );
    emit(mutationPayload("upstream", paneId, repoRoot, { upstream: value, output }));
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

/** Optional second/third positionals after the pane id (remote/refspec). */
function extraPositionals(options: CliOptions, valueFlags: string[] = []): string[] {
  return positionals(options.args, valueFlags).slice(1);
}

async function cmdFetch(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const { paneId, repoRoot } = await repoRootForPane(options, config);
  const extra = extraPositionals(options);
  if (extra.length > 1) fail("fetch accepts at most one remote argument", 2);
  const remote = extra[0];
  if (remote) {
    try {
      assertSafeGitArg(remote, "remote");
    } catch (err) {
      if (err instanceof GitError) fail(err.message, 2, err.kind);
      throw err;
    }
  }
  const prune = hasFlag(options.args, "--prune");
  try {
    const output = await collectFetch(
      repoRoot,
      { remote, prune },
      { timeoutMs: effectiveRemoteTimeoutMs(options, config) },
    );
    emit(mutationPayload("fetch", paneId, repoRoot, { remote: remote ?? null, prune, output }));
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdPush(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const { paneId, repoRoot } = await repoRootForPane(options, config);
  const extra = extraPositionals(options);
  if (extra.length > 2) fail("push accepts at most remote and refspec arguments", 2);
  const [remote, refspec] = extra;
  for (const [value, what] of [
    [remote, "remote"],
    [refspec, "refspec"],
  ] as const) {
    if (value) {
      try {
        assertSafeGitArg(value, what);
      } catch (err) {
        if (err instanceof GitError) fail(err.message, 2, err.kind);
        throw err;
      }
    }
  }
  const setUpstream = hasFlag(options.args, "--set-upstream");
  const forceWithLease = hasFlag(options.args, "--force-with-lease");
  try {
    const output = await collectPush(
      repoRoot,
      { remote, refspec, setUpstream, forceWithLease },
      { timeoutMs: effectiveRemoteTimeoutMs(options, config) },
    );
    emit(
      mutationPayload("push", paneId, repoRoot, {
        remote: remote ?? null,
        refspec: refspec ?? null,
        set_upstream: setUpstream,
        force_with_lease: forceWithLease,
        output,
      }),
    );
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdRemote(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const { paneId, repoRoot } = await repoRootForPane(options, config);
  try {
    const remotes = await collectRemotes(repoRoot, {
      timeoutMs: effectiveTimeoutMs(options, config),
    });
    emit({
      contract: CONTRACT,
      command: "remote",
      pane_id: paneId,
      repo_root: repoRoot,
      remotes,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdProject(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const paneId = await resolvePaneId(options.args);
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const cwd = paneCwd(pane);

  const warnings: string[] = [];
  let status: Record<string, unknown> | null = null;
  let tokens: Record<string, string | null> = {
    git_branch: null,
    git_changes: null,
    git_ahead_behind: null,
  };

  try {
    const report = await collectStatus(cwd, {
      timeoutMs: effectiveTimeoutMs(options, config),
    });
    status = statusPayload(paneId, report, new Date());
    const total =
      report.changes.staged +
      report.changes.unstaged +
      report.changes.untracked +
      report.changes.conflicted;
    tokens = {
      git_branch: report.branch.name,
      git_changes: String(total),
      git_ahead_behind:
        report.branch.upstream && report.branch.ahead !== null && report.branch.behind !== null
          ? `+${report.branch.ahead}/-${report.branch.behind}`
          : null,
    };
  } catch (err) {
    if (err instanceof GitError) {
      // Not a repo / bare / missing git: clear tokens and report the error
      // as data — the pane legitimately has no git projection.
      status = {
        contract: CONTRACT,
        command: "status",
        pane_id: paneId,
        error: { kind: err.kind, message: err.message },
      };
    } else {
      throw err;
    }
  }

  try {
    await reportPaneMetadata(paneId, tokens, options);
  } catch (err) {
    warnings.push(`metadata projection failed: ${String(err)}`);
  }

  emit({
    contract: CONTRACT,
    command: "project",
    pane_id: paneId,
    status,
    metadata: { applied: warnings.length === 0, tokens, warnings },
  });
}

async function cmdCapability(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    commands: [
      "capability",
      "status",
      "files",
      "diff",
      "log",
      "compare",
      "stage",
      "unstage",
      "commit",
      "branch",
      "upstream",
      "fetch",
      "push",
      "remote",
      "project",
    ],
    read_only: false,
    mutation_commands: ["stage", "unstage", "commit", "branch", "upstream", "fetch", "push"],
    requires: { git: true, bun: true },
    defaults: {
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      remoteTimeoutMs: config.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS,
      diffMaxBytes: config.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES,
    },
  });
}

const USAGE = `rebuildup.git — git status/diff/mutations for agent panes (contract ${CONTRACT})

Usage:
  git status <pane_id> [--session NAME] [--timeout MS]
  git diff <pane_id> [--staged] [--stat|--name-status|--numstat]
      [--path PATH]... [--max-bytes N] [rev [rev]]
  git files <pane_id> [--path PATH]... [--session NAME]
  git log <pane_id> [--limit N] [--skip N] [--all] [--first-parent]
      [--author X] [--grep X] [--since X] [--until X] [--path PATH]...
  git compare <pane_id> [base [head]] [--max-bytes N]
  git stage <pane_id> [--all | --path PATH]...
  git unstage <pane_id> [--all | --path PATH]...
  git commit <pane_id> -m MSG [-m MSG]... [--allow-empty]
  git branch create <pane_id> <name> [--switch]
  git branch switch <pane_id> <name>
  git upstream <pane_id> <upstream-ref>
  git fetch <pane_id> [remote] [--prune]
  git push <pane_id> [--set-upstream] [--force-with-lease] [remote] [refspec]
  git remote <pane_id>
  git project <pane_id> [--session NAME]
  git capability

Pane id may be omitted inside a plugin action context (HERDR_PANE_ID or
HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id).
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "status":
      return cmdStatus(options);
    case "diff":
      return cmdDiff(options);
    case "files":
      return cmdFiles(options);
    case "log":
      return cmdLog(options);
    case "compare":
      return cmdCompare(options);
    case "stage":
      return cmdStageOrUnstage(options, false);
    case "unstage":
      return cmdStageOrUnstage(options, true);
    case "commit":
      return cmdCommit(options);
    case "branch":
      return cmdBranch(options);
    case "upstream":
      return cmdUpstream(options);
    case "fetch":
      return cmdFetch(options);
    case "push":
      return cmdPush(options);
    case "remote":
      return cmdRemote(options);
    case "project":
      return cmdProject(options);
    case "capability":
      return cmdCapability(options);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      fail(`unknown command: ${options.command}\n\n${USAGE}`, 2);
  }
}

if (import.meta.main) {
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
}
