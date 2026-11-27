/**
 * Registry operations for rebuildup.automations (#144): task CRUD,
 * pause/resume, manual run records, run history with lazy missed-run
 * derivation, and missed materialization for `reconcile`.
 *
 * All functions are synchronous and take `nowMs` explicitly — the CLI
 * supplies the wall clock, tests supply a fake clock. Persistence and
 * locking live in state.ts (`updateState`); callers invoke these
 * inside the mutation callback so every write is serialized.
 */

import { randomUUID } from "node:crypto";
import { markMatchesSchedule } from "./events";
import {
  AutomationsError,
  assertOnceInFuture,
  CONTRACT,
  type DerivedMissedRun,
  type Destination,
  type DriverRecord,
  deriveMissed,
  isOccurrenceInstant,
  MAX_PENDING_EVENTS,
  MISSED_GRACE_MS,
  type MisfirePolicy,
  nextOccurrenceAfter,
  type PendingEventMark,
  parseDestination,
  parseSchedule,
  type RunRecord,
  type RunStatus,
  type RunTrigger,
  type RunView,
  resolveDriverState,
  type Schedule,
  type TaskRecord,
  type TaskView,
  tickPlan,
  viewTask,
} from "./model";
import type { SessionRegistry } from "./state";

export { CONTRACT };

const DEFAULT_RUN_LIMIT = 100;
const MAX_RUN_LIMIT = 1000;

export interface CreateTaskInput {
  name: string;
  prompt: string;
  schedule: unknown;
  destination: unknown;
  misfire?: MisfirePolicy | undefined;
  enabled?: boolean | undefined;
  created_by?: string | undefined;
}

export interface UpdateTaskInput {
  name?: string | undefined;
  prompt?: string | undefined;
  schedule?: unknown;
  destination?: unknown;
  misfire?: MisfirePolicy | undefined;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AutomationsError("invalid_task", `${field} must be a non-empty string`);
  }
  return value;
}

function taskNotFound(taskId: string): AutomationsError {
  return new AutomationsError("task_not_found", `unknown task_id '${taskId}'`, taskId);
}

export function getTask(registry: SessionRegistry, taskId: string): TaskRecord {
  const task = registry.tasks[taskId];
  if (!task) throw taskNotFound(taskId);
  return task;
}

/** Runs belonging to one task (stored records only). */
export function taskRuns(registry: SessionRegistry, taskId: string): RunRecord[] {
  return Object.values(registry.runs).filter((run) => run.task_id === taskId);
}

/** Idempotency key per contract §Idempotency: `task_id + scheduled_for`. */
export function occurrenceKey(taskId: string, scheduledFor: string): string {
  return `${taskId}${scheduledFor}`;
}

/** First stored run matching the idempotency key, if any. */
export function findRunByOccurrence(
  registry: SessionRegistry,
  taskId: string,
  scheduledFor: string,
): RunRecord | null {
  for (const run of Object.values(registry.runs)) {
    if (run.task_id === taskId && run.scheduled_for === scheduledFor) return run;
  }
  return null;
}

/** ALL stored runs matching the idempotency key (a retried fire adds a second record). */
export function findRunsByOccurrence(
  registry: SessionRegistry,
  taskId: string,
  scheduledFor: string,
): RunRecord[] {
  return Object.values(registry.runs).filter(
    (run) => run.task_id === taskId && run.scheduled_for === scheduledFor,
  );
}

/**
 * Statuses that make a `task_id + scheduled_for` fire a no-op
 * (contract §Idempotency). `missed | skipped | cancelled` do NOT
 * block — they record a declined/absent attempt, and an explicit
 * later fire is a legitimate retry.
 */
export const BLOCKING_RUN_STATUSES: readonly RunStatus[] = [
  "scheduled",
  "running",
  "success",
  "failed",
];

function existingBlockingRun(
  registry: SessionRegistry,
  taskId: string,
  scheduledFor: string,
): RunRecord | null {
  for (const run of findRunsByOccurrence(registry, taskId, scheduledFor)) {
    if (BLOCKING_RUN_STATUSES.includes(run.status)) return run;
  }
  return null;
}

/**
 * Create a run record and bump task bookkeeping (`last_run_at`,
 * `run_count`). Used by `run-now`, `fire`, and `tick`. `missed`
 * materialization (`materializeMissed`) deliberately does NOT count —
 * a missed occurrence never ran.
 */
export function createRunRecord(
  registry: SessionRegistry,
  task: TaskRecord,
  options: {
    trigger: RunTrigger;
    scheduledFor: string | null;
    nowMs: number;
    status?: RunStatus | undefined;
    error?: { code: string; message: string } | null | undefined;
  },
): RunRecord {
  const now = iso(options.nowMs);
  const status = options.status ?? "scheduled";
  const run: RunRecord = {
    contract: CONTRACT,
    run_id: `run_${randomUUID()}`,
    task_id: task.task_id,
    trigger: options.trigger,
    scheduled_for: options.scheduledFor,
    status,
    created_at: now,
    started_at: status === "scheduled" ? null : now,
    finished_at:
      status === "success" || status === "failed" || status === "skipped" || status === "missed"
        ? now
        : status === "cancelled"
          ? now
          : null,
    destination_snapshot: structuredClone(task.destination) as Record<string, unknown>,
    result: null,
    error: options.error ?? null,
  };
  registry.runs[run.run_id] = run;
  task.last_run_at = now;
  task.run_count += 1;
  task.updated_at = now;
  return run;
}

/**
 * Advance the interval grid anchor to a fired occurrence
 * (contract: "anchored at the task's last fired occurrence"). Only
 * moves forward; non-interval schedules ignore it.
 */
export function advanceIntervalAnchor(
  registry: SessionRegistry,
  taskId: string,
  firedMs: number,
): void {
  const task = registry.tasks[taskId];
  if (!task || task.schedule.type !== "interval") return;
  const firedIso = iso(firedMs);
  if (firedIso > task.schedule_anchor_at) task.schedule_anchor_at = firedIso;
}

export function createTask(
  registry: SessionRegistry,
  input: CreateTaskInput,
  nowMs: number,
): TaskRecord {
  const schedule = parseSchedule(input.schedule);
  assertOnceInFuture(schedule, nowMs);
  const destination = parseDestination(input.destination);
  const enabled = input.enabled ?? true;
  const now = iso(nowMs);
  const task: TaskRecord = {
    contract: CONTRACT,
    task_id: `task_${randomUUID()}`,
    name: requireNonEmpty(input.name, "name"),
    prompt: requireNonEmpty(input.prompt, "prompt"),
    schedule,
    enabled,
    misfire: input.misfire ?? "skip",
    destination,
    created_by: input.created_by ?? "cli",
    created_at: now,
    updated_at: now,
    enabled_at: now,
    disabled_at: enabled ? null : now,
    schedule_anchor_at: now,
    last_run_at: null,
    run_count: 0,
  };
  registry.tasks[task.task_id] = task;
  return task;
}

export function listTaskViews(
  registry: SessionRegistry,
  options: { enabled?: boolean | undefined; nowMs: number },
): TaskView[] {
  const runs = Object.values(registry.runs);
  const driver = registryDriverState(registry);
  return Object.values(registry.tasks)
    .filter((task) => options.enabled === undefined || task.enabled === options.enabled)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((task) => viewTask(task, runs, options.nowMs, driver));
}

export function taskView(registry: SessionRegistry, taskId: string, nowMs: number): TaskView {
  const task = getTask(registry, taskId);
  return viewTask(task, Object.values(registry.runs), nowMs, registryDriverState(registry));
}

export function updateTask(
  registry: SessionRegistry,
  taskId: string,
  input: UpdateTaskInput,
  nowMs: number,
): TaskRecord {
  const task = getTask(registry, taskId);
  const now = iso(nowMs);
  let scheduleChanged = false;
  if (input.name !== undefined) task.name = requireNonEmpty(input.name, "name");
  if (input.prompt !== undefined) task.prompt = requireNonEmpty(input.prompt, "prompt");
  if (input.schedule !== undefined) {
    const schedule = parseSchedule(input.schedule);
    assertOnceInFuture(schedule, nowMs);
    task.schedule = schedule;
    scheduleChanged = true;
  }
  if (input.destination !== undefined) {
    task.destination = parseDestination(input.destination);
  }
  if (input.misfire !== undefined) {
    if (input.misfire !== "skip" && input.misfire !== "run_once") {
      throw new AutomationsError("invalid_task", "misfire must be 'skip' or 'run_once'");
    }
    task.misfire = input.misfire;
  }
  if (scheduleChanged) {
    // A changed schedule starts a fresh occurrence grid anchored at the
    // update instant (documented in model.ts `schedule_anchor_at`).
    task.schedule_anchor_at = now;
  }
  task.updated_at = now;
  return task;
}

export function setTaskEnabled(
  registry: SessionRegistry,
  taskId: string,
  enabled: boolean,
  nowMs: number,
): TaskRecord {
  const task = getTask(registry, taskId);
  const now = iso(nowMs);
  if (task.enabled === enabled) {
    task.updated_at = now;
    return task;
  }
  if (!enabled) {
    // Pause flushes owed missed occurrences into real run records
    // BEFORE the owed window closes at disabled_at — otherwise a
    // resume would silently forgive occurrences that earlier reads
    // already reported as missed (deterministic-read invariant).
    materializeMissed(registry, { taskId, nowMs });
  }
  task.enabled = enabled;
  task.updated_at = now;
  if (enabled) {
    task.enabled_at = now;
    task.disabled_at = null;
  } else {
    task.disabled_at = now;
  }
  return task;
}

/**
 * Delete a task and all of its run records. Returns the removed ids so
 * the CLI can report honestly. Unknown id → `task_not_found`.
 */
export function deleteTask(
  registry: SessionRegistry,
  taskId: string,
): { task_id: string; runs_removed: number } {
  getTask(registry, taskId);
  let runsRemoved = 0;
  for (const [runId, run] of Object.entries(registry.runs)) {
    if (run.task_id === taskId) {
      delete registry.runs[runId];
      runsRemoved += 1;
    }
  }
  delete registry.tasks[taskId];
  return { task_id: taskId, runs_removed: runsRemoved };
}

/**
 * `run-now`: record an explicit manual run (`trigger:"manual"`,
 * `scheduled_for:null`, status `scheduled`) — distinct from scheduled
 * occurrences and never colliding with the `task_id+scheduled_for`
 * idempotency key (contract §Idempotency). The CLI then runs it
 * through the same delivery path as `fire` (`startRun` → deliver →
 * `finalizeRun`).
 */
export function runNow(registry: SessionRegistry, taskId: string, nowMs: number): RunRecord {
  const task = getTask(registry, taskId);
  return createRunRecord(registry, task, {
    trigger: "manual",
    scheduledFor: null,
    nowMs,
    status: "scheduled",
  });
}

export interface ListRunsOptions {
  taskId?: string | undefined;
  status?: RunStatus | undefined;
  /** Include lazily-derived missed occurrences (default true). */
  includeMissed?: boolean | undefined;
  limit?: number | undefined;
  nowMs: number;
}

/**
 * Run history, newest first by effective instant
 * (`scheduled_for` ?? `created_at`). Stored runs merge with derived
 * `missed` entries (run_id null, `derived:true`) unless
 * `includeMissed:false` or `--stored-only` semantics are requested.
 */
export function listRuns(registry: SessionRegistry, options: ListRunsOptions): RunView[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_RUN_LIMIT, 1), MAX_RUN_LIMIT);
  const allRuns = Object.values(registry.runs);
  const stored = allRuns
    .filter((run) => options.taskId === undefined || run.task_id === options.taskId)
    .filter((run) => options.status === undefined || run.status === options.status);
  const views: RunView[] = [...stored];
  const includeMissed = options.includeMissed ?? true;
  if (includeMissed) {
    const taskIds = options.taskId !== undefined ? [options.taskId] : Object.keys(registry.tasks);
    for (const taskId of taskIds) {
      const task = registry.tasks[taskId];
      if (!task) continue;
      if (options.status !== undefined && options.status !== "missed") continue;
      // Derivation must see ALL of the task's runs — a status/task
      // filter on the output must not fabricate missed occurrences.
      const { missed } = deriveMissed(task, allRuns, options.nowMs);
      views.push(...missed);
    }
  }
  const effectiveMs = (run: RunView): number =>
    run.scheduled_for !== null ? Date.parse(run.scheduled_for) : Date.parse(run.created_at ?? "");
  views.sort((a, b) => effectiveMs(b) - effectiveMs(a));
  return views.slice(0, limit);
}

/**
 * `reconcile`: materialize derived missed occurrences into real `missed`
 * run records (idempotent — existing records for the key are skipped).
 * Returns the number of records written. Runs inside `updateState`.
 */
export function materializeMissed(
  registry: SessionRegistry,
  options: {
    taskId?: string | undefined;
    nowMs: number;
    /**
     * `scheduled_for` instants to leave unresolved — the fire path uses
     * this so the occurrence it is about to run is not ALSO recorded
     * `missed` in the same mutation.
     */
    except?: ReadonlySet<string> | undefined;
  },
): number {
  const now = iso(options.nowMs);
  const stored = Object.values(registry.runs);
  let written = 0;
  const taskIds = options.taskId !== undefined ? [options.taskId] : Object.keys(registry.tasks);
  for (const taskId of taskIds) {
    const task = registry.tasks[taskId];
    if (!task) {
      if (options.taskId !== undefined) throw taskNotFound(taskId);
      continue;
    }
    const { missed } = deriveMissed(task, stored, options.nowMs, Number.MAX_SAFE_INTEGER);
    for (const entry of missed as DerivedMissedRun[]) {
      if (options.except?.has(entry.scheduled_for)) continue;
      // deriveMissed only yields occurrences with no run record, but
      // re-check under the lock for safety.
      if (findRunByOccurrence(registry, taskId, entry.scheduled_for) !== null) continue;
      const run: RunRecord = {
        contract: CONTRACT,
        run_id: `run_${randomUUID()}`,
        task_id: taskId,
        trigger: "schedule",
        scheduled_for: entry.scheduled_for,
        status: "missed",
        created_at: now,
        started_at: null,
        finished_at: now,
        destination_snapshot: structuredClone(task.destination) as Record<string, unknown>,
        result: null,
        error: entry.error,
      };
      registry.runs[run.run_id] = run;
      written += 1;
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Fire / tick run execution (#145)
// ---------------------------------------------------------------------------

export interface FirePrep {
  action: "execute" | "existing";
  run: RunRecord;
  /** True when the occurrence is past the missed grace (misfire territory). */
  late: boolean;
}

/**
 * `fire <task-id> --scheduled-for <ts>` preparation — runs inside
 * `updateState`. Validates the driver-supplied instant against the
 * task's schedule (never trusted), applies the contract idempotency
 * key, and applies the misfire policy to late occurrences:
 *
 * - blocking run exists (`scheduled|running|success|failed`) → return
 *   it unchanged (`action:"existing"`, no duplicate execution);
 * - late + `misfire:"skip"` → record a terminal `skipped` run
 *   (`misfire_skip`), never executed — repeated explicit fires return
 *   the same record;
 * - otherwise → create a `running` run record (delivery happens after
 *   the lock is released; `action:"execute"`) and advance the
 *   interval anchor to the fired occurrence.
 *
 * Transport preflight is the caller's job BEFORE this mutation — a
 * socket failure must leave NO run record (contract §Missed-run).
 */
export function prepareFire(
  registry: SessionRegistry,
  taskId: string,
  scheduledForIso: string,
  nowMs: number,
): FirePrep {
  const task = getTask(registry, taskId);
  const ms = Date.parse(scheduledForIso);
  if (Number.isNaN(ms)) {
    throw new AutomationsError(
      "invalid_occurrence",
      `--scheduled-for '${scheduledForIso}' is not a valid ISO 8601 timestamp`,
      taskId,
    );
  }
  const scheduledFor = new Date(ms).toISOString();
  // Idempotency BEFORE schedule re-validation: the interval anchor
  // advances to the last fired occurrence, so re-firing that same
  // instant would fail `isOccurrenceInstant` (ms == anchor, k=0) even
  // though the key is legitimately spent. Existing records always win.
  const blocking = existingBlockingRun(registry, taskId, scheduledFor);
  if (blocking !== null) return { action: "existing", run: blocking, late: false };
  for (const run of findRunsByOccurrence(registry, taskId, scheduledFor)) {
    if (run.status === "skipped") return { action: "existing", run, late: false };
  }

  if (!isOccurrenceInstant(task, ms)) {
    throw new AutomationsError(
      "invalid_occurrence",
      `instant ${new Date(ms).toISOString()} is not an occurrence of task '${taskId}'s schedule`,
      taskId,
    );
  }
  if (ms > nowMs) {
    throw new AutomationsError(
      "invalid_occurrence",
      `occurrence ${new Date(ms).toISOString()} is in the future — nothing to fire yet`,
      taskId,
    );
  }
  const enabledMs = Date.parse(task.enabled_at);
  const disabledMs = task.disabled_at === null ? null : Date.parse(task.disabled_at);
  if (ms < enabledMs || (disabledMs !== null && ms > disabledMs)) {
    throw new AutomationsError(
      "invalid_occurrence",
      `occurrence ${new Date(ms).toISOString()} is outside the task's enabled window`,
      taskId,
    );
  }
  const late = nowMs - ms > MISSED_GRACE_MS;
  if (late && task.misfire === "skip") {
    const run = createRunRecord(registry, task, {
      trigger: "schedule",
      scheduledFor,
      nowMs,
      status: "skipped",
      error: {
        code: "misfire_skip",
        message: `occurrence ${scheduledFor} fired ${Math.round((nowMs - ms) / 1000)}s late; misfire policy 'skip' declines late runs`,
      },
    });
    return { action: "existing", run, late };
  }

  // Anchor invariant: `schedule_anchor_at` may only advance to a fired
  // occurrence once every earlier owed occurrence is resolved —
  // otherwise pre-anchor occurrences would silently drop out of the
  // owed/missed derivation. Materialize the task's unresolved
  // past-grace occurrences FIRST, excepting the key about to fire.
  materializeMissed(registry, {
    taskId: task.task_id,
    nowMs,
    except: new Set([scheduledFor]),
  });
  const run = createOccurrenceRun(registry, task, ms, nowMs);
  if (run === null) {
    // Lost a race inside the same mutation (defensive; single-writer
    // lock makes this unreachable in practice).
    const again = existingBlockingRun(registry, taskId, scheduledFor);
    if (again !== null) return { action: "existing", run: again, late };
    throw new AutomationsError("error", "failed to create run record", taskId);
  }
  return { action: "execute", run, late };
}

/**
 * Create a `running` scheduled run for a computed occurrence
 * (tick/watch path — the instant comes from `tickPlan`, already
 * validated plugin-side). Idempotent: returns null when a blocking
 * run already exists for the key.
 */
export function createOccurrenceRun(
  registry: SessionRegistry,
  task: TaskRecord,
  occurrenceMs: number,
  nowMs: number,
): RunRecord | null {
  const scheduledFor = iso(occurrenceMs);
  if (existingBlockingRun(registry, task.task_id, scheduledFor) !== null) return null;
  const run = createRunRecord(registry, task, {
    trigger: "schedule",
    scheduledFor,
    nowMs,
    status: "running",
  });
  advanceIntervalAnchor(registry, task.task_id, occurrenceMs);
  return run;
}

export interface TickPrep {
  /** Run records created `running` — the caller delivers each. */
  pending: RunRecord[];
  /** Occurrences materialized as `missed` this tick. */
  missedMaterialized: number;
  /** Tasks scanned. */
  tasksScanned: number;
}

/**
 * `tick` preparation — runs inside `updateState`. For every enabled
 * task: partition due occurrences via `tickPlan`; `misfire:"skip"`
 * late occurrences are materialized `missed` (never executed);
 * `misfire:"run_once"` fires the MOST RECENT late occurrence once
 * (the rest materialize `missed`); on-time occurrences always fire.
 * Returns the `running` records the caller must deliver outside the
 * lock, then finalize via `finalizeRun`.
 */
export function prepareTick(registry: SessionRegistry, nowMs: number): TickPrep {
  const runs = Object.values(registry.runs);
  const prep: TickPrep = { pending: [], missedMaterialized: 0, tasksScanned: 0 };
  for (const task of Object.values(registry.tasks)) {
    if (!task.enabled) continue;
    prep.tasksScanned += 1;
    const plan = tickPlan(task, runs, nowMs);
    if (plan.late.length === 0 && plan.fireNow.length === 0) continue;

    // Reserve the run_once catch-up occurrence BEFORE materializing so
    // it is not also recorded `missed`; everything else owed past the
    // grace becomes a real `missed` record. This ordering preserves
    // the anchor invariant: by the time `createOccurrenceRun` advances
    // `schedule_anchor_at`, every earlier owed occurrence has a record.
    const catchUp =
      task.misfire === "run_once" && plan.late.length > 0
        ? (plan.late[plan.late.length - 1] as number)
        : null;
    prep.missedMaterialized += materializeMissed(registry, {
      taskId: task.task_id,
      nowMs,
      except: catchUp === null ? undefined : new Set([iso(catchUp)]),
    });
    if (catchUp !== null) {
      const run = createOccurrenceRun(registry, task, catchUp, nowMs);
      if (run !== null) prep.pending.push(run);
    }
    for (const ms of plan.fireNow) {
      const run = createOccurrenceRun(registry, task, ms, nowMs);
      if (run !== null) prep.pending.push(run);
    }
  }
  return prep;
}

/**
 * Transition a `scheduled` run to `running` (started_at = now) —
 * the manual `run-now` path uses this before delivery; scheduled
 * fires are created directly as `running`.
 */
export function startRun(registry: SessionRegistry, runId: string, nowMs: number): RunRecord {
  const run = registry.runs[runId];
  if (!run) throw new AutomationsError("error", `unknown run_id '${runId}'`);
  if (run.status === "scheduled") {
    run.status = "running";
    run.started_at = iso(nowMs);
  }
  return run;
}

export interface RunFinal {
  status: "success" | "failed";
  finishedAtMs: number;
  result?: { summary?: string | undefined; agent_status?: string | undefined } | null;
  error?: { code: string; message: string } | null;
  destinationSnapshot?: Record<string, unknown> | null;
}

/**
 * Finalize a `running` run after delivery (`success`/`failed` only —
 * honest observed outcomes; transport errors become `failed` with the
 * captured code, never fabricated success). Unknown/already-terminal
 * runs are left untouched.
 */
export function finalizeRun(registry: SessionRegistry, runId: string, final: RunFinal): RunRecord {
  const run = registry.runs[runId];
  if (!run) throw new AutomationsError("error", `unknown run_id '${runId}'`);
  if (run.status !== "running" && run.status !== "scheduled") {
    return run;
  }
  const now = iso(final.finishedAtMs);
  run.status = final.status;
  run.finished_at = now;
  if (final.result !== undefined) run.result = final.result;
  if (final.error !== undefined) run.error = final.error;
  if (final.destinationSnapshot !== undefined && final.destinationSnapshot !== null) {
    run.destination_snapshot = final.destinationSnapshot;
  }
  const task = registry.tasks[run.task_id];
  if (task) task.updated_at = now;
  return run;
}

// ---------------------------------------------------------------------------
// Event-hook marks and event-trigger drain (#146)
// ---------------------------------------------------------------------------

/**
 * Append hook-received event marks to the registry, capped at
 * `MAX_PENDING_EVENTS` — overflow drops the OLDEST marks and counts
 * them in `pending_events_dropped` (reported honestly, never silent).
 * Called by `src/hook.ts` inside `updateState`.
 */
export function recordPendingEvents(registry: SessionRegistry, marks: PendingEventMark[]): void {
  for (const mark of marks) {
    registry.pending_events.push(mark);
    if (registry.pending_events.length > MAX_PENDING_EVENTS) {
      registry.pending_events.shift();
      registry.pending_events_dropped += 1;
    }
  }
}

/**
 * Run-status observation (#146): a `pane.agent_status_changed` hook
 * folds the observed status into the LATEST delivered run targeting
 * that pane (`destination_snapshot.pane_id`). Only `running`/`success`
 * runs are eligible — `scheduled` has not been delivered yet and
 * terminal-failure runs have no live agent to observe. The recorded
 * value is the pane's observed status, never a fabricated completion:
 * `run.status` stays the delivery outcome and `result.agent_status`
 * is explicitly a pane-level observation (documented in the contract).
 */
export function observeRunAgentStatus(
  registry: SessionRegistry,
  paneId: string,
  agentStatus: string,
  nowMs: number,
): RunRecord | null {
  let best: RunRecord | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const run of Object.values(registry.runs)) {
    if (run.status !== "running" && run.status !== "success") continue;
    const snapshot = run.destination_snapshot;
    if (snapshot === null || snapshot.pane_id !== paneId) continue;
    const ms = Date.parse(run.finished_at ?? run.created_at);
    if (ms > bestMs) {
      bestMs = ms;
      best = run;
    }
  }
  if (best === null) return null;
  best.result = {
    ...(best.result ?? {}),
    agent_status: agentStatus,
    agent_status_at: iso(nowMs),
  };
  return best;
}

export interface EventTickPrep {
  /** `running` event runs the caller must deliver, then finalize. */
  pending: RunRecord[];
  /** Pending marks consumed (matched ≥1 enabled event task). */
  consumed: number;
  /** Bursts that produced a `running` run this drain. */
  fired: number;
  /** Bursts declined by cooldown/max_fires → `skipped` run records. */
  suppressed: number;
  /** Bursts whose idempotency key was already resolved. */
  deduplicated: number;
  /** Marks left pending (matched no enabled event task). */
  remaining: number;
}

/**
 * `tick` event drain (#146) — runs inside `updateState`, after
 * `prepareTick`. For every enabled `event`-schedule task, pending hook
 * marks matching `on` + `filter` inside the task's enabled window are
 * grouped into bursts (`debounce_ms` collapses marks closer than the
 * window into one fire anchored at the burst's FIRST mark), then each
 * burst becomes one run keyed `task_id + scheduled_for` where
 * `scheduled_for` is the burst anchor — the same idempotency
 * discipline as clock occurrences.
 *
 * Suppression is recorded, never silent: `cooldown_ms` (min ms between
 * fire anchors) and `max_fires` (cap on executed event runs) decline a
 * burst into a terminal `skipped` run (`error.code` `cooldown` /
 * `max_fires`). Marks matching no enabled event task stay pending —
 * a later task or filter update may still claim them; the
 * `MAX_PENDING_EVENTS` cap bounds the backlog honestly.
 *
 * Events are ephemeral, NOT owed occurrences: nothing here ever
 * derives `missed`, and a mark consumed by a failed delivery is spent
 * (no automatic retry — same rule as scheduled fires).
 */
export function prepareEventTick(registry: SessionRegistry, nowMs: number): EventTickPrep {
  const prep: EventTickPrep = {
    pending: [],
    consumed: 0,
    fired: 0,
    suppressed: 0,
    deduplicated: 0,
    remaining: registry.pending_events.length,
  };
  const marks = registry.pending_events;
  if (marks.length === 0) return prep;
  const eventTasks = Object.values(registry.tasks).filter(
    (task) => task.enabled && task.schedule.type === "event",
  );
  if (eventTasks.length === 0) return prep;

  const inWindow = (task: TaskRecord, ms: number): boolean => {
    if (ms < Date.parse(task.enabled_at)) return false;
    if (task.disabled_at !== null && ms > Date.parse(task.disabled_at)) return false;
    return true;
  };

  const consumed = new Set<number>();
  for (const task of eventTasks) {
    const schedule = task.schedule;
    if (schedule.type !== "event") continue;
    const filter = schedule.filter as Record<string, string | undefined> | undefined;
    const matched: { index: number; ms: number }[] = [];
    marks.forEach((mark, index) => {
      const ms = Date.parse(mark.received_at);
      if (!inWindow(task, ms)) return;
      if (!markMatchesSchedule(mark, schedule.on, filter)) return;
      matched.push({ index, ms });
      consumed.add(index);
    });
    if (matched.length === 0) continue;
    matched.sort((a, b) => a.ms - b.ms || a.index - b.index);

    // Debounce: a mark joins the open burst while it arrives within
    // `debounce_ms` of the previous matched mark; otherwise it anchors
    // a new burst. Anchor = first mark's received_at (deterministic).
    const debounceMs = schedule.debounce_ms ?? 0;
    const anchors: number[] = [];
    let previousMs = Number.NEGATIVE_INFINITY;
    for (const mark of matched) {
      if (anchors.length === 0 || mark.ms - previousMs > debounceMs) {
        anchors.push(mark.ms);
      }
      previousMs = mark.ms;
    }

    // Cooldown baseline = anchors of EXECUTED event fires (blocking
    // statuses); declined `skipped` records never extend it.
    const executed = Object.values(registry.runs).filter(
      (run) =>
        run.task_id === task.task_id &&
        run.trigger === "event" &&
        run.scheduled_for !== null &&
        BLOCKING_RUN_STATUSES.includes(run.status),
    );
    let lastAnchorMs = Number.NEGATIVE_INFINITY;
    for (const run of executed) {
      const ms = Date.parse(run.scheduled_for as string);
      if (ms > lastAnchorMs) lastAnchorMs = ms;
    }
    let executedCount = executed.length;
    const cooldownMs = schedule.cooldown_ms ?? 0;
    const maxFires = schedule.max_fires;

    for (const anchorMs of anchors) {
      const anchorIso = iso(anchorMs);
      // Any stored record for the key spends it — including skipped
      // (a declined burst is never silently retried).
      if (findRunsByOccurrence(registry, task.task_id, anchorIso).length > 0) {
        prep.deduplicated += 1;
        continue;
      }
      let decline: { code: string; message: string } | null = null;
      if (cooldownMs > 0 && lastAnchorMs !== Number.NEGATIVE_INFINITY) {
        if (anchorMs - lastAnchorMs < cooldownMs) {
          decline = {
            code: "cooldown",
            message:
              `event burst ${anchorIso} is ${anchorMs - lastAnchorMs}ms after the last fire; ` +
              `cooldown_ms ${cooldownMs} declines it`,
          };
        }
      }
      if (decline === null && maxFires !== undefined && executedCount >= maxFires) {
        decline = {
          code: "max_fires",
          message:
            `event task '${task.task_id}' reached max_fires ${maxFires}; ` +
            `burst ${anchorIso} declined`,
        };
      }
      if (decline !== null) {
        createRunRecord(registry, task, {
          trigger: "event",
          scheduledFor: anchorIso,
          nowMs,
          status: "skipped",
          error: decline,
        });
        prep.suppressed += 1;
        continue;
      }
      const run = createRunRecord(registry, task, {
        trigger: "event",
        scheduledFor: anchorIso,
        nowMs,
        status: "running",
      });
      prep.pending.push(run);
      prep.fired += 1;
      // Later bursts in THIS drain respect the just-created fire.
      lastAnchorMs = anchorMs;
      executedCount += 1;
    }
  }

  if (consumed.size > 0) {
    registry.pending_events = registry.pending_events.filter((_, index) => !consumed.has(index));
  }
  prep.consumed = consumed.size;
  prep.remaining = registry.pending_events.length;
  return prep;
}

// ---------------------------------------------------------------------------
// Driver records (#145)
// ---------------------------------------------------------------------------

export function upsertDriver(registry: SessionRegistry, driver: DriverRecord): void {
  registry.drivers[driver.driver_id] = driver;
}

export function removeDriver(registry: SessionRegistry, driverId: string): boolean {
  if (!(driverId in registry.drivers)) return false;
  delete registry.drivers[driverId];
  return true;
}

/** Honest driver coverage for task views (see model.resolveDriverState). */
export function registryDriverState(registry: SessionRegistry): { state: string; detail: string } {
  return resolveDriverState(Object.values(registry.drivers));
}

export type { Destination, RunRecord, RunView, Schedule, TaskRecord, TaskView };
// Re-exported for cli convenience / tests.
export { nextOccurrenceAfter, parseDestination, parseSchedule };
