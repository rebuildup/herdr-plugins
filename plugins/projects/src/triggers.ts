/**
 * Auto-trigger marks and lazy drain for rebuildup.projects (#180).
 *
 * Upstream T3 Code runs `t3.json` scripts flagged `runOnWorktreeCreate`
 * when a worktree is created. herdr delivers a faithful
 * `worktree.created` plugin-hook event (same mechanism
 * plugins/automations subscribes to, ADR-0022 addendum), so v1 wires
 * the trigger end-to-end without a daemon:
 *
 * - Hook side (`src/hook.ts`): records a `PendingTriggerMark` into
 *   `state.json` — no socket work, no git, fast by contract (ADR-0002).
 * - Drain side (`drainWorktreeTriggers`): the next `scripts`-family CLI
 *   invocation resolves each mark: worktree path → `resolveRepo` →
 *   `git-common-dir` → projects `repos[]` membership → layered script
 *   resolution (#50) → `runOnWorktreeCreate` scripts only → the SAME
 *   ADR-0010 runner (`startRun`) used by `scripts run`.
 *
 * Honesty rules (AGENTS §4):
 * - A worktree whose repo group is not registered is skipped with a
 *   recorded reason — never mapped by guesswork.
 * - Marks for unreachable sessions stay pending; evaluated-and-skipped
 *   marks are consumed and reported.
 * - Duplicate deliveries of the same worktree collapse to ONE fire.
 * - `runOnSettle`/`stopOnSettle` are NOT handled here (#181/#182).
 */

import { existsSync } from "node:fs";
import {
  GitError,
  type RepoInfo,
  repoRemoteIdentity,
  resolveRepo,
} from "../../../packages/git-core/src/index";
import {
  type CallOptions,
  HerdrRpcError,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import { canonicalRepoRoot } from "./model";
import { herdrTransport, type RunnerDeps, startRun } from "./runner";
import type { ScriptRun } from "./runs";
import { BUILTIN_SCRIPTS, type ResolvedScript, resolveScripts, ScriptError } from "./scripts";
import {
  loadSettings,
  loadState,
  type PendingTriggerMark,
  type Project,
  type ProjectsState,
  updateState,
} from "./state";
import { loadT3ProjectFile, T3JsonError, type T3ProjectFileScript } from "./t3json";

/** Only this event is wired in v1; settle triggers are #181/#182. */
export const WORKTREE_CREATED_EVENT = "worktree.created";

/** Bounded pending-mark backlog; overflow drops the OLDEST marks. */
export const MAX_PENDING_TRIGGERS = 200;

/** snake_case wire form → dotted canonical (only the wired event). */
const SNAKE_TO_DOTTED: Record<string, string> = {
  worktree_created: WORKTREE_CREATED_EVENT,
};

/**
 * Resolve a hook-delivered event name to the canonical dotted form.
 * Accepts `worktree.created` (HERDR_PLUGIN_EVENT) and
 * `worktree_created` (JSON envelope `event`/`data.type`). Returns null
 * for anything else — unknown events are never recorded.
 */
export function canonicalTriggerEventName(raw: string | undefined | null): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw === WORKTREE_CREATED_EVENT) return raw;
  return SNAKE_TO_DOTTED[raw] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract the worktree checkout path from a `worktree.created` event
 * `data` payload. The herdr 0.9.5 schema carries it at
 * `data.worktree.path` (WorktreeInfo); a flat `worktree_path` is also
 * accepted defensively. Returns null when absent — the hook then
 * records nothing rather than guessing a path.
 */
export function extractWorktreePath(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const worktree = isRecord(data.worktree) ? data.worktree : null;
  return str(worktree?.path) ?? str(data.worktree_path) ?? null;
}

function extractWorkspaceId(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const workspace = isRecord(data.workspace) ? data.workspace : null;
  return str(workspace?.workspace_id) ?? str(data.workspace_id) ?? null;
}

/**
 * Build a pending mark from a normalized hook delivery, or null when
 * the payload cannot identify a worktree. `socketPath` is the resolved
 * socket of the EMITTING session (hook env), recorded verbatim so the
 * drain executes against the session that owns the worktree.
 */
export function buildTriggerMark(input: {
  event: string;
  data: Record<string, unknown>;
  socketPath: string;
  receivedAt?: string;
}): PendingTriggerMark | null {
  if (input.event !== WORKTREE_CREATED_EVENT) return null;
  const worktreePath = extractWorktreePath(input.data);
  if (worktreePath === null) return null;
  return {
    event: input.event,
    received_at: input.receivedAt ?? new Date().toISOString(),
    socket_path: input.socketPath,
    worktree_path: worktreePath,
    workspace_id: extractWorkspaceId(input.data),
    data: input.data,
  };
}

/** Identity used for pending-mark dedupe: same event + session + path. */
function markKey(mark: PendingTriggerMark): string {
  return `${mark.event}${mark.socket_path}${canonicalRepoRoot(mark.worktree_path)}`;
}

/**
 * Append a mark inside `updateState`. Idempotent: an identical pending
 * mark (same event/session/worktree path) is not duplicated — herdr
 * redelivery or a repeated hook invocation cannot stack fires. Overflow
 * drops the oldest marks and counts them (`pending_triggers_dropped`).
 */
export function recordTriggerMark(
  state: ProjectsState,
  mark: PendingTriggerMark,
): "recorded" | "duplicate" {
  if (state.pending_triggers === undefined) state.pending_triggers = [];
  const pending = state.pending_triggers;
  const key = markKey(mark);
  if (pending.some((m) => markKey(m) === key)) return "duplicate";
  pending.push(mark);
  const overflow = pending.length - MAX_PENDING_TRIGGERS;
  if (overflow > 0) {
    pending.splice(0, overflow);
    state.pending_triggers_dropped = (state.pending_triggers_dropped ?? 0) + overflow;
  }
  return "recorded";
}

// --- Drain -----------------------------------------------------------------

export interface TriggerFire {
  run_id: string;
  project_id: string;
  script: string;
  worktree_path: string;
  result: ScriptRun["result"];
}

export interface TriggerSkip {
  worktree_path: string;
  socket_path: string;
  reason: string;
  detail?: string;
}

export interface TriggerDrainReport {
  /** Runs started by this drain (one per flagged script per worktree). */
  fired: TriggerFire[];
  /** Marks evaluated and consumed without firing, with reasons. */
  skipped: TriggerSkip[];
  /** Identical pending marks collapsed into a single evaluation. */
  duplicates: number;
  /** Marks left pending (unreachable sessions only). */
  pending_remaining: number;
  /** True when at least one emitting session socket was unreachable. */
  session_unreachable?: boolean;
}

interface DrainConfig {
  /** `runTimeoutMs` etc. forwarded to the ADR-0010 runner. */
  waitTimeoutMs?: number | undefined;
  logMaxBytes?: number | undefined;
  stopGraceMs?: number | undefined;
}

function emptyReport(): TriggerDrainReport {
  return { fired: [], skipped: [], duplicates: 0, pending_remaining: 0 };
}

/** member root → git-common-dir cache for membership checks. */
async function memberCommonDir(root: string, timeoutMs?: number): Promise<string | null> {
  try {
    const info = await resolveRepo(root, timeoutMs === undefined ? {} : { timeoutMs });
    return canonicalRepoRoot(info.gitCommonDir);
  } catch {
    // An unreachable member cannot prove membership — it simply does
    // not match (never guessed).
    return null;
  }
}

interface ScriptResolutionOk {
  ok: true;
  scripts: ResolvedScript[];
}
interface ScriptResolutionErr {
  ok: false;
  kind: string;
  message: string;
  extra?: Record<string, unknown>;
}

/**
 * Same layered resolution as `scripts list`/`scripts run` (project
 * settings override → env default → t3.json → builtin) but returns
 * structured errors instead of exiting — a broken t3.json in ONE repo
 * must not kill the whole drain.
 */
async function resolveScriptsSafe(
  root: string,
  projectId: string | null,
  envDefault: unknown,
): Promise<ScriptResolutionOk | ScriptResolutionErr> {
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
      return {
        ok: false,
        kind: "t3json_invalid",
        message: err.message,
        extra: { path: err.file, reason: err.reason },
      };
    }
    throw err;
  }
  try {
    return {
      ok: true,
      scripts: resolveScripts({
        override: overrideRaw,
        envDefault,
        t3Scripts,
        builtin: BUILTIN_SCRIPTS,
      }),
    };
  } catch (err) {
    if (err instanceof ScriptError) {
      return { ok: false, kind: err.reason, message: err.message, extra: { layer: err.layer } };
    }
    throw err;
  }
}

/** Find the single project owning the event worktree's repo group. */
async function matchProject(
  state: ProjectsState,
  commonDir: string,
  timeoutMs?: number,
): Promise<{ project: Project } | { reason: string; detail?: string }> {
  const commonCache = new Map<string, string | null>();
  const matches: Project[] = [];
  for (const project of Object.values(state.projects)) {
    if (project.archived) continue;
    let hit = false;
    for (const member of project.repos) {
      const key = canonicalRepoRoot(member.root);
      let dir = commonCache.get(key);
      if (dir === undefined) {
        dir = await memberCommonDir(member.root, timeoutMs);
        commonCache.set(key, dir);
      }
      if (dir !== null && dir === commonDir) {
        hit = true;
        break;
      }
    }
    if (hit) matches.push(project);
  }
  if (matches.length === 0) return { reason: "repo_not_registered" };
  if (matches.length > 1) {
    return {
      reason: "ambiguous_project",
      detail: matches.map((p) => p.id).join(","),
    };
  }
  return { project: matches[0] as Project };
}

function isConnectionError(err: unknown): boolean {
  // Socket-level failures reject with the raw Node error (ENOENT/
  // ECONNREFUSED), not HerdrRpcError — those mean the emitting
  // session is unreachable and the mark should stay pending.
  return !(err instanceof HerdrRpcError) && !(err instanceof GitError);
}

/**
 * Drain pending `worktree.created` marks into script runs. Called at
 * the top of `scripts`-family CLI commands (`tick`, `run`, `stop`,
 * `results`, `logs`); a no-op (one state read) when nothing is pending.
 *
 * Marks are consumed under the state lock BEFORE execution (same
 * phase discipline as checkpoints auto-capture), so concurrent drains
 * cannot double-fire. Marks whose emitting socket is unreachable stay
 * pending for a later drain.
 */
export async function drainWorktreeTriggers(
  options: CallOptions,
  config: DrainConfig = {},
  envDefault?: unknown,
): Promise<TriggerDrainReport> {
  const report = emptyReport();
  const timeoutMs = options.timeoutMs;

  const state = await loadState();
  const all = (state.pending_triggers ?? []).filter((m) => m.event === WORKTREE_CREATED_EVENT);
  if (all.length === 0) return report;

  // Dedupe identical deliveries: same event + session socket + worktree
  // path fires once per drain regardless of how many marks exist.
  const seen = new Set<string>();
  const unique: PendingTriggerMark[] = [];
  for (const mark of all) {
    const key = markKey(mark);
    if (seen.has(key)) {
      report.duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(mark);
  }

  // Preflight each emitting socket once; unreachable sessions keep
  // their marks pending (transient outage must not lose triggers).
  const socketAlive = new Map<string, boolean>();
  for (const socketPath of new Set(unique.map((m) => m.socket_path))) {
    const probe: CallOptions = { socketPath };
    if (timeoutMs !== undefined) probe.timeoutMs = timeoutMs;
    try {
      await sessionSnapshot(probe);
      socketAlive.set(socketPath, true);
    } catch {
      socketAlive.set(socketPath, false);
    }
  }

  const live = unique.filter((m) => socketAlive.get(m.socket_path) === true);
  const dead = unique.filter((m) => socketAlive.get(m.socket_path) !== true);
  for (const mark of dead) {
    report.session_unreachable = true;
    report.skipped.push({
      worktree_path: mark.worktree_path,
      socket_path: mark.socket_path,
      reason: "session_unreachable",
    });
  }

  // Consume the live marks under the lock before any execution.
  const consumedKeys = new Set(live.map(markKey));
  await updateState((s) => {
    const pending = s.pending_triggers ?? [];
    s.pending_triggers = pending.filter((m) => !consumedKeys.has(markKey(m)));
  });

  const depsFor = (socketPath: string): RunnerDeps => ({
    transport: herdrTransport({ ...options, socketPath }),
    waitTimeoutMs: config.waitTimeoutMs,
    logMaxBytes: config.logMaxBytes,
    stopGraceMs: config.stopGraceMs,
  });

  const gitOptions = timeoutMs === undefined ? {} : { timeoutMs };

  for (const mark of live) {
    const skip = (reason: string, detail?: string): void => {
      report.skipped.push({
        worktree_path: mark.worktree_path,
        socket_path: mark.socket_path,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });
    };

    // 1. Resolve the event worktree → repo group identity. A checkout
    //    deleted between event and drain is an honest skip, not a git
    //    probe against a nonexistent cwd.
    if (!existsSync(mark.worktree_path)) {
      skip("worktree_gone");
      continue;
    }
    let info: RepoInfo;
    try {
      info = await resolveRepo(mark.worktree_path, gitOptions);
    } catch (err) {
      skip(err instanceof GitError ? err.kind : "repo_unreachable", undefined);
      continue;
    }
    const worktreeRoot = canonicalRepoRoot(info.root);
    const commonDir = canonicalRepoRoot(info.gitCommonDir);

    // 2. Match the repo group against registry membership (git-common-dir
    //    — linked worktrees of a registered repo all share it).
    const fresh = await loadState();
    const match = await matchProject(fresh, commonDir, timeoutMs);
    if ("reason" in match) {
      skip(match.reason, match.detail);
      continue;
    }
    const project = match.project;

    // 3. Layered script resolution against the EVENT worktree root —
    //    scripts execute in the newly created worktree (upstream
    //    runOnWorktreeCreate semantics), overrides still apply.
    const resolved = await resolveScriptsSafe(worktreeRoot, project.id, envDefault);
    if (!resolved.ok) {
      skip(resolved.kind, resolved.message);
      continue;
    }
    const flagged = resolved.scripts.filter((s) => s.runOnWorktreeCreate === true);
    if (flagged.length === 0) {
      skip("no_run_on_worktree_create_scripts");
      continue;
    }

    let remote: string | null = null;
    try {
      remote = await repoRemoteIdentity(worktreeRoot, gitOptions);
    } catch {
      remote = null;
    }

    // 4. Fire each flagged script through the established runner.
    for (const script of flagged) {
      try {
        const run = await startRun(
          {
            project,
            script: {
              id: script.id,
              name: script.name,
              command: script.command,
              source: script.source,
            },
            repoRoot: worktreeRoot,
            remote,
            trigger: {
              kind: WORKTREE_CREATED_EVENT,
              worktree_path: mark.worktree_path,
              event_received_at: mark.received_at,
            },
          },
          depsFor(mark.socket_path),
        );
        report.fired.push({
          run_id: run.run_id,
          project_id: project.id,
          script: script.name,
          worktree_path: mark.worktree_path,
          result: run.result,
        });
      } catch (err) {
        if (isConnectionError(err)) {
          // Socket died between preflight and execution: report and
          // keep the outcome honest — the mark is already consumed, so
          // surface it as a skip with the transport error.
          skip("session_unreachable", err instanceof Error ? err.message : String(err));
        } else {
          skip("run_start_failed", err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  const remaining = await loadState();
  report.pending_remaining = (remaining.pending_triggers ?? []).length;
  return report;
}
