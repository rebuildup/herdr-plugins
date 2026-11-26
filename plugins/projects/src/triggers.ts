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
 * - `runOnSettle`/`stopOnSettle` drain the rebuildup.inbox organize-
 *   transition log instead (#182, ADR-0029) — see the settle section
 *   below; they never ride the hook-event path.
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
  resolveSocketPath,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import {
  type InboxCliCallOptions,
  inboxTargetArgs,
  resolveInboxSource,
  runInboxCli,
} from "./inbox-source";
import { canonicalRepoRoot } from "./model";
import { herdrTransport, type RunnerDeps, startRun, stopRuns } from "./runner";
import type { ScriptRun } from "./runs";
import { loadRuns } from "./runs";
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
  /** Trigger source; `worktree.created` (default) or `inbox.settled` (#182). */
  source?: string;
  /** Settled pane id (inbox.settled fires only). */
  pane_id?: string;
  /** Inbox transition seq that fired the run (inbox.settled only). */
  transition_seq?: number;
}

export interface TriggerSkip {
  /** Present for worktree.created skips; absent for inbox.settled skips. */
  worktree_path?: string;
  /** Settled pane cwd (inbox.settled skips only). */
  cwd?: string;
  /** Settled pane id (inbox.settled skips only). */
  pane_id?: string;
  /** Inbox transition seq (inbox.settled skips only). */
  transition_seq?: number;
  socket_path?: string;
  reason: string;
  detail?: string;
  /** Trigger source; `worktree.created` (default) or `inbox.settled` (#182). */
  source?: string;
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
  /** True when the inbox plugin could not be resolved or queried (#182). */
  inbox_unavailable?: boolean;
  /** Settle-drain cursor bookkeeping, present when a drain ran (#182). */
  settle?: {
    session_key: string;
    cursor_before: number;
    cursor_after: number;
    cursor_expired: boolean;
  };
  /** Runs stopped by stopOnSettle selections (#182). */
  stopped?: SettleStop[];
}

/** One run stopped by a `stopOnSettle` selection (#182). */
export interface SettleStop {
  run_id: string;
  project_id: string;
  script: string;
  pane_id: string;
  action: "stopped" | "already_finished" | "pane_gone";
  transition_seq: number;
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
      source: WORKTREE_CREATED_EVENT,
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
        source: WORKTREE_CREATED_EVENT,
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
          source: WORKTREE_CREATED_EVENT,
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

// --- Settle triggers (#182, ADR-0029) ---------------------------------------
//
// `runOnSettle`/`stopOnSettle` consume rebuildup.inbox's organize-
// transition log through its public `transitions` CLI (ADR-0013 pattern —
// never inbox state files). Settle is user organize state, NOT agent
// execution state: this drain fires only on recorded `settled`
// transitions and reports every skip honestly.

/** Canonical trigger-source label for settle-drain fires/skips. */
export const INBOX_SETTLED_SOURCE = "inbox.settled";

/** Page size for the `--after` drain; equals the inbox per-session cap. */
const SETTLE_DRAIN_LIMIT = 500;

/** Wire shape of one `inbox transitions` item (validated loosely). */
interface InboxTransitionItem {
  seq: number;
  at: string;
  kind: string;
  pane_id: string;
  cwd?: string;
  workspace_id?: string;
  agent_status?: string;
}

function isTransitionItem(value: unknown): value is InboxTransitionItem {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.seq === "number" &&
    typeof t.kind === "string" &&
    typeof t.pane_id === "string" &&
    typeof t.at === "string"
  );
}

export interface SettleDrainReport {
  /** False when the inbox plugin was absent/unrunnable — nothing consumed. */
  available: boolean;
  session_key?: string;
  head_seq?: number;
  cursor_before?: number;
  cursor_after?: number;
  cursor_expired?: boolean;
  fired: TriggerFire[];
  skipped: TriggerSkip[];
  stopped: SettleStop[];
}

function settleSkip(
  report: SettleDrainReport,
  t: InboxTransitionItem,
  reason: string,
  detail?: string,
): void {
  report.skipped.push({
    pane_id: t.pane_id,
    ...(t.cwd !== undefined ? { cwd: t.cwd } : {}),
    transition_seq: t.seq,
    reason,
    source: INBOX_SETTLED_SOURCE,
    ...(detail !== undefined ? { detail } : {}),
  });
}

/**
 * Drain new inbox organize transitions into `runOnSettle` fires and
 * `stopOnSettle` stops. Called at the top of `scripts`-family CLI
 * commands next to `drainWorktreeTriggers` (same no-daemon discipline).
 *
 * - Source: `rebuildup.inbox transitions` via the public CLI; the
 *   `session_key` in the response is stored verbatim as the cursor key —
 *   projects never recomputes inbox's `hostname + canonical socket` key.
 * - Cursor: `state.settle_cursors[session_key]` advances to `head_seq`
 *   only after the batch is processed; a mid-batch crash replays the
 *   tail, absorbed by the `transition_seq` run-record dedupe.
 * - Collapse: within the drained batch a later `cleared`/`restored` for
 *   the same `pane_id` supersedes an earlier `settled` →
 *   `settle_superseded`.
 * - stopOnSettle stops ONLY `running` runs whose recorded `repo.root`
 *   canonicalizes to the settled pane's worktree root AND whose script —
 *   re-resolved via the #50 layers — has `stopOnSettle === true`. Runs of
 *   sibling worktrees in the same repo group are never touched.
 */
export async function drainSettleTriggers(
  options: CallOptions,
  config: DrainConfig = {},
  envDefault?: unknown,
  inboxRoot?: string,
): Promise<SettleDrainReport> {
  const report: SettleDrainReport = { available: true, fired: [], skipped: [], stopped: [] };
  const timeoutMs = options.timeoutMs;
  const gitOptions = timeoutMs === undefined ? {} : { timeoutMs };

  const resolved = await resolveInboxSource(inboxRoot);
  if (!resolved.ok) {
    report.available = false;
    return report;
  }
  const source = resolved.source;
  // Pin the child to the SAME socket this invocation resolved (explicit
  // --socket > HERDR_SOCKET_PATH > --session/HERDR_SESSION > default) —
  // the ambient env must never let the inbox CLI drift to a different
  // session than the one projects is draining for.
  const socketPath = options.socketPath ?? resolveSocketPath({ session: options.session });
  const call: InboxCliCallOptions = {
    session: options.session,
    socketPath,
    timeoutMs,
  };

  // Phase 1: head metadata only — establishes the session_key (stored
  // verbatim) and whether anything new exists past our cursor.
  const meta = await runInboxCli(
    source,
    ["transitions", "--limit", "1", ...inboxTargetArgs(call)],
    call,
  );
  const metaJson = meta.json;
  if (
    meta.status !== 0 ||
    metaJson === null ||
    metaJson.command !== "transitions" ||
    typeof metaJson.session_key !== "string" ||
    typeof metaJson.head_seq !== "number"
  ) {
    // Absent plugin, unreachable session, or contract drift — all honest
    // `inbox_unavailable`, never an error that fails `scripts`.
    report.available = false;
    return report;
  }
  const sessionKey = metaJson.session_key;
  const headSeq = metaJson.head_seq;
  const oldestSeq = typeof metaJson.oldest_seq === "number" ? metaJson.oldest_seq : null;

  const state = await loadState();
  const cursorBefore = state.settle_cursors?.[sessionKey] ?? 0;
  report.session_key = sessionKey;
  report.cursor_before = cursorBefore;

  if (headSeq <= cursorBefore) {
    report.cursor_after = cursorBefore;
    report.cursor_expired = false;
    return report;
  }

  // Phase 2: the full drained batch, ascending seq, exclusive --after.
  const page = await runInboxCli(
    source,
    [
      "transitions",
      "--after",
      String(cursorBefore),
      "--limit",
      String(SETTLE_DRAIN_LIMIT),
      ...inboxTargetArgs(call),
    ],
    call,
  );
  const pageJson = page.json;
  if (
    page.status !== 0 ||
    pageJson === null ||
    pageJson.command !== "transitions" ||
    !Array.isArray(pageJson.transitions)
  ) {
    report.available = false;
    return report;
  }
  const items = (pageJson.transitions as unknown[]).filter(isTransitionItem);
  const headSeqAfter = typeof pageJson.head_seq === "number" ? pageJson.head_seq : headSeq;
  report.head_seq = headSeqAfter;
  report.cursor_expired = oldestSeq !== null && cursorBefore + 1 < oldestSeq;

  // Runs snapshot BEFORE this drain fires anything: stopOnSettle selects
  // from pre-existing running runs only — a script flagged both ways is
  // never stopped by the run it just started.
  const runsBefore = await loadRuns();
  const firedTransitionSeqs = new Set(
    Object.values(runsBefore.runs)
      .filter((r) => r.trigger?.kind === INBOX_SETTLED_SOURCE)
      .map((r) => r.trigger?.transition_seq)
      .filter((s): s is number => typeof s === "number"),
  );

  // Collapse: latest cleared/restored seq per pane within THIS batch.
  const supersedeSeq = new Map<string, number>();
  for (const t of items) {
    if (t.kind === "cleared" || t.kind === "restored") {
      supersedeSeq.set(t.pane_id, Math.max(supersedeSeq.get(t.pane_id) ?? 0, t.seq));
    }
  }

  const deps: RunnerDeps = {
    transport: herdrTransport(options),
    waitTimeoutMs: config.waitTimeoutMs,
    logMaxBytes: config.logMaxBytes,
    stopGraceMs: config.stopGraceMs,
  };

  // stopOnSettle script resolution is cached per (worktree root,
  // project id) — candidates are grouped before resolving.
  const stopResolutionCache = new Map<string, ResolvedScript[] | { error: string }>();

  for (const t of items) {
    if (t.kind !== "settled") continue;

    // Within-batch collapse: a later cleared/restored for the same pane
    // means the net effect is un-settled.
    if ((supersedeSeq.get(t.pane_id) ?? 0) > t.seq) {
      settleSkip(report, t, "settle_superseded");
      continue;
    }

    // Idempotency: a run already fired for this exact transition seq
    // (crash between execute and cursor advance) is never re-fired.
    if (firedTransitionSeqs.has(t.seq)) {
      settleSkip(report, t, "already_fired");
      continue;
    }

    // 1. cwd → repo group identity (the #180 path).
    const cwd = t.cwd;
    if (cwd === undefined || cwd === "") {
      settleSkip(report, t, "cwd_unavailable");
      continue;
    }
    if (!existsSync(cwd)) {
      settleSkip(report, t, "cwd_gone", cwd);
      continue;
    }
    let info: RepoInfo;
    try {
      info = await resolveRepo(cwd, gitOptions);
    } catch (err) {
      settleSkip(report, t, err instanceof GitError ? err.kind : "repo_unreachable");
      continue;
    }
    const worktreeRoot = canonicalRepoRoot(info.root);
    const commonDir = canonicalRepoRoot(info.gitCommonDir);

    const fresh = await loadState();
    const match = await matchProject(fresh, commonDir, timeoutMs);
    if ("reason" in match) {
      settleSkip(report, t, match.reason, match.detail);
      continue;
    }
    const project = match.project;

    // 2. Layered script resolution on the settled pane's worktree root —
    //    upstream runs the script in the settled thread's checkout.
    const resolved = await resolveScriptsSafe(worktreeRoot, project.id, envDefault);
    if (!resolved.ok) {
      settleSkip(report, t, resolved.kind, resolved.message);
      continue;
    }

    // 3. stopOnSettle FIRST (pre-drain run snapshot): running runs on
    //    the SAME worktree root whose re-resolved script has the flag.
    const stopCandidates = Object.values(runsBefore.runs).filter(
      (r) => r.result === "running" && canonicalRepoRoot(r.repo.root) === worktreeRoot,
    );
    const byProject = new Map<string, ScriptRun[]>();
    for (const r of stopCandidates) {
      const list = byProject.get(r.project_id) ?? [];
      list.push(r);
      byProject.set(r.project_id, list);
    }
    for (const [projectId, runs] of byProject) {
      const cacheKey = `${worktreeRoot} ${projectId}`;
      let scripts = stopResolutionCache.get(cacheKey);
      if (scripts === undefined) {
        const again = await resolveScriptsSafe(worktreeRoot, projectId, envDefault);
        scripts = again.ok ? again.scripts : { error: `${again.kind}: ${again.message}` };
        stopResolutionCache.set(cacheKey, scripts);
      }
      if (!Array.isArray(scripts)) {
        settleSkip(report, t, "stop_script_resolution_failed", scripts.error);
        continue;
      }
      for (const run of runs) {
        const script =
          scripts.find((s) => s.id === run.script.id) ??
          scripts.find((s) => s.name === run.script.name);
        if (script?.stopOnSettle !== true) continue;
        try {
          const outcomes = await stopRuns(run.run_id, deps);
          for (const outcome of outcomes) {
            report.stopped.push({
              run_id: outcome.run.run_id,
              project_id: outcome.run.project_id,
              script: outcome.run.script.name,
              pane_id: outcome.run.pane_id,
              action: outcome.action,
              transition_seq: t.seq,
            });
          }
        } catch (err) {
          settleSkip(report, t, "stop_failed", err instanceof Error ? err.message : String(err));
        }
      }
    }

    // 4. runOnSettle fires through the unchanged ADR-0010 runner.
    const flagged = resolved.scripts.filter((s) => s.runOnSettle === true);
    if (flagged.length === 0) {
      settleSkip(report, t, "no_run_on_settle_scripts");
      continue;
    }
    let remote: string | null = null;
    try {
      remote = await repoRemoteIdentity(worktreeRoot, gitOptions);
    } catch {
      remote = null;
    }
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
              kind: INBOX_SETTLED_SOURCE,
              pane_id: t.pane_id,
              transition_seq: t.seq,
              transition_at: t.at,
            },
          },
          deps,
        );
        firedTransitionSeqs.add(t.seq);
        report.fired.push({
          run_id: run.run_id,
          project_id: project.id,
          script: script.name,
          worktree_path: worktreeRoot,
          result: run.result,
          source: INBOX_SETTLED_SOURCE,
          pane_id: t.pane_id,
          transition_seq: t.seq,
        });
      } catch (err) {
        if (isConnectionError(err)) {
          settleSkip(
            report,
            t,
            "session_unreachable",
            err instanceof Error ? err.message : String(err),
          );
        } else {
          settleSkip(
            report,
            t,
            "run_start_failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  // Cursor advances to head ONLY after the batch is processed. A
  // mid-batch crash replays the un-acked tail; the transition_seq dedupe
  // above absorbs the replay.
  await updateState((s) => {
    if (s.settle_cursors === undefined) s.settle_cursors = {};
    s.settle_cursors[sessionKey] = headSeqAfter;
  });
  report.cursor_after = headSeqAfter;
  return report;
}
