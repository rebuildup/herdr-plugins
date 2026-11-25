/**
 * rebuildup.checkpoints CLI — hidden-ref checkpoint contract
 * (`herdr-plugins.checkpoints/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * Repo targeting: `create`/`list --repo` accept `--repo PATH`; `create`
 * otherwise resolves a pane (positional arg, HERDR_PANE_ID, or
 * HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id) through the herdr session
 * snapshot — the same path rebuildup.git uses.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { type BoundedResult, GitError, resolveRepo } from "../../../packages/git-core/src/index";
import {
  type CallOptions,
  type PaneInfo,
  pluginDirs,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import {
  CheckpointError,
  canonicalRepoRoot,
  captureCheckpoint,
  deleteRef,
  diffRevs,
  type ResolvedRepo,
  resolveCheckpointRepo,
  showCommit,
  verifyRef,
} from "./capture";
import { type CheckpointEntry, loadState, PLUGIN_ID, updateState } from "./state";

const CONTRACT = "herdr-plugins.checkpoints/v1";
const PLUGIN_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DIFF_MAX_BYTES = 256 * 1024;
const DEFAULT_SHOW_MAX_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

interface PluginConfig {
  timeoutMs?: number | undefined;
  diffMaxBytes?: number | undefined;
  showMaxBytes?: number | undefined;
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

async function loadConfig(): Promise<PluginConfig> {
  const file = path.join(pluginDirs(PLUGIN_ID).configDir, "config.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as PluginConfig;
    return {
      timeoutMs:
        typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0 ? parsed.timeoutMs : undefined,
      diffMaxBytes:
        typeof parsed.diffMaxBytes === "number" && parsed.diffMaxBytes > 0
          ? parsed.diffMaxBytes
          : undefined,
      showMaxBytes:
        typeof parsed.showMaxBytes === "number" && parsed.showMaxBytes > 0
          ? parsed.showMaxBytes
          : undefined,
    };
  } catch {
    return {};
  }
}

function effectiveTimeoutMs(options: CliOptions, config: PluginConfig): number {
  return options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function diffMaxBytesArg(args: string[]): number | undefined {
  const raw = flagValue(args, "--max-bytes");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`invalid --max-bytes: ${raw}`, 2);
  return value;
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

function gitFail(err: unknown): never {
  if (err instanceof GitError) fail(err.message, 1, err.kind);
  if (err instanceof CheckpointError) fail(err.message, 1, err.kind);
  throw err;
}

/**
 * Resolve the target repo for `create`: explicit `--repo PATH` wins and
 * never touches the herdr session; otherwise a pane id (positional,
 * HERDR_PANE_ID, or plugin context) resolves through the session
 * snapshot exactly like rebuildup.git.
 */
async function resolveCreateRepo(
  options: CliOptions,
  config: PluginConfig,
): Promise<{ resolved: ResolvedRepo; paneId: string | null }> {
  const valueFlags = ["--repo", "--label"];
  const repoFlag = flagValue(options.args, "--repo");
  if (repoFlag !== undefined) {
    if (repoFlag.startsWith("-")) fail("invalid --repo value", 2);
    if (positionals(options.args, valueFlags).length > 0) {
      fail("--repo and a pane id are mutually exclusive", 2);
    }
    try {
      const resolved = await resolveCheckpointRepo(repoFlag, {
        timeoutMs: effectiveTimeoutMs(options, config),
      });
      return { resolved, paneId: null };
    } catch (err) {
      gitFail(err);
    }
  }

  const explicit =
    positionals(options.args, valueFlags)[0] ??
    process.env.HERDR_PANE_ID ??
    invocationContext().focused_pane_id;
  if (!explicit) {
    fail("repo target required: pass --repo PATH or a pane id (HERDR_PANE_ID/context)", 2);
  }
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, explicit);
  const cwd = paneCwd(pane);
  try {
    const resolved = await resolveCheckpointRepo(cwd, {
      timeoutMs: effectiveTimeoutMs(options, config),
    });
    return { resolved, paneId: explicit };
  } catch (err) {
    gitFail(err);
  }
}

async function cmdCreate(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const { resolved, paneId } = await resolveCreateRepo(options, config);

  const labelFlag = flagValue(options.args, "--label");
  if (labelFlag?.startsWith("-")) {
    fail("invalid --label value", 2);
  }

  let entry: CheckpointEntry;
  try {
    entry = await captureCheckpoint(resolved, {
      timeoutMs: effectiveTimeoutMs(options, config),
      label: labelFlag,
    });
  } catch (err) {
    gitFail(err);
  }

  await updateState((state) => {
    state.checkpoints[entry.id] = entry;
  });

  const warnings: string[] = [];
  if (entry.submodules && entry.submodules.length > 0) {
    warnings.push(
      `submodule gitlinks recorded (${entry.submodules.length}); submodule worktree changes are not captured`,
    );
  }
  emit({
    contract: CONTRACT,
    command: "create",
    ok: true,
    pane_id: paneId,
    repo_root: resolved.root,
    checkpoint: entry,
    warnings,
    generated_at: new Date().toISOString(),
  });
}

function sortEntries(entries: CheckpointEntry[]): CheckpointEntry[] {
  return [...entries].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function cmdList(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const valueFlags = ["--repo", "--limit"];
  const pos = positionals(options.args, valueFlags);
  if (pos.length > 0) fail("list takes no positional arguments", 2);

  let repoRoot: string | null = null;
  const repoFlag = flagValue(options.args, "--repo");
  if (repoFlag !== undefined) {
    if (repoFlag.startsWith("-")) fail("invalid --repo value", 2);
    try {
      repoRoot = await canonicalRepoRoot(
        (await resolveRepo(repoFlag, { timeoutMs: effectiveTimeoutMs(options, config) })).root,
      );
    } catch (err) {
      gitFail(err);
    }
  }

  const limitRaw = flagValue(options.args, "--limit");
  let limit = DEFAULT_LIST_LIMIT;
  if (limitRaw !== undefined) {
    const value = Number(limitRaw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
      fail(`invalid --limit: ${limitRaw}`, 2);
    }
    limit = value;
  }

  const state = await loadState();
  let entries = Object.values(state.checkpoints);
  if (repoRoot !== null) {
    entries = entries.filter((e) => e.repo_root === repoRoot);
  }
  const sorted = sortEntries(entries);
  const page = sorted.slice(0, limit);
  emit({
    contract: CONTRACT,
    command: "list",
    repo_root: repoRoot,
    count: page.length,
    total: sorted.length,
    truncated: sorted.length > page.length,
    checkpoints: page,
    generated_at: new Date().toISOString(),
  });
}

async function lookupEntry(id: string): Promise<CheckpointEntry> {
  const state = await loadState();
  const entry = state.checkpoints[id];
  if (!entry) {
    throw new CheckpointError("unknown_checkpoint", `no checkpoint with id: ${id}`);
  }
  return entry;
}

async function cmdShow(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const pos = positionals(options.args, ["--max-bytes"]);
  if (pos.length !== 1) fail("show requires exactly one checkpoint id", 2);
  const id = pos[0] as string;
  if (id.startsWith("-")) fail(`invalid checkpoint id: ${id}`, 2);

  const entry = await lookupEntry(id).catch(gitFail);

  // The repo may be gone or moved; that is reported, never hidden.
  let repoRoot: string;
  try {
    repoRoot = (
      await resolveRepo(entry.repo_root, { timeoutMs: effectiveTimeoutMs(options, config) })
    ).root;
  } catch (err) {
    gitFail(err);
  }

  const timeoutMs = effectiveTimeoutMs(options, config);
  const refOid = await verifyRef(repoRoot, entry.ref, { timeoutMs });
  const maxBytes = diffMaxBytesArg(options.args) ?? config.showMaxBytes ?? DEFAULT_SHOW_MAX_BYTES;

  let summary: BoundedResult | null = null;
  let summaryError: string | null = null;
  try {
    summary = await showCommit(repoRoot, entry.commit, { timeoutMs, maxBytes });
  } catch (err) {
    if (err instanceof GitError) {
      summaryError = err.message;
    } else {
      throw err;
    }
  }

  emit({
    contract: CONTRACT,
    command: "show",
    checkpoint: entry,
    repo_root: repoRoot,
    ref: { name: entry.ref, exists: refOid !== null, oid: refOid },
    summary:
      summary === null
        ? null
        : { output: summary.stdout, truncated: summary.truncated, bytes: summary.bytes },
    summary_error: summaryError,
    generated_at: new Date().toISOString(),
  });
}

type DiffSide = { kind: "head" } | { kind: "checkpoint"; id: string; entry: CheckpointEntry };

function parseDiffSide(
  arg: string,
  state: { checkpoints: Record<string, CheckpointEntry> },
): DiffSide {
  if (arg === "HEAD") return { kind: "head" };
  if (arg.startsWith("-")) fail(`invalid diff side (option-like rejected): ${arg}`, 2);
  const entry = state.checkpoints[arg];
  if (!entry) {
    throw new CheckpointError("unknown_checkpoint", `no checkpoint with id: ${arg}`);
  }
  return { kind: "checkpoint", id: arg, entry };
}

async function cmdDiff(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const valueFlags = ["--max-bytes"];
  const pos = positionals(options.args, valueFlags);
  if (pos.length !== 2) {
    fail("diff requires exactly two sides: <checkpoint-id|HEAD> <checkpoint-id|HEAD>", 2);
  }
  const [argA, argB] = pos as [string, string];

  const state = await loadState();
  let sideA: DiffSide;
  let sideB: DiffSide;
  try {
    sideA = parseDiffSide(argA, state);
    sideB = parseDiffSide(argB, state);
  } catch (err) {
    gitFail(err);
  }
  if (sideA.kind === "head" && sideB.kind === "head") {
    fail("diff requires at least one checkpoint id (HEAD vs HEAD is meaningless)", 2);
  }

  // Both checkpoint sides must live in the same repository; a HEAD side
  // adopts the other side's repo.
  const checkpointSides = [sideA, sideB].filter(
    (s): s is Extract<DiffSide, { kind: "checkpoint" }> => s.kind === "checkpoint",
  );
  const first = checkpointSides[0];
  if (first === undefined) {
    fail("diff requires at least one checkpoint id", 2);
  }
  const repoRoot = first.entry.repo_root;
  for (const side of checkpointSides) {
    if (side.entry.repo_root !== repoRoot) {
      fail(`diff sides belong to different repositories: ${argA} vs ${argB}`, 1, "cross_repo");
    }
  }

  const timeoutMs = effectiveTimeoutMs(options, config);
  let repoRootResolved: string;
  try {
    repoRootResolved = (await resolveRepo(repoRoot, { timeoutMs })).root;
  } catch (err) {
    gitFail(err);
  }

  const revOf = (side: DiffSide): string => (side.kind === "head" ? "HEAD" : side.entry.ref);
  const maxBytes = diffMaxBytesArg(options.args) ?? config.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES;

  const result = await diffRevs(repoRootResolved, revOf(sideA), revOf(sideB), {
    timeoutMs,
    maxBytes,
  }).catch(gitFail);

  const describe = (side: DiffSide) =>
    side.kind === "head"
      ? { kind: "head" as const, rev: "HEAD" }
      : {
          kind: "checkpoint" as const,
          id: side.id,
          rev: side.entry.ref,
          commit: side.entry.commit,
        };

  emit({
    contract: CONTRACT,
    command: "diff",
    repo_root: repoRootResolved,
    a: describe(sideA),
    b: describe(sideB),
    patch: result.stdout,
    truncated: result.truncated,
    bytes: result.bytes,
    generated_at: new Date().toISOString(),
  });
}

async function cmdDelete(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const pos = positionals(options.args, []);
  if (pos.length !== 1) fail("delete requires exactly one checkpoint id", 2);
  const id = pos[0] as string;
  if (id.startsWith("-")) fail(`invalid checkpoint id: ${id}`, 2);

  const entry = await lookupEntry(id).catch(gitFail);
  const timeoutMs = effectiveTimeoutMs(options, config);

  // Ref deletion is best-effort against the live repo: when the repo is
  // gone the state record is still removed (it is the only index left)
  // and the payload reports ref_existed:false plus a warning.
  const warnings: string[] = [];
  let refExisted = false;
  try {
    const resolved = await resolveRepo(entry.repo_root, { timeoutMs });
    refExisted = await deleteRef(resolved.root, entry.ref, { timeoutMs });
  } catch (err) {
    if (err instanceof GitError || err instanceof CheckpointError) {
      warnings.push(`ref deletion skipped: ${err.message}`);
    } else {
      throw err;
    }
  }

  await updateState((state) => {
    delete state.checkpoints[id];
  });

  emit({
    contract: CONTRACT,
    command: "delete",
    ok: true,
    id,
    ref: entry.ref,
    ref_existed: refExisted,
    warnings,
    generated_at: new Date().toISOString(),
  });
}

async function cmdCapability(): Promise<void> {
  const config = await loadConfig();
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    commands: ["capability", "create", "list", "show", "diff", "delete"],
    read_only: false,
    mutation_commands: ["create", "delete"],
    requires: { git: true, bun: true },
    defaults: {
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      diffMaxBytes: config.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES,
      showMaxBytes: config.showMaxBytes ?? DEFAULT_SHOW_MAX_BYTES,
      listLimit: DEFAULT_LIST_LIMIT,
    },
  });
}

const USAGE = `rebuildup.checkpoints — hidden-ref worktree checkpoints (contract ${CONTRACT})

Usage:
  checkpoints create [--repo PATH | <pane_id>] [--label TEXT]
      [--session NAME] [--timeout MS]
  checkpoints list [--repo PATH] [--limit N]
  checkpoints show <checkpoint-id> [--max-bytes N]
  checkpoints diff <checkpoint-id|HEAD> <checkpoint-id|HEAD> [--max-bytes N]
  checkpoints delete <checkpoint-id>
  checkpoints capability

Checkpoints are synthetic commits under
refs/herdr-plugins/checkpoints/<repo-key>/<id>; capture never touches the
user's index or staging area. See docs/contracts/checkpoints-v1.md.
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "create":
      return cmdCreate(options);
    case "list":
      return cmdList(options);
    case "show":
      return cmdShow(options);
    case "diff":
      return cmdDiff(options);
    case "delete":
      return cmdDelete(options);
    case "capability":
      return cmdCapability();
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
