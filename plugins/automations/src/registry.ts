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
import {
  AutomationsError,
  assertOnceInFuture,
  CONTRACT,
  type DerivedMissedRun,
  type Destination,
  deriveMissed,
  type MisfirePolicy,
  nextOccurrenceAfter,
  parseDestination,
  parseSchedule,
  type RunRecord,
  type RunStatus,
  type RunView,
  type Schedule,
  type TaskRecord,
  type TaskView,
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
  return Object.values(registry.tasks)
    .filter((task) => options.enabled === undefined || task.enabled === options.enabled)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((task) => viewTask(task, runs, options.nowMs));
}

export function taskView(registry: SessionRegistry, taskId: string, nowMs: number): TaskView {
  const task = getTask(registry, taskId);
  return viewTask(task, Object.values(registry.runs), nowMs);
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
 * idempotency key (contract §Idempotency). Execution/delivery is the
 * #145 run path; until then the record honestly stays `scheduled`.
 */
export function runNow(registry: SessionRegistry, taskId: string, nowMs: number): RunRecord {
  const task = getTask(registry, taskId);
  const now = iso(nowMs);
  const run: RunRecord = {
    contract: CONTRACT,
    run_id: `run_${randomUUID()}`,
    task_id: task.task_id,
    trigger: "manual",
    scheduled_for: null,
    status: "scheduled",
    created_at: now,
    started_at: null,
    finished_at: null,
    destination_snapshot: structuredClone(task.destination) as Record<string, unknown>,
    result: null,
    error: null,
  };
  registry.runs[run.run_id] = run;
  task.updated_at = now;
  return run;
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
  options: { taskId?: string | undefined; nowMs: number },
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

// Re-exported for cli convenience / tests.
export { nextOccurrenceAfter, parseSchedule, parseDestination };
export type { Destination, Schedule, TaskRecord, TaskView, RunRecord, RunView };
