/**
 * rebuildup.checkpoints CLI — hidden-ref checkpoint contract
 * (`herdr-plugins.checkpoints/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * Repo targeting: `create`/`list --repo` accept `--repo PATH`; `create`
 * otherwise resolves a pane (positional arg, HERDR_PANE_ID, or
 * HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id) through the herdr session
 * snapshot — the same path rebuildup.git uses. `plan`/`restore` default
 * to the checkpoint's recorded repo; `--repo PATH` may select another
 * worktree of the same repository (shared git common dir).
 *
 * `restore` always captures a `pre-restore` checkpoint first, refuses
 * shared worktrees (>=2 live panes under the repo root) and unreachable
 * sessions unless `--force`, then runs `git restore --source --worktree
 * --staged` + bounded `git clean -fd` + post-verify (see restore.ts).
 */

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type BoundedResult,
  GitError,
  gitOk,
  resolveRepo,
} from "../../../packages/git-core/src/index";
import {
  type CallOptions,
  type PaneInfo,
  pluginDirs,
  reportPaneMetadata,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import type { AutoCaptureReport } from "./auto";
import { drainPendingCaptures } from "./auto";
import {
  CheckpointError,
  canonicalRepoRoot,
  captureCheckpoint,
  deleteRef,
  diffRevs,
  listCheckpointRefs,
  newGroupId,
  type ResolvedRepo,
  resolveCheckpointRepo,
  showCommit,
  verifyRef,
} from "./capture";
import { panesSharingRepo, planRestore, restoreWorktree } from "./restore";
import { type CheckpointEntry, loadState, PLUGIN_ID, sessionKeyFor, updateState } from "./state";

const CONTRACT = "herdr-plugins.checkpoints/v1";
const PLUGIN_VERSION = "0.4.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DIFF_MAX_BYTES = 256 * 1024;
const DEFAULT_SHOW_MAX_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_GC_MAX_COUNT = 50;
const DEFAULT_GC_MAX_AGE_DAYS = 30;
const DEFAULT_PRE_RESTORE_PROTECT_DAYS = 7;
const DAY_MS = 86_400_000;

interface PluginConfig {
  timeoutMs?: number | undefined;
  diffMaxBytes?: number | undefined;
  showMaxBytes?: number | undefined;
  gcMaxCount?: number | undefined;
  gcMaxAgeDays?: number | undefined;
  preRestoreProtectDays?: number | undefined;
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

/**
 * Lazy auto-capture drain report for the current invocation, merged
 * into the emitted payload as `auto_captures` when non-empty. Set by
 * `drainAuto` at the top of every state-touching command; `capability`
 * and `help` never drain.
 */
let autoReport: AutoCaptureReport | null = null;

function emit(payload: unknown): void {
  const body =
    autoReport !== null &&
    (autoReport.captured.length > 0 ||
      autoReport.skipped.length > 0 ||
      autoReport.session_unreachable === true)
      ? { ...(payload as Record<string, unknown>), auto_captures: autoReport }
      : payload;
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Drain capture-pending marks left by the agent-status event hook.
 * Best-effort by contract: an unreachable session or per-pane capture
 * failure never fails the command — outcomes land in `auto_captures`.
 */
async function drainAuto(options: CliOptions, config: PluginConfig): Promise<void> {
  autoReport = await drainPendingCaptures(options, effectiveTimeoutMs(options, config));
}

function emitError(
  message: string,
  code: number,
  kind?: string,
  extra?: Record<string, unknown>,
): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind) error.kind = kind;
  if (extra) Object.assign(error, extra);
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function fail(message: string, code = 1, kind?: string, extra?: Record<string, unknown>): never {
  emitError(message, code, kind, extra);
}

/**
 * Exit-1 tail for gc/prune when NO repo could be evaluated (every
 * wanted repo unreachable). The stdout payload already reports
 * ok:false; this mirrors the save/restore-group partial-failure
 * convention of a structured stderr error + non-zero exit.
 */
function failUnreachable(
  command: string,
  unreachable: Array<{ repo_root: string; kind: string; message: string }>,
): void {
  const detail = unreachable
    .map((u) => `${u.repo_root} (${u.kind}: ${u.message})`)
    .join("; ");
  process.stderr.write(
    `${JSON.stringify({
      contract: CONTRACT,
      ok: false,
      error: {
        code: "error",
        message: `${command}: no repository could be evaluated — ${detail}`,
        kind: "unreachable_repos",
      },
    })}\n`,
  );
  process.exitCode = 1;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

/** All values of a repeatable flag (`--repo` may appear several times). */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (value === undefined) continue;
    out.push(value);
    i += 1;
  }
  return out;
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
      gcMaxCount:
        typeof parsed.gcMaxCount === "number" && parsed.gcMaxCount > 0
          ? parsed.gcMaxCount
          : undefined,
      gcMaxAgeDays:
        typeof parsed.gcMaxAgeDays === "number" && parsed.gcMaxAgeDays > 0
          ? parsed.gcMaxAgeDays
          : undefined,
      preRestoreProtectDays:
        typeof parsed.preRestoreProtectDays === "number" && parsed.preRestoreProtectDays > 0
          ? parsed.preRestoreProtectDays
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
  // `--auto` marks the entry as plugin/agent-initiated rather than an
  // explicit user `create` — same `kind` namespace the lazy work-unit
  // drain uses.
  const autoKind = options.args.includes("--auto");

  // An explicit create supersedes any pending auto-capture for the same
  // pane: capturing twice would record two identical work units.
  if (paneId !== null) {
    const sessionKey = sessionKeyFor(options);
    await updateState((state) => {
      const paneState = state.auto?.[sessionKey]?.[paneId];
      if (paneState?.pending !== undefined) delete paneState.pending;
    });
  }
  await drainAuto(options, config);

  let entry: CheckpointEntry;
  try {
    entry = await captureCheckpoint(resolved, {
      timeoutMs: effectiveTimeoutMs(options, config),
      label: labelFlag,
      kind: autoKind ? "auto" : "manual",
    });
  } catch (err) {
    gitFail(err);
  }

  const checkpointCount = await updateState((state) => {
    state.checkpoints[entry.id] = entry;
    let count = 0;
    for (const other of Object.values(state.checkpoints)) {
      if (other.repo_root === resolved.root) count += 1;
    }
    return count;
  });

  // Project display-only metadata tokens for pane-targeted creates.
  if (paneId !== null) {
    try {
      await reportPaneMetadata(
        paneId,
        {
          checkpoint_latest: entry.id,
          checkpoint_count: String(checkpointCount),
        },
        { ...options, source: PLUGIN_ID },
      );
    } catch {
      // Display-only projection; never fail the capture for it.
    }
  }

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
  await drainAuto(options, config);
  const valueFlags = ["--repo", "--limit", "--group"];
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
  const groupFlag = flagValue(options.args, "--group");
  if (groupFlag !== undefined) {
    if (groupFlag.startsWith("-")) fail("invalid --group value", 2);
    entries = entries.filter((e) => e.group_id === groupFlag);
  }
  const sorted = sortEntries(entries);
  const page = sorted.slice(0, limit);
  emit({
    contract: CONTRACT,
    command: "list",
    repo_root: repoRoot,
    group: groupFlag ?? null,
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
  await drainAuto(options, config);
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
  await drainAuto(options, config);
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
  await drainAuto(options, config);
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

/**
 * Resolve which worktree `plan`/`restore` operate on. Default is the
 * checkpoint's recorded `repo_root`; `--repo PATH` may select another
 * worktree of the SAME repository (shared git common dir / object
 * store), which is the only cross-checkout case checkpoint commits can
 * meaningfully restore into. Anything else is `repo_mismatch`.
 */
async function resolveTargetRepo(
  options: CliOptions,
  entry: CheckpointEntry,
  config: PluginConfig,
  repoFlag: string | undefined,
): Promise<ResolvedRepo> {
  const timeoutMs = effectiveTimeoutMs(options, config);
  if (repoFlag === undefined) {
    return resolveCheckpointRepo(entry.repo_root, { timeoutMs });
  }
  if (repoFlag.startsWith("-")) fail("invalid --repo value", 2);
  const resolved = await resolveCheckpointRepo(repoFlag, { timeoutMs });
  const entryRepo = await resolveRepo(entry.repo_root, { timeoutMs });
  const [targetCommon, entryCommon] = await Promise.all([
    realpath(resolved.info.gitCommonDir),
    realpath(entryRepo.gitCommonDir),
  ]);
  if (targetCommon !== entryCommon) {
    throw new CheckpointError(
      "repo_mismatch",
      `--repo ${repoFlag} belongs to a different repository than checkpoint ${entry.id} ` +
        `(git common dir ${targetCommon} != ${entryCommon})`,
    );
  }
  return resolved;
}

function checkpointIdArg(options: CliOptions, command: string): string {
  const pos = positionals(options.args, ["--repo"]);
  if (pos.length !== 1) fail(`${command} requires exactly one checkpoint id`, 2);
  const id = pos[0] as string;
  if (id.startsWith("-")) fail(`invalid checkpoint id: ${id}`, 2);
  return id;
}

async function cmdPlan(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  await drainAuto(options, config);
  const id = checkpointIdArg(options, "plan");
  const entry = await lookupEntry(id).catch(gitFail);
  const resolved = await resolveTargetRepo(
    options,
    entry,
    config,
    flagValue(options.args, "--repo"),
  ).catch(gitFail);
  const timeoutMs = effectiveTimeoutMs(options, config);

  // Plan against the live ref when it exists, else the recorded commit —
  // plan is advisory and never mutates, so a missing ref is a warning.
  const warnings: string[] = [];
  const refOid = await verifyRef(resolved.root, entry.ref, { timeoutMs });
  const commit = refOid ?? entry.commit;
  if (refOid === null) {
    warnings.push(`checkpoint ref ${entry.ref} is missing; planning against recorded commit`);
  }
  if (entry.submodules && entry.submodules.length > 0) {
    warnings.push(
      `checkpoint recorded ${entry.submodules.length} submodule gitlink(s); ` +
        `restore covers the root repo only, submodule worktrees are not restored`,
    );
  }

  const plan = await planRestore(resolved.root, commit, { timeoutMs }).catch(gitFail);

  emit({
    contract: CONTRACT,
    command: "plan",
    checkpoint: entry,
    repo_root: resolved.root,
    commit,
    ref: { name: entry.ref, exists: refOid !== null, oid: refOid },
    plan,
    warnings,
    generated_at: new Date().toISOString(),
  });
}

/**
 * Shared-worktree isolation for `restore`: count live panes whose cwd is
 * the target root or nested under it. Two or more sharing panes means
 * another agent/user could be mid-edit — refuse unless `--force`.
 * An unreachable session cannot prove isolation, so it refuses too
 * (safer default; documented in the contract).
 */
async function assertRestoreIsolation(
  options: CliOptions,
  repoRoot: string,
  force: boolean,
): Promise<{ mode: "isolated" | "forced" | "single_pane" | "no_panes"; sharing: string[] }> {
  if (force) return { mode: "forced", sharing: [] };
  const callOptions: CallOptions = { session: options.session, socketPath: options.socketPath };
  if (options.timeoutMs !== undefined) callOptions.timeoutMs = options.timeoutMs;
  let snapshot: SessionSnapshot;
  try {
    snapshot = await sessionSnapshot(callOptions);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CheckpointError(
      "session_unreachable",
      `cannot verify worktree isolation: herdr session unreachable (${detail}). ` +
        `Pass --force to restore anyway.`,
    );
  }
  const sharing = await panesSharingRepo(snapshot.panes ?? [], repoRoot);
  if (sharing.length >= 2) {
    throw new CheckpointError(
      "shared_worktree",
      `refusing to restore: ${sharing.length} live panes share worktree ${repoRoot} ` +
        `(${sharing.join(", ")}). Restore would race their edits; pass --force to override.`,
      { panes: sharing },
    );
  }
  return { mode: sharing.length === 1 ? "single_pane" : "no_panes", sharing };
}

interface PreRestoreRef {
  id: string;
  ref: string;
  commit: string;
  label: string | null;
}

function preRestoreRef(entry: CheckpointEntry): PreRestoreRef {
  return {
    id: entry.id,
    ref: entry.ref,
    commit: entry.commit,
    label: entry.label ?? null,
  };
}

interface RestoreAttemptOk {
  ok: true;
  id: string;
  repo_root: string;
  entry: CheckpointEntry;
  restored_commit: string;
  pre_restore: PreRestoreRef;
  isolation: "isolated" | "forced" | "single_pane" | "no_panes";
  sharing_panes: string[];
  clean_passes: number;
  warnings: string[];
}

interface RestoreAttemptFail {
  ok: false;
  id: string;
  repo_root: string;
  kind: string;
  message: string;
  extra: Record<string, unknown> | undefined;
  pre_restore: PreRestoreRef | null;
}

type RestoreAttempt = RestoreAttemptOk | RestoreAttemptFail;

function attemptFail(
  entry: CheckpointEntry,
  repoRoot: string,
  err: GitError | CheckpointError,
  preEntry: CheckpointEntry | null,
): RestoreAttemptFail {
  const extra = err instanceof CheckpointError ? err.extra : undefined;
  let message = err.message;
  if (preEntry !== null) {
    message =
      `${err.message} — the worktree may be partially restored; ` +
      `pre-restore checkpoint ${preEntry.id} preserves the previous state ` +
      `(restore it with: checkpoints restore ${preEntry.id})`;
  }
  return {
    ok: false,
    id: entry.id,
    repo_root: repoRoot,
    kind: err.kind,
    message,
    extra,
    pre_restore: preEntry === null ? null : preRestoreRef(preEntry),
  };
}

/**
 * Run the full restore pipeline for one checkpoint entry. Never exits
 * the process: every handled failure is returned as
 * {@link RestoreAttemptFail} so `restore-group` can continue with the
 * remaining repos and report per-repo status honestly.
 * `repoFlag` is the explicit `--repo` override (`undefined` for group
 * members, which always restore into their recorded repo).
 */
async function attemptRestore(
  options: CliOptions,
  entry: CheckpointEntry,
  config: PluginConfig,
  force: boolean,
  repoFlag: string | undefined,
): Promise<RestoreAttempt> {
  const timeoutMs = effectiveTimeoutMs(options, config);
  let resolved: ResolvedRepo;
  try {
    resolved = await resolveTargetRepo(options, entry, config, repoFlag);
  } catch (err) {
    if (err instanceof GitError || err instanceof CheckpointError) {
      return attemptFail(entry, entry.repo_root, err, null);
    }
    throw err;
  }

  let preEntry: CheckpointEntry | null = null;
  try {
    const refOid = await verifyRef(resolved.root, entry.ref, { timeoutMs });
    if (refOid === null) {
      throw new CheckpointError(
        "checkpoint_ref_missing",
        `checkpoint ref no longer exists: ${entry.ref} (state entry is stale; ` +
          `the objects may have been gc'd). Nothing was restored.`,
      );
    }
    const warnings: string[] = [];
    if (refOid !== entry.commit) {
      warnings.push(
        `checkpoint ref moved since capture (recorded ${entry.commit.slice(0, 12)}, ` +
          `now ${refOid.slice(0, 12)}); restoring the ref's current target`,
      );
    }

    const isolation = await assertRestoreIsolation(options, resolved.root, force);
    if (isolation.mode === "forced") {
      warnings.push("restore forced: shared-worktree isolation check bypassed via --force");
    }

    // Mandatory pre-restore checkpoint: persisted BEFORE any mutation so
    // a mid-restore failure always leaves a recoverable ref. If capture
    // fails the restore is refused — nothing has been touched yet.
    const capturedPre = await captureCheckpoint(resolved, {
      timeoutMs,
      label: `pre-restore:${entry.id}`,
      kind: "pre_restore",
    });
    preEntry = capturedPre;
    await updateState((state) => {
      state.checkpoints[capturedPre.id] = capturedPre;
    });

    const result = await restoreWorktree(resolved.root, refOid, { timeoutMs });

    if (entry.submodules && entry.submodules.length > 0) {
      warnings.push(
        `checkpoint recorded ${entry.submodules.length} submodule gitlink(s); ` +
          `v1 restores the root repo only — submodule worktrees were not restored`,
      );
    }

    return {
      ok: true,
      id: entry.id,
      repo_root: resolved.root,
      entry,
      restored_commit: refOid,
      pre_restore: preRestoreRef(preEntry),
      isolation: isolation.mode,
      sharing_panes: isolation.sharing,
      clean_passes: result.clean_passes,
      warnings,
    };
  } catch (err) {
    if (err instanceof GitError || err instanceof CheckpointError) {
      return attemptFail(entry, resolved.root, err, preEntry);
    }
    throw err;
  }
}

async function cmdRestore(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  await drainAuto(options, config);
  const force = options.args.includes("--force");
  const id = checkpointIdArg(options, "restore");
  const entry = await lookupEntry(id).catch(gitFail);

  const attempt = await attemptRestore(
    options,
    entry,
    config,
    force,
    flagValue(options.args, "--repo"),
  );
  if (!attempt.ok) {
    const extra: Record<string, unknown> = { ...(attempt.extra ?? {}) };
    if (attempt.pre_restore !== null) {
      extra.pre_restore_checkpoint_id = attempt.pre_restore.id;
      extra.pre_restore_ref = attempt.pre_restore.ref;
      extra.pre_restore_commit = attempt.pre_restore.commit;
    }
    fail(attempt.message, 1, attempt.kind, extra);
  }

  emit({
    contract: CONTRACT,
    command: "restore",
    ok: true,
    checkpoint: attempt.entry,
    repo_root: attempt.repo_root,
    restored_commit: attempt.restored_commit,
    pre_restore: attempt.pre_restore,
    isolation: attempt.isolation,
    sharing_panes: attempt.sharing_panes,
    clean_passes: attempt.clean_passes,
    warnings: attempt.warnings,
    generated_at: new Date().toISOString(),
  });
}

/**
 * `restore-group <group-id>`: restore every checkpoint captured by one
 * `save` call, one repo at a time. Per-repo status is always reported
 * individually; a partial restore is `ok:false` + exit 1 — never
 * dressed up as a full success. Each member gets its own mandatory
 * pre-restore checkpoint and isolation check.
 */
async function cmdRestoreGroup(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  await drainAuto(options, config);
  if (flagValue(options.args, "--repo") !== undefined) {
    fail("restore-group does not accept --repo; members restore into their recorded repos", 2);
  }
  const pos = positionals(options.args, ["--repo"]);
  if (pos.length !== 1) fail("restore-group requires exactly one group id", 2);
  const groupId = pos[0] as string;
  if (groupId.startsWith("-")) fail(`invalid group id: ${groupId}`, 2);

  const state = await loadState();
  const members = Object.values(state.checkpoints)
    .filter((entry) => entry.group_id === groupId)
    .sort((a, b) =>
      a.repo_root === b.repo_root
        ? a.id.localeCompare(b.id)
        : a.repo_root.localeCompare(b.repo_root),
    );
  if (members.length === 0) {
    gitFail(new CheckpointError("unknown_group", `no checkpoint group with id: ${groupId}`));
  }

  const force = options.args.includes("--force");
  const results: Array<Record<string, unknown>> = [];
  for (const entry of members) {
    const attempt = await attemptRestore(options, entry, config, force, undefined);
    if (attempt.ok) {
      results.push({
        id: attempt.id,
        repo_root: attempt.repo_root,
        ok: true,
        checkpoint: attempt.entry,
        restored_commit: attempt.restored_commit,
        pre_restore: attempt.pre_restore,
        isolation: attempt.isolation,
        sharing_panes: attempt.sharing_panes,
        clean_passes: attempt.clean_passes,
        warnings: attempt.warnings,
      });
    } else {
      results.push({
        id: attempt.id,
        repo_root: attempt.repo_root,
        ok: false,
        error: {
          kind: attempt.kind,
          message: attempt.message,
          ...(attempt.extra ?? {}),
        },
        ...(attempt.pre_restore !== null ? { pre_restore: attempt.pre_restore } : {}),
      });
    }
  }

  const failures = results.filter((r) => r.ok !== true);
  emit({
    contract: CONTRACT,
    command: "restore-group",
    ok: failures.length === 0,
    group: groupId,
    total: results.length,
    succeeded: results.length - failures.length,
    failed: failures.length,
    results,
    generated_at: new Date().toISOString(),
  });
  if (failures.length > 0) {
    const failedIds = failures.map((r) => String(r.id)).join(", ");
    process.stderr.write(
      `${JSON.stringify({
        contract: CONTRACT,
        ok: false,
        error: {
          code: "error",
          message:
            `restore-group ${groupId}: ${failures.length} of ${results.length} ` +
            `repos failed (${failedIds}); succeeded repos were still restored`,
          kind: "partial_restore",
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}

// --- Multi-repo save -------------------------------------------------------

interface SaveRepoOk {
  ok: true;
  repo_root: string;
  checkpoint: CheckpointEntry;
}

interface SaveRepoFail {
  ok: false;
  repo_root: string;
  error: { kind: string; message: string };
}

type SaveRepoResult = SaveRepoOk | SaveRepoFail;

function saveErrorKind(err: unknown): { kind: string; message: string } {
  if (err instanceof GitError || err instanceof CheckpointError) {
    return { kind: err.kind, message: err.message };
  }
  throw err;
}

/**
 * `save` — multi-repo checkpoint group (#75). Captures one checkpoint
 * per repo under a shared `group_id`; `restore-group <id>` restores
 * them together. Repo set resolution, in priority order:
 *
 * 1. repeated `--repo PATH` flags — explicit enumeration;
 * 2. a pane id (`--pane`, positional, HERDR_PANE_ID, plugin context)
 *    — that pane's repo only, same resolution as `create`;
 * 3. otherwise live discovery: every distinct repo resolved from the
 *    session snapshot's pane cwds (no cross-plugin state dependency).
 *
 * Per-repo capture failures are reported individually; `ok` is true
 * only when every repo captured.
 */
async function cmdSave(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  await drainAuto(options, config);
  const timeoutMs = effectiveTimeoutMs(options, config);

  const valueFlags = ["--repo", "--label", "--pane"];
  const repoFlags = flagValues(options.args, "--repo");
  const paneFlag = flagValue(options.args, "--pane");
  const pos = positionals(options.args, valueFlags);
  if (pos.length > 1) fail("save takes at most one pane id", 2);
  const explicitPane =
    paneFlag ?? pos[0] ?? process.env.HERDR_PANE_ID ?? invocationContext().focused_pane_id;
  if (repoFlags.length > 0 && explicitPane !== undefined) {
    fail("--repo and a pane id are mutually exclusive", 2);
  }
  for (const value of [...repoFlags, ...(paneFlag === undefined ? [] : [paneFlag])]) {
    if (value.startsWith("-")) fail("invalid flag value", 2);
  }

  const labelFlag = flagValue(options.args, "--label");
  if (labelFlag?.startsWith("-")) fail("invalid --label value", 2);

  // Phase 1: resolve the repo set. Explicit --repo paths and discovered
  // pane repos are captured best-effort per repo; a pane-targeted save
  // fails hard on resolution errors (same contract as `create`).
  const resolvedRepos: ResolvedRepo[] = [];
  const failedRepos: Array<{ repo_root: string; kind: string; message: string }> = [];
  const skippedPanes: Array<{ pane_id: string; reason: string }> = [];

  if (repoFlags.length > 0) {
    for (const repoPath of repoFlags) {
      try {
        resolvedRepos.push(await resolveCheckpointRepo(repoPath, { timeoutMs }));
      } catch (err) {
        failedRepos.push({ repo_root: repoPath, ...saveErrorKind(err) });
      }
    }
  } else if (explicitPane !== undefined) {
    const snapshot = await sessionSnapshot(options);
    const pane = await findPane(snapshot, explicitPane);
    const cwd = paneCwd(pane);
    try {
      resolvedRepos.push(await resolveCheckpointRepo(cwd, { timeoutMs }));
    } catch (err) {
      gitFail(err);
    }
  } else {
    let snapshot: SessionSnapshot;
    try {
      snapshot = await sessionSnapshot(options);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      fail(
        `save requires --repo PATH or a reachable herdr session for pane discovery ` +
          `(session unreachable: ${detail})`,
        1,
        "session_unreachable",
      );
    }
    const seenCwds = new Set<string>();
    const seenRoots = new Set<string>();
    for (const pane of snapshot.panes ?? []) {
      const cwd = pane.cwd ?? (pane as { foreground_cwd?: string }).foreground_cwd;
      if (typeof cwd !== "string" || cwd === "" || seenCwds.has(cwd)) {
        if (typeof cwd !== "string" || cwd === "") {
          skippedPanes.push({ pane_id: pane.pane_id, reason: "no_pane_cwd" });
        }
        continue;
      }
      seenCwds.add(cwd);
      try {
        const resolved = await resolveCheckpointRepo(cwd, { timeoutMs });
        if (seenRoots.has(resolved.root)) continue;
        seenRoots.add(resolved.root);
        resolvedRepos.push(resolved);
      } catch (err) {
        if (err instanceof GitError || err instanceof CheckpointError) {
          skippedPanes.push({ pane_id: pane.pane_id, reason: err.kind });
        } else {
          throw err;
        }
      }
    }
  }

  // Phase 2: capture each repo under one shared group id.
  const groupId = newGroupId();
  const results: SaveRepoResult[] = failedRepos.map((f) => ({
    ok: false,
    repo_root: f.repo_root,
    error: { kind: f.kind, message: f.message },
  }));
  const captured: CheckpointEntry[] = [];
  for (const resolved of resolvedRepos) {
    try {
      const entry = await captureCheckpoint(resolved, {
        timeoutMs,
        label: labelFlag,
        kind: "manual",
      });
      entry.group_id = groupId;
      captured.push(entry);
      results.push({ ok: true, repo_root: resolved.root, checkpoint: entry });
    } catch (err) {
      const { kind, message } = saveErrorKind(err);
      results.push({ ok: false, repo_root: resolved.root, error: { kind, message } });
    }
  }

  if (captured.length > 0) {
    await updateState((state) => {
      for (const entry of captured) state.checkpoints[entry.id] = entry;
    });
  }

  const failures = results.filter((r) => !r.ok);
  const payload: Record<string, unknown> = {
    contract: CONTRACT,
    command: "save",
    ok: failures.length === 0,
    group: groupId,
    total: results.length,
    succeeded: results.length - failures.length,
    failed: failures.length,
    results,
    generated_at: new Date().toISOString(),
  };
  if (skippedPanes.length > 0) payload.skipped_panes = skippedPanes;
  emit(payload);
  if (failures.length > 0) {
    process.stderr.write(
      `${JSON.stringify({
        contract: CONTRACT,
        ok: false,
        error: {
          code: "error",
          message:
            `save ${groupId}: ${failures.length} of ${results.length} repos failed; ` +
            `succeeded repos were still captured`,
          kind: "partial_save",
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}

// --- Retention GC ----------------------------------------------------------

interface GcPolicy {
  maxCount: number;
  maxAgeDays: number;
  protectDays: number;
}

function positiveFlag(args: string[], name: string): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`invalid ${name}: ${raw}`, 2);
  return value;
}

function gcPolicy(options: CliOptions, config: PluginConfig): GcPolicy {
  return {
    maxCount:
      positiveFlag(options.args, "--max-count") ?? config.gcMaxCount ?? DEFAULT_GC_MAX_COUNT,
    maxAgeDays:
      positiveFlag(options.args, "--max-age-days") ??
      config.gcMaxAgeDays ??
      DEFAULT_GC_MAX_AGE_DAYS,
    protectDays:
      positiveFlag(options.args, "--protect-days") ??
      config.preRestoreProtectDays ??
      DEFAULT_PRE_RESTORE_PROTECT_DAYS,
  };
}

/**
 * Resolve the set of live repo roots GC/prune operate on, deduped by
 * canonical root. Callers needing common-dir dedupe (prune's ref
 * scan) do it themselves via the returned `commonDir`. Repos that no
 * longer resolve are reported in `unreachable` and skipped — their
 * state entries are never touched (refs cannot be enumerated or
 * deleted without the repo).
 */
async function resolveGcRepos(
  repoRoots: string[],
  repoFlag: string | undefined,
  timeoutMs: number,
): Promise<{
  repos: Array<{ root: string; commonDir: string }>;
  unreachable: Array<{ repo_root: string; kind: string; message: string }>;
}> {
  const wanted = repoFlag === undefined ? repoRoots : [repoFlag];
  const repos: Array<{ root: string; commonDir: string }> = [];
  const unreachable: Array<{ repo_root: string; kind: string; message: string }> = [];
  const seenRoots = new Set<string>();
  for (const target of wanted) {
    try {
      const info = await resolveRepo(target, { timeoutMs });
      const root = await canonicalRepoRoot(info.root);
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);
      const commonDir = await realpath(info.gitCommonDir);
      repos.push({ root, commonDir });
    } catch (err) {
      if (err instanceof GitError) {
        unreachable.push({ repo_root: target, kind: err.kind, message: err.message });
      } else {
        throw err;
      }
    }
  }
  return { repos, unreachable };
}

/**
 * `gc` — bounded retention for checkpoint entries (#75). Per repo
 * (canonical root), evicts the oldest entries beyond `--max-count`
 * and every entry older than `--max-age-days`. `kind:"pre_restore"`
 * entries younger than `--protect-days` are exempt — they are the
 * recovery anchor for a recent restore. Deletion removes the hidden
 * ref AND the state entry together; a ref that fails to delete keeps
 * its state entry (reported, retried next run). `--dry-run` reports
 * exactly what would be evicted without mutating anything.
 */
async function cmdGc(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  await drainAuto(options, config);
  const valueFlags = ["--repo", "--max-count", "--max-age-days", "--protect-days"];
  const pos = positionals(options.args, valueFlags);
  if (pos.length > 0) fail("gc takes no positional arguments", 2);
  const dryRun = options.args.includes("--dry-run");
  const repoFlag = flagValue(options.args, "--repo");
  if (repoFlag?.startsWith("-")) fail("invalid --repo value", 2);
  const timeoutMs = effectiveTimeoutMs(options, config);
  const policy = gcPolicy(options, config);

  const state = await loadState();
  const byRepo = new Map<string, CheckpointEntry[]>();
  for (const entry of Object.values(state.checkpoints)) {
    const list = byRepo.get(entry.repo_root) ?? [];
    list.push(entry);
    byRepo.set(entry.repo_root, list);
  }

  const { repos, unreachable } = await resolveGcRepos(
    byRepo.size === 0 ? [] : [...byRepo.keys()],
    repoFlag,
    timeoutMs,
  );

  const now = Date.now();
  const repoReports: Array<Record<string, unknown>> = [];
  const stateRemovals: string[] = [];
  const totals = { evaluated: 0, deleted: 0, would_delete: 0, protected: 0, kept: 0, errors: 0 };

  for (const repo of repos) {
    // Entries recorded against this canonical root. repo_root values in
    // state are already canonical, so an exact match is correct; a repo
    // that moved fails resolution earlier and lands in `unreachable`.
    const entries = (byRepo.get(repo.root) ?? [])
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));

    const evictIds = new Set<string>();
    const protectedIds: string[] = [];
    const errors: Array<{ id: string; message: string }> = [];
    let kept = 0;

    entries.forEach((entry, index) => {
      totals.evaluated += 1;
      const ageDays = (now - Date.parse(entry.created_at)) / DAY_MS;
      const effectiveAge = Number.isNaN(ageDays) ? Number.POSITIVE_INFINITY : ageDays;
      const isProtectedPreRestore =
        entry.kind === "pre_restore" && effectiveAge < policy.protectDays;
      if (isProtectedPreRestore) {
        protectedIds.push(entry.id);
        totals.protected += 1;
        kept += 1;
        return;
      }
      if (index >= policy.maxCount || effectiveAge > policy.maxAgeDays) {
        evictIds.add(entry.id);
      } else {
        kept += 1;
      }
    });
    totals.kept += kept;

    const deleted: string[] = [];
    const wouldDelete: string[] = [];
    if (dryRun) {
      for (const entry of entries) {
        if (evictIds.has(entry.id)) wouldDelete.push(entry.id);
      }
      totals.would_delete += wouldDelete.length;
    } else {
      for (const entry of entries) {
        if (!evictIds.has(entry.id)) continue;
        try {
          // deleteRef is idempotent: an already-gone ref still lets the
          // state entry be removed.
          await deleteRef(repo.root, entry.ref, { timeoutMs });
          deleted.push(entry.id);
          stateRemovals.push(entry.id);
        } catch (err) {
          if (err instanceof GitError) {
            errors.push({ id: entry.id, message: err.message });
            totals.errors += 1;
          } else {
            throw err;
          }
        }
      }
      totals.deleted += deleted.length;
    }

    repoReports.push({
      repo_root: repo.root,
      evaluated: entries.length,
      ...(dryRun ? { would_delete: wouldDelete } : { deleted }),
      protected: protectedIds,
      kept,
      ...(errors.length > 0 ? { errors } : {}),
    });
  }

  if (!dryRun && stateRemovals.length > 0) {
    const removals = new Set(stateRemovals);
    await updateState((state) => {
      for (const id of removals) delete state.checkpoints[id];
    });
  }

  // ok is false only when NOTHING could be evaluated (every wanted repo
  // unreachable); partial unreachable is reported in `unreachable` with
  // ok:true. A false ok must not exit 0 — same honesty rule as
  // save/restore-group partial failures.
  const ok = unreachable.length === 0 || repoReports.length > 0;
  emit({
    contract: CONTRACT,
    command: "gc",
    ok,
    dry_run: dryRun,
    policy: {
      max_count: policy.maxCount,
      max_age_days: policy.maxAgeDays,
      pre_restore_protect_days: policy.protectDays,
    },
    repos: repoReports,
    unreachable,
    totals: {
      evaluated: totals.evaluated,
      ...(dryRun ? { would_delete: totals.would_delete } : { deleted: totals.deleted }),
      protected: totals.protected,
      kept: totals.kept,
      errors: totals.errors,
    },
    generated_at: new Date().toISOString(),
  });
  if (!ok) failUnreachable("gc", unreachable);
}

/**
 * `prune` — deleteStaleRefs equivalent (#75): delete hidden refs under
 * `refs/herdr-plugins/checkpoints/` that the state index does not
 * reference. Protection is by full ref name: any ref named by ANY
 * state entry is kept, in every repo scanned (repo-key namespacing
 * makes cross-repo collisions impossible in practice, and the rule
 * stays conservative). Repos scanned: `--repo PATH`, else every repo
 * root known to state. `--dry-run` lists orphans without deleting.
 */
async function cmdPrune(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  await drainAuto(options, config);
  const valueFlags = ["--repo"];
  const pos = positionals(options.args, valueFlags);
  if (pos.length > 0) fail("prune takes no positional arguments", 2);
  const dryRun = options.args.includes("--dry-run");
  const repoFlag = flagValue(options.args, "--repo");
  if (repoFlag?.startsWith("-")) fail("invalid --repo value", 2);
  const timeoutMs = effectiveTimeoutMs(options, config);

  const state = await loadState();
  const protectedRefs = new Set(Object.values(state.checkpoints).map((e) => e.ref));
  const stateRepoRoots = [...new Set(Object.values(state.checkpoints).map((e) => e.repo_root))];

  const { repos, unreachable } = await resolveGcRepos(stateRepoRoots, repoFlag, timeoutMs);

  const repoReports: Array<Record<string, unknown>> = [];
  const totals = { scanned: 0, orphans: 0, deleted: 0, would_delete: 0, errors: 0 };
  // Linked worktrees share one ref store: scan each common dir once.
  const seenCommons = new Set<string>();

  for (const repo of repos) {
    if (seenCommons.has(repo.commonDir)) continue;
    seenCommons.add(repo.commonDir);
    let refs: string[];
    try {
      refs = await listCheckpointRefs(repo.root, { timeoutMs });
    } catch (err) {
      if (err instanceof GitError) {
        unreachable.push({ repo_root: repo.root, kind: err.kind, message: err.message });
        continue;
      }
      throw err;
    }
    const orphans = refs.filter((ref) => !protectedRefs.has(ref));
    const deleted: string[] = [];
    const errors: Array<{ ref: string; message: string }> = [];
    if (dryRun) {
      totals.would_delete += orphans.length;
    } else {
      for (const ref of orphans) {
        try {
          // --no-deref mirrors upstream: delete the checkpoint ref
          // itself, never a symbolic ref's target.
          await gitOk(repo.root, ["update-ref", "--no-deref", "-d", ref], { timeoutMs });
          deleted.push(ref);
        } catch (err) {
          if (err instanceof GitError) {
            errors.push({ ref, message: err.message });
            totals.errors += 1;
          } else {
            throw err;
          }
        }
      }
      totals.deleted += deleted.length;
    }
    totals.scanned += refs.length;
    totals.orphans += orphans.length;
    repoReports.push({
      repo_root: repo.root,
      scanned: refs.length,
      orphans,
      ...(dryRun ? {} : { deleted }),
      ...(errors.length > 0 ? { errors } : {}),
    });
  }

  // Same honesty rule as gc: ok is false only when NO repo could be
  // scanned (every wanted repo unreachable or ref listing failed).
  const ok = unreachable.length === 0 || repoReports.length > 0;
  emit({
    contract: CONTRACT,
    command: "prune",
    ok,
    dry_run: dryRun,
    repos: repoReports,
    unreachable,
    totals: {
      scanned: totals.scanned,
      orphans: totals.orphans,
      ...(dryRun ? { would_delete: totals.would_delete } : { deleted: totals.deleted }),
      errors: totals.errors,
    },
    generated_at: new Date().toISOString(),
  });
  if (!ok) failUnreachable("prune", unreachable);
}

async function cmdCapability(): Promise<void> {
  const config = await loadConfig();
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    commands: [
      "capability",
      "create",
      "save",
      "list",
      "show",
      "diff",
      "plan",
      "restore",
      "restore-group",
      "delete",
      "gc",
      "prune",
    ],
    read_only: false,
    mutation_commands: ["create", "save", "delete", "restore", "restore-group", "gc", "prune"],
    requires: { git: true, bun: true },
    defaults: {
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      diffMaxBytes: config.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES,
      showMaxBytes: config.showMaxBytes ?? DEFAULT_SHOW_MAX_BYTES,
      listLimit: DEFAULT_LIST_LIMIT,
      gcMaxCount: config.gcMaxCount ?? DEFAULT_GC_MAX_COUNT,
      gcMaxAgeDays: config.gcMaxAgeDays ?? DEFAULT_GC_MAX_AGE_DAYS,
      preRestoreProtectDays: config.preRestoreProtectDays ?? DEFAULT_PRE_RESTORE_PROTECT_DAYS,
    },
  });
}

const USAGE = `rebuildup.checkpoints — hidden-ref worktree checkpoints (contract ${CONTRACT})

Usage:
  checkpoints create [--repo PATH | <pane_id>] [--label TEXT] [--auto]
      [--session NAME] [--timeout MS]
  checkpoints save [--repo PATH ...] [--pane ID | <pane_id>] [--label TEXT]
      [--session NAME] [--socket PATH] [--timeout MS]
  checkpoints list [--repo PATH] [--group ID] [--limit N]
  checkpoints show <checkpoint-id> [--max-bytes N]
  checkpoints diff <checkpoint-id|HEAD> <checkpoint-id|HEAD> [--max-bytes N]
  checkpoints plan <checkpoint-id> [--repo PATH]
  checkpoints restore <checkpoint-id> [--repo PATH] [--force]
      [--session NAME] [--socket PATH] [--timeout MS]
  checkpoints restore-group <group-id> [--force]
      [--session NAME] [--socket PATH] [--timeout MS]
  checkpoints delete <checkpoint-id>
  checkpoints gc [--repo PATH] [--dry-run]
      [--max-count N] [--max-age-days N] [--protect-days N]
  checkpoints prune [--repo PATH] [--dry-run]
  checkpoints capability

save captures one checkpoint per repo under a shared group id (explicit
--repo list, a pane's repo, or live discovery across all session pane
repos); restore-group restores every member with per-repo status —
a partial restore reports ok:false and exits 1.

gc enforces per-repo retention (newest --max-count entries, entries
younger than --max-age-days; recent pre_restore entries are protected
for --protect-days). prune deletes hidden refs the state index no
longer references (deleteStaleRefs equivalent). Both support --dry-run.

restore first captures a mandatory pre-restore checkpoint (recover
your previous state with 'restore <pre-restore-id>'), refuses when the
herdr session is unreachable or >=2 live panes share the worktree
(unless --force), then restores tracked+staged content and deletes
untracked files — post-checkpoint untracked files are removed.

Every command first drains capture-pending marks recorded by the
pane.agent_status_changed event hook (working→idle/done transitions):
each still-valid mark becomes an 'auto' checkpoint for the pane's repo.
Results are reported in the payload's 'auto_captures' field.
See docs/contracts/checkpoints-v1.md.
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "create":
      return cmdCreate(options);
    case "save":
      return cmdSave(options);
    case "list":
      return cmdList(options);
    case "show":
      return cmdShow(options);
    case "diff":
      return cmdDiff(options);
    case "plan":
      return cmdPlan(options);
    case "restore":
      return cmdRestore(options);
    case "restore-group":
      return cmdRestoreGroup(options);
    case "delete":
      return cmdDelete(options);
    case "gc":
      return cmdGc(options);
    case "prune":
      return cmdPrune(options);
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
