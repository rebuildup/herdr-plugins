/**
 * rebuildup.git CLI — Git status/diff plus local mutation contract
 * (`herdr-plugins.git/v1`) shared by the herdr TUI (via manifest actions),
 * agents, and external clients such as herdr-t3. Single JSON document on
 * stdout; diagnostics on stderr. Exit 0 success, 1 handled error, 2 usage.
 *
 * Pane selection: explicit <pane_id> argument, else HERDR_PANE_ID, else
 * HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id (manifest action context).
 * Ambient pane ids are verified against the resolved session's snapshot;
 * session/socket targeting follows `resolveTarget` — explicit flags beat
 * ambient HERDR_* and contradictions fail closed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AmbientIdentity,
  ambientIdentity,
  assertAmbientPaneIdentity,
  type CallOptions,
  type PaneInfo,
  pluginDirs,
  reportPaneMetadata,
  type SessionSnapshot,
  sessionSnapshot,
  TargetResolutionError,
} from "../../../packages/herdr-client/src/index";
import {
  collectIssueCreate,
  collectIssueList,
  collectIssueView,
  collectPrChecks,
  collectPrComments,
  collectPrCreate,
  collectPrList,
  collectPrLogs,
  collectPrReviews,
  collectPrStatus,
  collectPrView,
  ensureGh,
  GhError,
  isValidHeadSha,
  type PrLineComment,
  type PrReviewEvent,
  resolveForgeRepo,
  submitIssueComment,
  submitPrComment,
  submitPrReply,
  submitPrReview,
  updateIssue,
  updatePrReviewers,
} from "./gh";
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
  gitOk,
  resolveRepo,
  type StatusReport,
} from "./git";
import { INBOX_PLUGIN_ID, resolveInboxPluginRoot, runInboxCli } from "./inbox";

const CONTRACT = "herdr-plugins.git/v1";
const PLUGIN_ID = "rebuildup.git";
const PLUGIN_VERSION = "0.6.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 60_000;
const DEFAULT_DIFF_MAX_BYTES = 256 * 1024;

interface PluginConfig {
  timeoutMs?: number | undefined;
  remoteTimeoutMs?: number | undefined;
  diffMaxBytes?: number | undefined;
  /** Explicit rebuildup.inbox plugin root for `issue link|unlink|links`. */
  inboxPluginRoot?: string | undefined;
}

interface CliOptions extends CallOptions {
  command: string;
  args: string[];
  session: string | undefined;
}

function takeGlobalValue(args: string[], i: number, flag: string): string {
  const value = args[i + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    fail(`option ${flag} requires a value`, 2);
  }
  return value;
}

function parseGlobalTimeout(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    fail(`invalid --timeout: ${raw} (expected a positive number of milliseconds)`, 2);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = { command, args, session: undefined };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--session") {
      options.session = takeGlobalValue(args, i, "--session");
      i += 1;
    } else if (arg.startsWith("--session=")) {
      options.session = arg.slice("--session=".length);
      if (options.session.length === 0) fail("option --session requires a value", 2);
    } else if (arg === "--socket") {
      options.socketPath = takeGlobalValue(args, i, "--socket");
      i += 1;
    } else if (arg.startsWith("--socket=")) {
      options.socketPath = arg.slice("--socket=".length);
      if (!options.socketPath) fail("option --socket requires a value", 2);
    } else if (arg === "--timeout") {
      options.timeoutMs = parseGlobalTimeout(takeGlobalValue(args, i, "--timeout"));
      i += 1;
    } else if (arg.startsWith("--timeout=")) {
      options.timeoutMs = parseGlobalTimeout(arg.slice("--timeout=".length));
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

/**
 * First value of a flag, in either `--name value` or `--name=value` form.
 * Tokens after a `--` separator are positional and never match.
 */
function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") break;
    if (arg === name) return args[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

/** All values of a repeatable value flag (`--path a --path=b`). */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") break;
    if (arg === name && i + 1 < args.length) {
      out.push(args[i + 1] as string);
    } else if (arg.startsWith(`${name}=`)) {
      out.push(arg.slice(name.length + 1));
    }
  }
  return out;
}

function hasFlag(args: string[], name: string): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === name) return true;
  }
  return false;
}

type FlagKind = "boolean" | "value";

/**
 * Strict option check: every `-`-prefixed token before a `--` separator
 * must be a whitelisted flag for this command (`--name=value` counts as
 * `--name`). Unknown options, `--flag=value` on boolean flags, and value
 * flags with a missing/option-like value are usage errors (exit 2).
 * A lone `-` is a positional, not an option.
 */
function validateFlags(args: string[], spec: Record<string, FlagKind>): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") break;
    if (arg === "-" || !arg.startsWith("-")) continue;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const kind = spec[name];
    if (!kind) fail(`unknown option: ${arg}`, 2);
    if (kind === "boolean") {
      if (eq !== -1) fail(`option ${name} does not take a value`, 2);
      continue;
    }
    if (eq !== -1) continue;
    const next = args[i + 1];
    if (
      next === undefined ||
      next === "--" ||
      next.startsWith("--") ||
      (next.length > 1 && next.startsWith("-") && next in spec)
    ) {
      fail(`option ${name} requires a value`, 2);
    }
    i += 1;
  }
}

/** Positional args, skipping flag values. Everything after `--` counts. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  let afterSeparator = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (afterSeparator) {
      out.push(arg);
      continue;
    }
    if (arg === "--") {
      afterSeparator = true;
      continue;
    }
    if (valueFlags.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.length > 1 && arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

/** More positionals than the command accepts is a usage error. */
function assertMaxPositionals(
  args: string[],
  valueFlags: string[],
  max: number,
  usage: string,
): void {
  const pos = positionals(args, valueFlags);
  if (pos.length > max) {
    fail(`${usage}: unexpected argument ${JSON.stringify(pos[max])}`, 2);
  }
}

interface PaneSelection {
  paneId: string;
  /** Non-null when the pane id came from ambient env/context (not positional). */
  ambient: AmbientIdentity | null;
}

/**
 * Resolve the target pane. An explicit positional wins; otherwise the
 * ambient identity bundle (HERDR_PANE_ID / context focused_pane_id) is
 * used and kept for the post-snapshot consistency check — ambient
 * workspace/tab ids that disagree with the resolved pane fail closed.
 */
function resolvePaneSelection(args: string[], valueFlags: string[] = []): PaneSelection {
  const positional = positionals(args, valueFlags)[0];
  if (positional) return { paneId: positional, ambient: null };
  const identity = ambientIdentity();
  if (!identity.paneId) {
    fail("pane id required (argument, HERDR_PANE_ID, or plugin context)", 2);
  }
  return { paneId: identity.paneId as string, ambient: identity };
}

/** findPane + ambient identity verification for ambient-sourced pane ids. */
async function findPaneChecked(
  snapshot: SessionSnapshot,
  selection: PaneSelection,
): Promise<PaneInfo> {
  const pane = await findPane(snapshot, selection.paneId);
  if (selection.ambient) assertAmbientPaneIdentity(pane, selection.ambient);
  return pane;
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
      inboxPluginRoot:
        typeof parsed.inboxPluginRoot === "string" && parsed.inboxPluginRoot !== ""
          ? parsed.inboxPluginRoot
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
  validateFlags(options.args, {});
  assertMaxPositionals(options.args, [], 1, "status <pane_id>");
  const config = await loadConfig();
  const selection = resolvePaneSelection(options.args);
  const paneId = selection.paneId;
  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, selection);
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
const DIFF_FLAGS: Record<string, FlagKind> = {
  "--path": "value",
  "--max-bytes": "value",
  "--staged": "boolean",
  "--stat": "boolean",
  "--name-status": "boolean",
  "--numstat": "boolean",
};

async function cmdFiles(options: CliOptions): Promise<void> {
  validateFlags(options.args, { "--path": "value" });
  assertMaxPositionals(options.args, ["--path"], 1, "files <pane_id>");
  const config = await loadConfig();
  const selection = resolvePaneSelection(options.args, ["--path"]);
  const paneId = selection.paneId;
  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, selection);
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
  validateFlags(options.args, DIFF_FLAGS);
  assertMaxPositionals(options.args, DIFF_VALUE_FLAGS, 3, "diff <pane_id> [rev [rev]]");
  const config = await loadConfig();
  const selection = resolvePaneSelection(options.args, DIFF_VALUE_FLAGS);
  const paneId = selection.paneId;
  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, selection);
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
const LOG_FLAGS: Record<string, FlagKind> = {
  "--limit": "value",
  "--skip": "value",
  "--author": "value",
  "--grep": "value",
  "--since": "value",
  "--until": "value",
  "--path": "value",
  "--all": "boolean",
  "--first-parent": "boolean",
};

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
  validateFlags(options.args, LOG_FLAGS);
  assertMaxPositionals(options.args, LOG_VALUE_FLAGS, 1, "log <pane_id>");
  const config = await loadConfig();
  const selection = resolvePaneSelection(options.args, LOG_VALUE_FLAGS);
  const paneId = selection.paneId;
  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, selection);
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
  validateFlags(options.args, { "--max-bytes": "value" });
  assertMaxPositionals(options.args, ["--max-bytes"], 3, "compare <pane_id> [base [head]]");
  const config = await loadConfig();
  const selection = resolvePaneSelection(options.args, ["--max-bytes"]);
  const paneId = selection.paneId;
  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, selection);
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
  const selection = resolvePaneSelection(options.args, valueFlags);
  const paneId = selection.paneId;
  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, selection);
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

const STAGE_FLAGS: Record<string, FlagKind> = { "--all": "boolean", "--path": "value" };

async function cmdStageOrUnstage(options: CliOptions, unstaging: boolean): Promise<void> {
  options.mutation = true;
  const command = unstaging ? "unstage" : "stage";
  validateFlags(options.args, STAGE_FLAGS);
  assertMaxPositionals(options.args, ["--path"], 1, `${command} <pane_id>`);
  const paths = pathspecArgs(options.args);
  const all = hasFlag(options.args, "--all");
  if (all && paths.length > 0) {
    fail(`${command}: --all and --path are mutually exclusive`, 2);
  }
  if (!all && paths.length === 0) {
    fail(`${command} requires --all or at least one --path`, 2);
  }
  const config = await loadConfig();
  const { paneId, repoRoot } = await repoRootForPane(options, config, ["--path"]);
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
  options.mutation = true;
  validateFlags(options.args, { "-m": "value", "--allow-empty": "boolean" });
  assertMaxPositionals(options.args, ["-m"], 1, "commit <pane_id>");
  const messages = flagValues(options.args, "-m");
  if (messages.length === 0) fail("commit requires at least one -m <message>", 2);
  if (messages.some((m) => m.length === 0)) fail("commit -m requires a non-empty message", 2);
  const allowEmpty = hasFlag(options.args, "--allow-empty");
  const config = await loadConfig();
  const { paneId, repoRoot } = await repoRootForPane(options, config, ["-m"]);
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
  const identity = ambientIdentity();
  const pos = positionals(options.args, []);
  let paneId: string;
  let value: string | undefined;
  let ambient: AmbientIdentity | null = null;
  if (identity.paneId) {
    paneId = identity.paneId;
    value = pos[0];
    ambient = identity;
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
  const pane = await findPaneChecked(snapshot, { paneId, ambient });
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
  options.mutation = true;
  const sub = options.args[0];
  if (sub !== "create" && sub !== "switch") {
    fail("branch requires a subcommand: create <pane> <name> [--switch] | switch <pane> <name>", 2);
  }
  const rest: CliOptions = { ...options, args: options.args.slice(1) };
  // --switch only exists on `branch create`; `branch switch` takes none.
  validateFlags(rest.args, sub === "create" ? { "--switch": "boolean" } : {});
  assertMaxPositionals(rest.args, [], 2, `branch ${sub}`);
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
  options.mutation = true;
  validateFlags(options.args, {});
  assertMaxPositionals(options.args, [], 2, "upstream <pane_id> <upstream-ref>");
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
  options.mutation = true;
  validateFlags(options.args, { "--prune": "boolean" });
  assertMaxPositionals(options.args, [], 2, "fetch <pane_id> [remote]");
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
  options.mutation = true;
  validateFlags(options.args, {
    "--set-upstream": "boolean",
    "--force-with-lease": "boolean",
  });
  assertMaxPositionals(options.args, [], 3, "push <pane_id> [remote] [refspec]");
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
  validateFlags(options.args, {});
  assertMaxPositionals(options.args, [], 1, "remote <pane_id>");
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

const PR_VALUE_FLAGS = [
  "--repo",
  "--limit",
  "--state",
  "--head",
  "--title",
  "--body",
  "--body-file",
  "--base",
  "--run",
  "--job",
  "--lines",
  "--expect-head",
  "--comments-file",
  "--add-reviewer",
  "--remove-reviewer",
];

interface PrBodyInput {
  /** Inline `--body` value. */
  body: string | undefined;
  /** `"--body-file -"` effective value: `-` when the body is piped. */
  bodyFile: string | undefined;
  /** Body text resolved from `--body-file` (file contents or stdin). */
  bodyText: string | undefined;
}

/**
 * Shared `--body`/`--body-file` resolution for `pr create` and the forge
 * mutations: the flags are mutually exclusive, `-` reads stdin, and real
 * file paths are read into memory so the text can be piped to `gh` (or
 * folded into an `gh api --input -` payload) instead of riding in argv.
 */
async function resolvePrBody(args: string[]): Promise<PrBodyInput> {
  const body = flagValue(args, "--body");
  const bodyFile = flagValue(args, "--body-file");
  if (body !== undefined && bodyFile !== undefined) {
    fail("--body and --body-file are mutually exclusive", 2);
  }
  let bodyText: string | undefined;
  let effectiveBodyFile = bodyFile;
  if (bodyFile && bodyFile !== "-") {
    try {
      bodyText = await readFile(bodyFile, "utf8");
      effectiveBodyFile = "-";
    } catch {
      fail(`cannot read --body-file: ${bodyFile}`, 2);
    }
  } else if (bodyFile === "-") {
    bodyText = await Bun.stdin.text();
  }
  return { body, bodyFile: effectiveBodyFile, bodyText };
}

/** Effective body text for `gh api` payloads (file/stdin already resolved). */
function prBodyText(input: PrBodyInput): string | undefined {
  return input.body ?? input.bodyText;
}

/**
 * Per-action option whitelist for `pr`. Flags are only valid on the
 * action that documents them — e.g. `--state` on `pr create` is a
 * usage error, not silently ignored.
 */
const PR_FLAG_SPECS: Record<string, Record<string, FlagKind>> = {
  list: {
    "--repo": "value",
    "--limit": "value",
    "--state": "value",
    "--head": "value",
  },
  status: { "--repo": "value" },
  view: { "--repo": "value" },
  create: {
    "--repo": "value",
    "--title": "value",
    "--body": "value",
    "--body-file": "value",
    "--base": "value",
    "--head": "value",
    "--draft": "boolean",
  },
  reviews: { "--repo": "value" },
  comments: { "--repo": "value" },
  checks: { "--repo": "value" },
  logs: {
    "--repo": "value",
    "--run": "value",
    "--job": "value",
    "--lines": "value",
  },
  review: {
    "--repo": "value",
    "--expect-head": "value",
    "--approve": "boolean",
    "--request-changes": "boolean",
    "--comment": "boolean",
    "--body": "value",
    "--body-file": "value",
    "--comments-file": "value",
  },
  comment: {
    "--repo": "value",
    "--expect-head": "value",
    "--body": "value",
    "--body-file": "value",
  },
  reply: {
    "--repo": "value",
    "--expect-head": "value",
    "--body": "value",
    "--body-file": "value",
  },
  reviewers: {
    "--repo": "value",
    "--expect-head": "value",
    "--add-reviewer": "value",
    "--remove-reviewer": "value",
  },
};

/**
 * `pr <action> <pane> [args]` — GitHub PR surface via the host `gh` CLI.
 * Positionals: [action, pane, ...rest]; pane falls back to env/context.
 * All argument validation runs before any snapshot/gh access so usage
 * errors exit 2 regardless of environment.
 */
async function cmdPr(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = effectiveRemoteTimeoutMs(options, config);
  const pos = positionals(options.args, PR_VALUE_FLAGS);
  const action = pos[0];
  if (!action || !(action in PR_FLAG_SPECS)) {
    fail(
      "pr requires an action: list | status | create | view | reviews | comments | checks | logs | review | comment | reply | reviewers",
      2,
    );
  }
  const spec = PR_FLAG_SPECS[action] as Record<string, FlagKind>;
  validateFlags(options.args, spec);
  // Forge-mutating actions (`create`, `review`, `comment`, `reply`,
  // `reviewers`) need an explicit or consistent ambient target, never the
  // implicit default socket. Read actions keep the read-side resolution.
  if (["create", "review", "comment", "reply", "reviewers"].includes(action)) {
    options.mutation = true;
  }
  const identity = ambientIdentity();
  const explicitPane = pos[1];
  const paneId = explicitPane ?? identity.paneId;
  const ambient = explicitPane === undefined ? identity : null;
  if (!paneId) {
    fail("pane id required (argument, HERDR_PANE_ID, or plugin context)", 2);
  }
  const rest = pos.slice(2);

  // Per-action argument validation (all usage errors, exit 2).
  if (action === "list" || action === "status") {
    if (rest.length > 0) fail(`pr ${action} takes no positional arguments`, 2);
  }
  if (action === "view") {
    const number = Number(rest[0]);
    if (!Number.isInteger(number) || number < 1) {
      fail("pr view requires a positive PR number", 2);
    }
    if (rest.length > 1) fail("pr view accepts at most one PR number", 2);
  }
  if (action === "list") {
    const stateRaw = flagValue(options.args, "--state") ?? "open";
    if (!["open", "closed", "merged", "all"].includes(stateRaw)) {
      fail(`invalid --state: ${stateRaw}`, 2);
    }
    const limitRaw = flagValue(options.args, "--limit");
    if (limitRaw !== undefined) {
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        fail(`invalid --limit: ${limitRaw}`, 2);
      }
    }
    const head = flagValue(options.args, "--head");
    if (head?.startsWith("-")) {
      fail("invalid --head value", 2);
    }
  }
  if (action === "create") {
    const title = flagValue(options.args, "--title");
    if (!title) fail("pr create requires --title", 2);
    if (
      flagValue(options.args, "--body") !== undefined &&
      flagValue(options.args, "--body-file") !== undefined
    ) {
      fail("--body and --body-file are mutually exclusive", 2);
    }
    if (rest.length > 0) fail("pr create takes no positional arguments", 2);
    for (const what of ["base", "head"] as const) {
      const value = flagValue(options.args, `--${what}`);
      if (value?.startsWith("-")) {
        fail(`invalid --${what} value`, 2);
      }
    }
  }

  const repoFlag = flagValue(options.args, "--repo");
  if (repoFlag !== undefined) {
    if (repoFlag.startsWith("-") || !/^[^\s/]+\/[^\s/]+$/.test(repoFlag)) {
      fail(`invalid --repo value: ${JSON.stringify(repoFlag)}`, 2);
    }
  }

  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, { paneId, ambient });
  let repoRoot: string;
  try {
    repoRoot = (
      await resolveRepo(paneCwd(pane), { timeoutMs: effectiveTimeoutMs(options, config) })
    ).root;
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }

  try {
    await ensureGh(repoRoot, { timeoutMs });
  } catch (err) {
    if (err instanceof GhError) fail(err.message, 1, err.kind);
    throw err;
  }

  const forgeBase = {
    contract: CONTRACT,
    command: "pr",
    pane_id: paneId,
    repo_root: repoRoot,
    generated_at: new Date().toISOString(),
  };

  try {
    const repo = await resolveForgeRepo(repoRoot, { repo: repoFlag }, { timeoutMs });
    const ghOptions = { timeoutMs };

    if (action === "list") {
      const stateRaw = (flagValue(options.args, "--state") ?? "open") as
        | "open"
        | "closed"
        | "merged"
        | "all";
      const limitRaw = flagValue(options.args, "--limit");
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      const head = flagValue(options.args, "--head");
      const prs = await collectPrList(
        repoRoot,
        {
          repo,
          limit,
          state: stateRaw,
          head,
        },
        ghOptions,
      );
      emit({ ...forgeBase, action: "list", repo, prs });
      return;
    }

    if (action === "status") {
      const branch = (
        await gitOk(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], ghOptions)
      ).trim();
      if (branch === "HEAD") {
        emit({ ...forgeBase, action: "status", repo, branch, detached: true, pr: null });
        return;
      }
      const pr = await collectPrStatus(repoRoot, { repo, branch }, ghOptions);
      emit({ ...forgeBase, action: "status", repo, branch, pr });
      return;
    }

    if (action === "view") {
      const number = Number(rest[0]);
      const pr = await collectPrView(repoRoot, { repo, number }, ghOptions);
      emit({ ...forgeBase, action: "view", repo, pr });
      return;
    }

    // Read-only review/check/log surface (Issue #171). All share the
    // `pr <action> <pane> <number>` shape; `logs` adds --run/--job/--lines.
    if (["reviews", "comments", "checks", "logs"].includes(action)) {
      const number = Number(rest[0]);
      if (!Number.isInteger(number) || number < 1) {
        fail(`pr ${action} requires a positive PR number`, 2);
      }
      if (rest.length > 1) fail(`pr ${action} accepts at most one PR number`, 2);

      if (action === "reviews") {
        const data = await collectPrReviews(repoRoot, { repo, number }, ghOptions);
        emit({ ...forgeBase, action: "reviews", repo, ...data });
        return;
      }
      if (action === "comments") {
        const data = await collectPrComments(repoRoot, { repo, number }, ghOptions);
        emit({ ...forgeBase, action: "comments", repo, ...data });
        return;
      }
      if (action === "checks") {
        const data = await collectPrChecks(repoRoot, { repo, number }, ghOptions);
        emit({ ...forgeBase, action: "checks", repo, ...data });
        return;
      }

      // action === "logs"
      const runRaw = flagValue(options.args, "--run");
      const jobRaw = flagValue(options.args, "--job");
      const linesRaw = flagValue(options.args, "--lines");
      for (const [raw, what] of [
        [runRaw, "--run"],
        [jobRaw, "--job"],
      ] as const) {
        if (raw !== undefined && !/^\d+$/.test(raw)) {
          fail(`invalid ${what}: ${raw} (positive integer required)`, 2);
        }
      }
      if (runRaw !== undefined && jobRaw !== undefined) {
        fail("--run and --job are mutually exclusive", 2);
      }
      let lines: number | undefined;
      if (linesRaw !== undefined) {
        lines = Number(linesRaw);
        if (!Number.isInteger(lines) || lines < 1 || lines > 2000) {
          fail(`invalid --lines: ${linesRaw}`, 2);
        }
        if (jobRaw === undefined) fail("--lines requires --job", 2);
      }
      const data = await collectPrLogs(
        repoRoot,
        {
          repo,
          number,
          runId: runRaw,
          jobId: jobRaw,
          lines,
        },
        ghOptions,
      );
      emit({ ...forgeBase, action: "logs", repo, ...data });
      return;
    }

    // Forge mutations (Issue #172): review / comment / reply / reviewers.
    // Every mutation requires --expect-head <full sha> — the mandatory
    // stale-head guard re-fetches the PR head immediately before writing
    // and refuses with kind "stale_head" when it moved. These are explicit
    // user/agent invocations only; no automation path exists (the
    // github-delivery release-approval boundary is never bypassed).
    if (["review", "comment", "reply", "reviewers"].includes(action)) {
      const number = Number(rest[0]);
      if (!Number.isInteger(number) || number < 1) {
        fail(`pr ${action} requires a positive PR number`, 2);
      }
      const expectHeadRaw = flagValue(options.args, "--expect-head");
      if (!expectHeadRaw || !isValidHeadSha(expectHeadRaw)) {
        fail(
          `pr ${action} requires --expect-head <full head sha> (head.sha from a prior pr read)`,
          2,
        );
      }
      const expectHead = expectHeadRaw;

      if (action === "review") {
        if (rest.length > 1) fail("pr review accepts at most one PR number", 2);
        const events = (
          [
            ["--approve", "APPROVE"],
            ["--request-changes", "REQUEST_CHANGES"],
            ["--comment", "COMMENT"],
          ] as const
        )
          .filter(([flag]) => hasFlag(options.args, flag))
          .map(([, event]) => event);
        if (events.length !== 1) {
          fail("pr review requires exactly one of --approve, --request-changes, --comment", 2);
        }
        const commentsFile = flagValue(options.args, "--comments-file");
        const bodyInput = await resolvePrBody(options.args);
        if (commentsFile === "-" && bodyInput.bodyFile === "-") {
          fail("--body-file - and --comments-file - cannot both read stdin", 2);
        }
        let comments: PrLineComment[] | undefined;
        if (commentsFile !== undefined) {
          let raw: string;
          if (commentsFile === "-") {
            raw = await Bun.stdin.text();
          } else {
            try {
              raw = await readFile(commentsFile, "utf8");
            } catch {
              fail(`cannot read --comments-file: ${commentsFile}`, 2);
            }
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            fail("--comments-file is not valid JSON", 2);
          }
          if (!Array.isArray(parsed)) {
            fail("--comments-file must contain a JSON array of line comments", 2);
          }
          comments = parsed as PrLineComment[];
        }
        const data = await submitPrReview(
          repoRoot,
          {
            repo,
            number,
            expectHead,
            event: events[0] as PrReviewEvent,
            body: prBodyText(bodyInput),
            comments,
          },
          ghOptions,
        );
        emit({ ...forgeBase, action: "review", repo, ok: true, ...data });
        return;
      }

      if (action === "comment") {
        if (rest.length > 1) fail("pr comment accepts at most one PR number", 2);
        const bodyInput = await resolvePrBody(options.args);
        const body = prBodyText(bodyInput);
        if (body === undefined || body.trim().length === 0) {
          fail("pr comment requires --body or --body-file", 2);
        }
        const data = await submitPrComment(repoRoot, { repo, number, expectHead, body }, ghOptions);
        emit({ ...forgeBase, action: "comment", repo, ok: true, ...data });
        return;
      }

      if (action === "reply") {
        if (rest.length !== 2) {
          fail("pr reply requires a PR number and a review-comment id", 2);
        }
        const commentId = Number(rest[1]);
        if (!Number.isInteger(commentId) || commentId < 1) {
          fail("pr reply requires a positive review-comment id", 2);
        }
        const bodyInput = await resolvePrBody(options.args);
        const body = prBodyText(bodyInput);
        if (body === undefined || body.trim().length === 0) {
          fail("pr reply requires --body or --body-file", 2);
        }
        const data = await submitPrReply(
          repoRoot,
          { repo, number, expectHead, commentId, body },
          ghOptions,
        );
        emit({ ...forgeBase, action: "reply", repo, ok: true, ...data });
        return;
      }

      // action === "reviewers"
      if (rest.length > 1) fail("pr reviewers accepts at most one PR number", 2);
      const splitLogins = (flag: string): string[] =>
        flagValues(options.args, flag)
          .flatMap((value) => value.split(","))
          .map((login) => login.trim())
          .filter((login) => login.length > 0);
      const add = splitLogins("--add-reviewer");
      const remove = splitLogins("--remove-reviewer");
      if (add.length === 0 && remove.length === 0) {
        fail("pr reviewers requires --add-reviewer and/or --remove-reviewer", 2);
      }
      const data = await updatePrReviewers(
        repoRoot,
        { repo, number, expectHead, add, remove },
        ghOptions,
      );
      emit({ ...forgeBase, action: "reviewers", repo, ok: true, ...data });
      return;
    }

    // action === "create"
    const title = flagValue(options.args, "--title");
    if (!title) fail("pr create requires --title", 2);
    const bodyInput = await resolvePrBody(options.args);
    const base = flagValue(options.args, "--base");
    const head = flagValue(options.args, "--head");

    const created = await collectPrCreate(
      repoRoot,
      {
        repo,
        title,
        body: bodyInput.body,
        bodyFile: bodyInput.bodyFile,
        draft: hasFlag(options.args, "--draft"),
        base,
        head,
      },
      { ...ghOptions, bodyText: bodyInput.bodyText },
    );
    emit({
      ...forgeBase,
      action: "create",
      repo,
      ok: true,
      url: created.url,
      number: created.number,
    });
  } catch (err) {
    if (err instanceof GhError) fail(err.message, 1, err.kind);
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// `issue` — GitHub issue surface (Issue #174) plus pane↔issue links.
//
// Forge actions (`list|view|create|edit|comment|close`) share the `pr`
// pane→repo resolution and `--repo` override. Mutations set
// `options.mutation = true` before any target resolution so they fail
// closed without an explicit/consistent target. Issues have no head sha,
// so there is no `--expect-head` analog — the mutation gate plus explicit
// invocation is the guard (documented in git-v1.md).
//
// `link|unlink|links` are pane-scoped tracker associations owned by
// rebuildup.inbox (inbox-v1 link/unlink/links). They delegate to the
// inbox plugin's public CLI (ADR-0013 sibling pattern) — the git plugin
// keeps no link state of its own.
// ---------------------------------------------------------------------------

const ISSUE_VALUE_FLAGS = [
  "--repo",
  "--limit",
  "--state",
  "--label",
  "--assignee",
  "--author",
  "--title",
  "--body",
  "--body-file",
  "--add-label",
  "--remove-label",
  "--add-assignee",
  "--remove-assignee",
  "--reason",
];

const ISSUE_FLAG_SPECS: Record<string, Record<string, FlagKind>> = {
  list: {
    "--repo": "value",
    "--limit": "value",
    "--state": "value",
    "--label": "value",
    "--assignee": "value",
    "--author": "value",
  },
  view: { "--repo": "value" },
  create: {
    "--repo": "value",
    "--title": "value",
    "--body": "value",
    "--body-file": "value",
    "--label": "value",
    "--assignee": "value",
  },
  edit: {
    "--repo": "value",
    "--title": "value",
    "--body": "value",
    "--body-file": "value",
    "--add-label": "value",
    "--remove-label": "value",
    "--add-assignee": "value",
    "--remove-assignee": "value",
    "--state": "value",
  },
  comment: { "--repo": "value", "--body": "value", "--body-file": "value" },
  close: { "--repo": "value", "--reason": "value" },
  link: { "--verify": "boolean" },
  unlink: {},
  links: {},
};

/** Actions that write forge state or plugin (inbox) state. */
const ISSUE_MUTATION_ACTIONS = new Set(["create", "edit", "comment", "close", "link", "unlink"]);

/** Same `<owner>/<repo>#<n>` grammar as inbox-v1 tracker refs. */
const TRACKER_REF_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+)#([1-9][0-9]*)$/;

function parseIssueTrackerRef(spec: string): { repo: string; number: number } {
  const match = TRACKER_REF_PATTERN.exec(spec);
  if (!match) {
    fail(`invalid issue ref (expected <owner>/<repo>#<number>): ${spec}`, 2);
  }
  return { repo: match[1] as string, number: Number(match[2]) };
}

/** Comma-split + trim a repeatable value flag into items. */
function flagItems(args: string[], flag: string): string[] {
  return flagValues(args, flag)
    .flatMap((value) => value.split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Reject option-like label/assignee values before they reach gh argv. */
function assertForgeItems(items: string[], flag: string): void {
  for (const item of items) {
    if (item.startsWith("-")) {
      fail(`invalid ${flag} value (option-like rejected): ${item}`, 2);
    }
  }
}

function positiveIssueNumber(action: string, rest: string[]): number {
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) {
    fail(`issue ${action} requires a positive issue number`, 2);
  }
  if (rest.length > 1) fail(`issue ${action} accepts at most one issue number`, 2);
  return number;
}

/**
 * `issue link|unlink|links` — delegate to rebuildup.inbox's public CLI.
 * The pane↔issue association lives in inbox plugin state only; this
 * surface re-wraps the inbox JSON under the git contract and propagates
 * its errors (target gating, pane lookup, staleness rules) unchanged.
 */
async function cmdIssueLink(
  options: CliOptions,
  config: PluginConfig,
  action: "link" | "unlink" | "links",
  paneId: string,
  rest: string[],
): Promise<void> {
  const inboxArgs: string[] = [];
  if (action === "links") {
    inboxArgs.push("links", paneId);
  } else {
    const { repo, number } = parseIssueTrackerRef(rest[0] as string);
    inboxArgs.push(action, paneId, "--issue", `${repo}#${number}`);
    if (action === "link" && hasFlag(options.args, "--verify")) {
      inboxArgs.push("--verify");
    }
  }

  const resolution = await resolveInboxPluginRoot(config.inboxPluginRoot);
  if (!resolution.ok) {
    fail(`inbox plugin unavailable: ${resolution.error}`, 1, "inbox_unavailable");
  }
  const result = await runInboxCli(resolution.root, inboxArgs, {
    session: options.session,
    socketPath: options.socketPath,
    timeoutMs: effectiveTimeoutMs(options, config),
  });
  if (result.status !== 0) {
    const message = result.error?.message ?? result.stderr.trim() ?? "";
    if (result.status === 2 || result.error?.code === "usage") {
      fail(message || `inbox ${action} usage error`, 2);
    }
    const kind =
      result.error?.code && result.error.code !== "error" ? result.error.code : "inbox_error";
    fail(message || `inbox ${action} failed (exit ${result.status})`, 1, kind);
  }

  const data = result.json ?? {};
  const payload: Record<string, unknown> = {
    contract: CONTRACT,
    command: "issue",
    action,
    pane_id: paneId,
    delegated: INBOX_PLUGIN_ID,
    ok: true,
    generated_at: new Date().toISOString(),
  };
  if (data.link !== undefined) payload.link = data.link;
  if (data.removed !== undefined) payload.removed = data.removed;
  if (Array.isArray(data.links)) payload.links = data.links;
  if (Array.isArray(data.warnings)) payload.warnings = data.warnings;
  emit(payload);
}

/**
 * `issue <action> <pane_id> [args]` — GitHub issue surface via `gh`,
 * plus pane link delegation to rebuildup.inbox. All argument validation
 * runs before any snapshot/gh/inbox access so usage errors exit 2
 * regardless of environment.
 */
async function cmdIssue(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = effectiveRemoteTimeoutMs(options, config);
  const pos = positionals(options.args, ISSUE_VALUE_FLAGS);
  const action = pos[0];
  if (!action || !(action in ISSUE_FLAG_SPECS)) {
    fail(
      "issue requires an action: list | view | create | edit | comment | close | link | unlink | links",
      2,
    );
  }
  const spec = ISSUE_FLAG_SPECS[action] as Record<string, FlagKind>;
  validateFlags(options.args, spec);
  // Forge/inbox mutations need an explicit or consistent ambient target,
  // never the implicit default socket — same rule as `pr` mutations.
  if (ISSUE_MUTATION_ACTIONS.has(action)) {
    options.mutation = true;
  }
  const identity = ambientIdentity();
  const explicitPane = pos[1];
  const paneId = explicitPane ?? identity.paneId;
  const ambient = explicitPane === undefined ? identity : null;
  if (!paneId) {
    fail("pane id required (argument, HERDR_PANE_ID, or plugin context)", 2);
  }
  const rest = pos.slice(2);

  // --- link surface: pure delegation, no repo/gh resolution needed ---
  if (action === "link" || action === "unlink" || action === "links") {
    if (action === "links") {
      if (rest.length > 0) fail("issue links takes no positional arguments", 2);
    } else {
      if (rest.length !== 1) {
        fail(`issue ${action} requires exactly one <owner>/<repo>#<number> argument`, 2);
      }
      parseIssueTrackerRef(rest[0] as string);
    }
    return cmdIssueLink(options, config, action, paneId, rest);
  }

  // --- per-action argument validation (usage errors, exit 2) ---
  if (action === "list") {
    if (rest.length > 0) fail("issue list takes no positional arguments", 2);
    const stateRaw = flagValue(options.args, "--state") ?? "open";
    if (!["open", "closed", "all"].includes(stateRaw)) {
      fail(`invalid --state: ${stateRaw}`, 2);
    }
    const limitRaw = flagValue(options.args, "--limit");
    if (limitRaw !== undefined) {
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        fail(`invalid --limit: ${limitRaw}`, 2);
      }
    }
    for (const flag of ["--label", "--assignee", "--author"] as const) {
      assertForgeItems(flagItems(options.args, flag), flag);
    }
  }
  if (action === "view") {
    positiveIssueNumber("view", rest);
  }
  if (action === "create") {
    const title = flagValue(options.args, "--title");
    if (!title || title.trim().length === 0) fail("issue create requires --title", 2);
    if (
      flagValue(options.args, "--body") !== undefined &&
      flagValue(options.args, "--body-file") !== undefined
    ) {
      fail("--body and --body-file are mutually exclusive", 2);
    }
    if (rest.length > 0) fail("issue create takes no positional arguments", 2);
    for (const flag of ["--label", "--assignee"] as const) {
      assertForgeItems(flagItems(options.args, flag), flag);
    }
  }
  if (action === "edit") {
    positiveIssueNumber("edit", rest);
    const hasField =
      flagValue(options.args, "--title") !== undefined ||
      flagValue(options.args, "--body") !== undefined ||
      flagValue(options.args, "--body-file") !== undefined ||
      flagItems(options.args, "--add-label").length > 0 ||
      flagItems(options.args, "--remove-label").length > 0 ||
      flagItems(options.args, "--add-assignee").length > 0 ||
      flagItems(options.args, "--remove-assignee").length > 0 ||
      flagValue(options.args, "--state") !== undefined;
    if (!hasField) {
      fail(
        "issue edit requires at least one of --title/--body/--body-file/--add-label/--remove-label/--add-assignee/--remove-assignee/--state",
        2,
      );
    }
    const stateRaw = flagValue(options.args, "--state");
    if (stateRaw !== undefined && !["open", "closed"].includes(stateRaw)) {
      fail(`invalid --state: ${stateRaw}`, 2);
    }
    if (
      flagValue(options.args, "--body") !== undefined &&
      flagValue(options.args, "--body-file") !== undefined
    ) {
      fail("--body and --body-file are mutually exclusive", 2);
    }
    for (const flag of [
      "--add-label",
      "--remove-label",
      "--add-assignee",
      "--remove-assignee",
    ] as const) {
      assertForgeItems(flagItems(options.args, flag), flag);
    }
  }
  if (action === "comment") {
    positiveIssueNumber("comment", rest);
  }
  if (action === "close") {
    positiveIssueNumber("close", rest);
    const reason = flagValue(options.args, "--reason");
    if (reason !== undefined && !["completed", "not planned"].includes(reason)) {
      fail(`invalid --reason: ${reason}`, 2);
    }
  }

  const repoFlag = flagValue(options.args, "--repo");
  if (repoFlag !== undefined) {
    if (repoFlag.startsWith("-") || !/^[^\s/]+\/[^\s/]+$/.test(repoFlag)) {
      fail(`invalid --repo value: ${JSON.stringify(repoFlag)}`, 2);
    }
  }

  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, { paneId, ambient });
  let repoRoot: string;
  try {
    repoRoot = (
      await resolveRepo(paneCwd(pane), { timeoutMs: effectiveTimeoutMs(options, config) })
    ).root;
  } catch (err) {
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }

  try {
    await ensureGh(repoRoot, { timeoutMs });
  } catch (err) {
    if (err instanceof GhError) fail(err.message, 1, err.kind);
    throw err;
  }

  const forgeBase = {
    contract: CONTRACT,
    command: "issue",
    pane_id: paneId,
    repo_root: repoRoot,
    generated_at: new Date().toISOString(),
  };

  try {
    const repo = await resolveForgeRepo(repoRoot, { repo: repoFlag }, { timeoutMs });
    const ghOptions = { timeoutMs };

    if (action === "list") {
      const stateRaw = (flagValue(options.args, "--state") ?? "open") as "open" | "closed" | "all";
      const limitRaw = flagValue(options.args, "--limit");
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      const issues = await collectIssueList(
        repoRoot,
        {
          repo,
          limit,
          state: stateRaw,
          label: flagItems(options.args, "--label"),
          assignee: flagItems(options.args, "--assignee"),
          author: flagValue(options.args, "--author"),
        },
        ghOptions,
      );
      emit({ ...forgeBase, action: "list", repo, issues });
      return;
    }

    if (action === "view") {
      const number = Number(rest[0]);
      const issue = await collectIssueView(repoRoot, { repo, number }, ghOptions);
      emit({ ...forgeBase, action: "view", repo, issue });
      return;
    }

    if (action === "create") {
      const title = flagValue(options.args, "--title") as string;
      const bodyInput = await resolvePrBody(options.args);
      const created = await collectIssueCreate(
        repoRoot,
        {
          repo,
          title,
          body: bodyInput.body,
          bodyFile: bodyInput.bodyFile,
          labels: flagItems(options.args, "--label"),
          assignees: flagItems(options.args, "--assignee"),
        },
        { ...ghOptions, bodyText: bodyInput.bodyText },
      );
      emit({
        ...forgeBase,
        action: "create",
        repo,
        ok: true,
        url: created.url,
        number: created.number,
      });
      return;
    }

    if (action === "edit") {
      const number = Number(rest[0]);
      const bodyInput = await resolvePrBody(options.args);
      const stateRaw = flagValue(options.args, "--state");
      const data = await updateIssue(
        repoRoot,
        {
          repo,
          number,
          title: flagValue(options.args, "--title"),
          body: bodyInput.body,
          bodyFile: bodyInput.bodyFile,
          addLabels: flagItems(options.args, "--add-label"),
          removeLabels: flagItems(options.args, "--remove-label"),
          addAssignees: flagItems(options.args, "--add-assignee"),
          removeAssignees: flagItems(options.args, "--remove-assignee"),
          state: stateRaw === undefined ? undefined : (stateRaw as "open" | "closed"),
        },
        { ...ghOptions, bodyText: bodyInput.bodyText },
      );
      emit({ ...forgeBase, action: "edit", repo, ok: true, ...data });
      return;
    }

    if (action === "comment") {
      const number = Number(rest[0]);
      const bodyInput = await resolvePrBody(options.args);
      const body = prBodyText(bodyInput);
      if (body === undefined || body.trim().length === 0) {
        fail("issue comment requires --body or --body-file", 2);
      }
      const data = await submitIssueComment(repoRoot, { repo, number, body }, ghOptions);
      emit({ ...forgeBase, action: "comment", repo, ok: true, ...data });
      return;
    }

    // action === "close"
    const number = Number(rest[0]);
    const data = await updateIssue(
      repoRoot,
      {
        repo,
        number,
        state: "closed",
        reason: flagValue(options.args, "--reason"),
      },
      ghOptions,
    );
    emit({ ...forgeBase, action: "close", repo, ok: true, ...data });
  } catch (err) {
    if (err instanceof GhError) fail(err.message, 1, err.kind);
    if (err instanceof GitError) fail(err.message, 1, err.kind);
    throw err;
  }
}

async function cmdProject(options: CliOptions): Promise<void> {
  // project writes pane metadata tokens — a mutation of herdr state.
  options.mutation = true;
  validateFlags(options.args, {});
  assertMaxPositionals(options.args, [], 1, "project <pane_id>");
  const config = await loadConfig();
  const selection = resolvePaneSelection(options.args);
  const paneId = selection.paneId;
  const snapshot = await sessionSnapshot(options);
  const pane = await findPaneChecked(snapshot, selection);
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
  validateFlags(options.args, {});
  assertMaxPositionals(options.args, [], 0, "capability");
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
      "pr",
      "issue",
      "project",
    ],
    read_only: false,
    mutation_commands: [
      "stage",
      "unstage",
      "commit",
      "branch",
      "upstream",
      "fetch",
      "push",
      "pr",
      "issue",
    ],
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
  git pr list|status|create|view|reviews|comments|checks|logs
      <pane_id> [args] [--repo owner/name]
      pr create: --title T [--body B | --body-file PATH|-] [--draft]
          [--base B] [--head B]
      pr reviews|comments|checks <pane> <number>
      pr logs <pane> <number> [--run ID | --job ID [--lines N]]
  git pr review|comment|reply|reviewers <pane_id> [args]
      [--repo owner/name] --expect-head <full-sha>   (required)
      pr review <pane> <number> --approve|--request-changes|--comment
          [--body B | --body-file PATH|-]
          [--comments-file PATH|-]   (JSON array: path/line/side/body)
      pr comment <pane> <number> --body B|--body-file PATH|-
      pr reply <pane> <number> <comment-id> --body B|--body-file PATH|-
      pr reviewers <pane> <number>
          [--add-reviewer LOGIN[,LOGIN]...] [--remove-reviewer LOGIN...]
      --expect-head is the stale-head guard: pass head.sha from a prior
      pr read; the mutation is refused (kind "stale_head") if the PR head
      moved. Merge/auto-merge are intentionally not exposed.
  git issue list|view|create|edit|comment|close <pane_id> [args]
      [--repo owner/name]
      issue list: [--limit N] [--state open|closed|all]
          [--label L]... [--assignee U]... [--author U]
      issue view <pane> <number>
      issue create <pane> --title T [--body B | --body-file PATH|-]
          [--label L]... [--assignee U]...
      issue edit <pane> <number> [--title T] [--body B|--body-file PATH|-]
          [--add-label L]... [--remove-label L]...
          [--add-assignee U]... [--remove-assignee U]...
          [--state open|closed]
      issue comment <pane> <number> --body B|--body-file PATH|-
      issue close <pane> <number> [--reason completed|"not planned"]
      (no --expect-head: issues have no head sha; mutations are gated by
      target resolution + explicit invocation only)
  git issue link <pane_id> <owner>/<repo>#<n> [--verify]
  git issue unlink <pane_id> <owner>/<repo>#<n>
  git issue links <pane_id>
      Pane↔issue links are stored by rebuildup.inbox (delegated via its
      public CLI); requires the inbox plugin installed/resolvable.
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
    case "pr":
      return cmdPr(options);
    case "issue":
      return cmdIssue(options);
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
    if (err instanceof TargetResolutionError) {
      process.stderr.write(
        `${JSON.stringify({
          contract: CONTRACT,
          ok: false,
          error: { code: err.code, message: err.message },
        })}\n`,
      );
      process.exit(err.usage ? 2 : 1);
    }
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
