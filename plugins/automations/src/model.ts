/**
 * Task/run model for rebuildup.automations — contract
 * `herdr-plugins.automations/v1` (DRAFT, Issue #144 / parent #32 T2).
 *
 * Pure functions only: schedule schema validation, deterministic
 * occurrence computation, missed-run derivation, and record/view
 * shaping. No I/O, no clock — every function takes `now` explicitly so
 * contract tests run on a fake clock (ADR-0022: the plugin holds no
 * time; reads resolve missed occurrences deterministically).
 */

export const CONTRACT = "herdr-plugins.automations/v1";
export const PLUGIN_ID = "rebuildup.automations";
export const STATE_SCHEMA_VERSION = 1;

/** Upstream parity: T3 `MIN_SCHEDULED_TASK_INTERVAL_MS`. */
export const MIN_INTERVAL_MS = 60_000;

/**
 * Occurrences younger than this are "in flight", not `missed`: every v1
 * driver ticks at ≤ 60 s (ADR-0022 jitter bound), so a just-passed
 * occurrence may still be fired legitimately. Deterministic and
 * documented — never a hidden grace.
 */
export const MISSED_GRACE_MS = 60_000;

/** Cap on missed occurrences reported/materialized per task per read. */
export const MAX_MISSED_REPORTED = 200;

/**
 * Bound on occurrence instants materialized for missed derivation per
 * task. Owed totals stay exact (interval is arithmetic, fixed_time is
 * day-bounded); only the reported `missed` list is capped — see
 * `deriveMissed`.
 */
const MISSED_SCAN_LIMIT = 5_000;

/** Cap on how far back fixed_time enumeration scans for owed occurrences. */
const MAX_FIXED_TIME_DAYS_BACK = 3660;

export const MISFIRE_POLICIES = ["skip", "run_once"] as const;
export type MisfirePolicy = (typeof MISFIRE_POLICIES)[number];

export const RUN_STATUSES = [
  "scheduled",
  "running",
  "success",
  "failed",
  "skipped",
  "cancelled",
  "missed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ["schedule", "manual", "event", "webhook"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * Schedule types accepted for storage. `webhook` is permanently
 * unsupported in v1 (ADR-0026 — herdr has no inbound HTTP path and
 * an opt-in listener would violate ADR-0002): it may appear in
 * stored tasks but `create`/`update` MUST reject it with
 * `unsupported_schedule`. `event` is implemented by #146.
 */
export const RESERVED_SCHEDULE_TYPES = ["webhook"] as const;

/**
 * herdr `[[events]]` hook event names an `event` schedule may subscribe
 * to — the upstream `PLUGIN_HOOK_EVENT_KINDS` set (herdrdev/herdr
 * src/api/schema/events.rs, pinned @ e8d7d97). Dotted form only; the
 * wire envelope may serialize snake_case and is normalized by the hook.
 * Coverage is version-dependent: an `on` name the running herdr does
 * not dispatch simply never produces marks — never reported as fired.
 */
export const HOOK_EVENT_NAMES = [
  "workspace.created",
  "workspace.updated",
  "workspace.closed",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.moved",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "pane.agent_status_changed",
] as const;

/** herdr `AgentStatus` values usable in `event.filter.agent_status`. */
export const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;

/** Optional `event` schedule filter — every set field must match. */
export interface EventScheduleFilter {
  pane_id?: string | undefined;
  tab_id?: string | undefined;
  workspace_id?: string | undefined;
  agent?: string | undefined;
  agent_status?: string | undefined;
}

export type Schedule =
  | { type: "interval"; every_ms: number }
  | {
      type: "fixed_time";
      time_of_day: string;
      weekdays?: number[] | undefined;
      time_zone?: string | undefined;
    }
  | { type: "once"; run_at: string }
  | {
      type: "event";
      on: string;
      filter?: EventScheduleFilter | undefined;
      /** Collapse matching marks within this window into one fire. */
      debounce_ms?: number | undefined;
      /** Minimum ms between consecutive event fires (anchor-to-anchor). */
      cooldown_ms?: number | undefined;
      /** Lifetime cap on executed event fires. */
      max_fires?: number | undefined;
    };

export type Destination =
  | { kind: "pane"; pane_id: string }
  | {
      kind: "launch";
      surface: { workspace_id: string } | { new_workspace: true } | { tab_id: string };
      agent: string;
      launch_args?: string[] | undefined;
      via?: "direct" | "handoff-execute" | undefined;
      handoff_record_id?: string | undefined;
    };

export interface TaskRecord {
  contract: typeof CONTRACT;
  task_id: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  misfire: MisfirePolicy;
  destination: Destination;
  created_by: string;
  created_at: string;
  updated_at: string;
  /**
   * Wall-clock of the most recent transition to `enabled: true`
   * (create counts). Occurrences earlier than this are not owed —
   * occurrences during disabled periods are never reported `missed`.
   */
  enabled_at: string;
  /**
   * Wall-clock of the most recent transition to `enabled: false`;
   * null while enabled. Closes the owed-occurrence window.
   */
  disabled_at: string | null;
  /**
   * Interval grid origin (ISO instant): `created_at` initially,
   * advanced by the #145 fire path to the last fired `scheduled_for`
   * (contract: "anchored at the task's last fired occurrence"). A
   * schedule `update` resets it to the update time — a changed
   * schedule starts a fresh grid.
   */
  schedule_anchor_at: string;
  last_run_at: string | null;
  run_count: number;
}

export interface RunRecord {
  contract: typeof CONTRACT;
  run_id: string;
  task_id: string;
  trigger: RunTrigger;
  /** Occurrence instant; null for trigger="manual". */
  scheduled_for: string | null;
  status: RunStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  destination_snapshot: Record<string, unknown> | null;
  /** Observed values only — never fabricated (AGENTS §4). */
  result: {
    summary?: string | undefined;
    agent_status?: string | undefined;
    /** Wall-clock of the latest hook-observed `agent_status` on the destination pane. */
    agent_status_at?: string | undefined;
  } | null;
  error: { code: string; message: string } | null;
}

/**
 * A lazily-derived missed occurrence merged into `runs` output. Not a
 * stored record: `run_id` is null and `derived` is true. `reconcile`
 * materializes these into real `missed` run records.
 */
export interface DerivedMissedRun {
  contract: typeof CONTRACT;
  run_id: null;
  task_id: string;
  trigger: "schedule";
  scheduled_for: string;
  status: "missed";
  derived: true;
  created_at: null;
  started_at: null;
  finished_at: null;
  destination_snapshot: null;
  result: null;
  error: { code: "missed"; message: string };
}

export type RunView = RunRecord | DerivedMissedRun;

/**
 * One herdr lifecycle event recorded by the `[[events]]` hook entrypoint
 * (`src/hook.ts`), awaiting lazy drain by the next `tick` (#146). Events
 * are ephemeral: they are NOT owed occurrences — marks beyond the
 * pending cap are dropped (counted), and events herdr never delivered
 * simply never exist. `received_at` is the hook's receipt wall clock;
 * `data` is the raw EventData payload (snake_case `type` tag included).
 */
export interface PendingEventMark {
  /** Canonical dotted hook name (e.g. `pane.agent_status_changed`). */
  event: string;
  received_at: string;
  data: Record<string, unknown>;
}

/** Derived read-side fields on a task (never stored). */
export interface TaskView extends TaskRecord {
  next_run_at: string | null;
  driver: { state: string; detail: string };
  /** Owed occurrences already past the missed grace, stored or not. */
  missed_total: number;
  missed_truncated: boolean;
}

/**
 * Driver coverage states reported on task views (contract §Task record).
 * `none` — no driver has ever reported; `install_failed` — an
 * `schedule install` attempt recorded an error; `stale` — a driver
 * record exists but its evidence is gone (dead watch pid, missing OS
 * entry).
 */
export const DRIVER_STATES = ["os-scheduler", "watch", "none", "install_failed", "stale"] as const;
export type DriverState = (typeof DRIVER_STATES)[number];

/**
 * Persisted driver record (#145): written by `watch` (pid + heartbeat)
 * and `schedule install|status` (OS entry metadata). At most one record
 * per `driver_id` (`"watch"`, `"os-scheduler"`).
 */
export interface DriverRecord {
  contract: typeof CONTRACT;
  driver_id: string;
  kind: "watch" | "os-scheduler";
  /** watch: "active"; os-scheduler: "installed" | "error" | "stale". */
  status: string;
  detail: string;
  pid: number | null;
  platform: string | null;
  entry: string | null;
  installed_at: string | null;
  updated_at: string;
}

export class AutomationsError extends Error {
  readonly code: string;
  readonly taskId: string | undefined;

  constructor(code: string, message: string, taskId?: string) {
    super(message);
    this.name = "AutomationsError";
    this.code = code;
    this.taskId = taskId;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AutomationsError("invalid_schedule", `schedule.${field} must be a non-empty string`);
  }
  return value;
}

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Schema-validate a schedule. `type` missing/unknown → `invalid_schedule`;
 * unsupported types (`webhook` — ADR-0026) → `unsupported_schedule`
 * (contract §Error model).
 */
export function parseSchedule(raw: unknown): Schedule {
  if (!isRecord(raw)) {
    throw new AutomationsError("invalid_schedule", "schedule must be an object");
  }
  const type = raw.type;
  if (typeof type !== "string" || type.length === 0) {
    throw new AutomationsError("invalid_schedule", "schedule.type is required");
  }
  if ((RESERVED_SCHEDULE_TYPES as readonly string[]).includes(type)) {
    throw new AutomationsError(
      "unsupported_schedule",
      `schedule type '${type}' is unsupported in v1 (webhook is an upstream gap, ADR-0026) and cannot be created or updated`,
    );
  }
  switch (type) {
    case "interval": {
      const every = raw.every_ms;
      if (typeof every !== "number" || !Number.isFinite(every) || every < MIN_INTERVAL_MS) {
        throw new AutomationsError(
          "invalid_schedule",
          `interval.every_ms must be a number >= ${MIN_INTERVAL_MS}`,
        );
      }
      return { type: "interval", every_ms: Math.floor(every) };
    }
    case "fixed_time": {
      const timeOfDay = reqString(raw.time_of_day, "time_of_day");
      if (!TIME_OF_DAY_RE.test(timeOfDay)) {
        throw new AutomationsError(
          "invalid_schedule",
          "fixed_time.time_of_day must be HH:MM (24h)",
        );
      }
      const out: {
        type: "fixed_time";
        time_of_day: string;
        weekdays?: number[] | undefined;
        time_zone?: string | undefined;
      } = { type: "fixed_time", time_of_day: timeOfDay };
      if (raw.weekdays !== undefined) {
        if (
          !Array.isArray(raw.weekdays) ||
          raw.weekdays.length === 0 ||
          raw.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
        ) {
          throw new AutomationsError(
            "invalid_schedule",
            "fixed_time.weekdays must be a non-empty array of integers 0(Sunday)..6(Saturday)",
          );
        }
        out.weekdays = [...new Set(raw.weekdays as number[])].sort((a, b) => a - b);
      }
      if (raw.time_zone !== undefined) {
        const tz = reqString(raw.time_zone, "time_zone");
        if (!validTimeZone(tz)) {
          throw new AutomationsError(
            "invalid_schedule",
            `fixed_time.time_zone '${tz}' is not a valid IANA time zone name`,
          );
        }
        out.time_zone = tz;
      }
      return out;
    }
    case "once": {
      const runAt = reqString(raw.run_at, "run_at");
      const ms = Date.parse(runAt);
      if (Number.isNaN(ms)) {
        throw new AutomationsError("invalid_schedule", "once.run_at must be an ISO 8601 timestamp");
      }
      // Offset (or Z) is mandatory — a bare local datetime is ambiguous.
      if (!/(Z|[+-]\d{2}:?\d{2})$/.test(runAt)) {
        throw new AutomationsError(
          "invalid_schedule",
          "once.run_at must include an explicit UTC offset",
        );
      }
      return { type: "once", run_at: new Date(ms).toISOString() };
    }
    case "event": {
      const on = reqString(raw.on, "on");
      if (!(HOOK_EVENT_NAMES as readonly string[]).includes(on)) {
        throw new AutomationsError(
          "invalid_schedule",
          `event.on '${on}' is not a herdr plugin-hook event — ` +
            `supported: ${HOOK_EVENT_NAMES.join(", ")}`,
        );
      }
      const out: {
        type: "event";
        on: string;
        filter?: EventScheduleFilter | undefined;
        debounce_ms?: number | undefined;
        cooldown_ms?: number | undefined;
        max_fires?: number | undefined;
      } = { type: "event", on };
      if (raw.filter !== undefined) {
        if (!isRecord(raw.filter)) {
          throw new AutomationsError("invalid_schedule", "event.filter must be an object");
        }
        const filter: EventScheduleFilter = {};
        for (const key of ["pane_id", "tab_id", "workspace_id", "agent"] as const) {
          const value = raw.filter[key];
          if (value === undefined) continue;
          if (typeof value !== "string" || value.length === 0) {
            throw new AutomationsError(
              "invalid_schedule",
              `event.filter.${key} must be a non-empty string`,
            );
          }
          filter[key] = value;
        }
        const status = raw.filter.agent_status;
        if (status !== undefined) {
          if (
            typeof status !== "string" ||
            !(AGENT_STATUSES as readonly string[]).includes(status)
          ) {
            throw new AutomationsError(
              "invalid_schedule",
              `event.filter.agent_status must be one of ${AGENT_STATUSES.join("|")}`,
            );
          }
          filter.agent_status = status;
        }
        out.filter = filter;
      }
      for (const key of ["debounce_ms", "cooldown_ms"] as const) {
        const value = raw[key];
        if (value === undefined) continue;
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 2_147_483_647
        ) {
          throw new AutomationsError(
            "invalid_schedule",
            `event.${key} must be an integer 0..2147483647`,
          );
        }
        out[key] = value;
      }
      const maxFires = raw.max_fires;
      if (maxFires !== undefined) {
        if (
          typeof maxFires !== "number" ||
          !Number.isInteger(maxFires) ||
          maxFires < 1 ||
          maxFires > 1_000_000
        ) {
          throw new AutomationsError(
            "invalid_schedule",
            "event.max_fires must be an integer 1..1000000",
          );
        }
        out.max_fires = maxFires;
      }
      return out;
    }
    default:
      throw new AutomationsError(
        "invalid_schedule",
        `unknown schedule type '${type}' — v1 accepts interval|fixed_time|once|event`,
      );
  }
}

/** `once` schedules must point at the future at write time (contract/spec). */
export function assertOnceInFuture(schedule: Schedule, nowMs: number): void {
  if (schedule.type === "once" && Date.parse(schedule.run_at) <= nowMs) {
    throw new AutomationsError(
      "invalid_schedule",
      `once.run_at ${schedule.run_at} is not in the future`,
    );
  }
}

/**
 * Schema-validate a destination (ADR-0023 §1). Kept deliberately
 * structural — liveness of the pane/agent is a fire-time concern
 * (#145), never a registry-write concern.
 */
export function parseDestination(raw: unknown): Destination {
  if (!isRecord(raw)) {
    throw new AutomationsError("invalid_task", "destination must be an object");
  }
  if (raw.kind === "pane") {
    const paneId = raw.pane_id;
    if (typeof paneId !== "string" || paneId.length === 0) {
      throw new AutomationsError("invalid_task", "destination.pane_id must be a non-empty string");
    }
    return { kind: "pane", pane_id: paneId };
  }
  if (raw.kind === "launch") {
    const agent = raw.agent;
    if (typeof agent !== "string" || agent.length === 0) {
      throw new AutomationsError("invalid_task", "destination.agent must be a non-empty string");
    }
    const surfaceRaw = raw.surface;
    let surface: { workspace_id: string } | { new_workspace: true } | { tab_id: string };
    if (isRecord(surfaceRaw) && typeof surfaceRaw.workspace_id === "string") {
      surface = { workspace_id: surfaceRaw.workspace_id };
    } else if (isRecord(surfaceRaw) && surfaceRaw.new_workspace === true) {
      surface = { new_workspace: true };
    } else if (isRecord(surfaceRaw) && typeof surfaceRaw.tab_id === "string") {
      surface = { tab_id: surfaceRaw.tab_id };
    } else {
      throw new AutomationsError(
        "invalid_task",
        "destination.surface must be {workspace_id} | {new_workspace:true} | {tab_id}",
      );
    }
    const out: {
      kind: "launch";
      surface: { workspace_id: string } | { new_workspace: true } | { tab_id: string };
      agent: string;
      launch_args?: string[] | undefined;
      via?: "direct" | "handoff-execute" | undefined;
      handoff_record_id?: string | undefined;
    } = { kind: "launch", surface, agent };
    if (raw.launch_args !== undefined) {
      if (!Array.isArray(raw.launch_args) || raw.launch_args.some((a) => typeof a !== "string")) {
        throw new AutomationsError(
          "invalid_task",
          "destination.launch_args must be an array of strings",
        );
      }
      out.launch_args = [...(raw.launch_args as string[])];
    }
    if (raw.via !== undefined) {
      if (raw.via !== "direct" && raw.via !== "handoff-execute") {
        throw new AutomationsError(
          "invalid_task",
          "destination.via must be 'direct' or reserved 'handoff-execute'",
        );
      }
      out.via = raw.via;
    }
    if (raw.handoff_record_id !== undefined) {
      if (typeof raw.handoff_record_id !== "string" || raw.handoff_record_id.length === 0) {
        throw new AutomationsError(
          "invalid_task",
          "destination.handoff_record_id must be a non-empty string",
        );
      }
      out.handoff_record_id = raw.handoff_record_id;
    }
    return out;
  }
  throw new AutomationsError("invalid_task", "destination.kind must be 'pane' or 'launch'");
}

// ---------------------------------------------------------------------------
// Stored-record parsing (state load — strict; corrupt state is an error)
// ---------------------------------------------------------------------------

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AutomationsError("state_corrupt", `stored ${field} is not a string`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return asString(value, field);
}

export function parseStoredSchedule(raw: unknown): Schedule {
  try {
    return parseSchedule(raw);
  } catch (err) {
    if (err instanceof AutomationsError) {
      throw new AutomationsError("state_corrupt", `stored schedule invalid: ${err.message}`);
    }
    throw err;
  }
}

export function parseStoredDestination(raw: unknown): Destination {
  try {
    return parseDestination(raw);
  } catch (err) {
    if (err instanceof AutomationsError) {
      throw new AutomationsError("state_corrupt", `stored destination invalid: ${err.message}`);
    }
    throw err;
  }
}

export function parseStoredTask(raw: unknown): TaskRecord {
  if (!isRecord(raw)) {
    throw new AutomationsError("state_corrupt", "stored task is not an object");
  }
  const enabled = raw.enabled;
  if (typeof enabled !== "boolean") {
    throw new AutomationsError("state_corrupt", "stored task.enabled is not a boolean");
  }
  const misfire = raw.misfire;
  if (misfire !== "skip" && misfire !== "run_once") {
    throw new AutomationsError("state_corrupt", "stored task.misfire invalid");
  }
  const runCount = raw.run_count;
  if (typeof runCount !== "number" || !Number.isInteger(runCount) || runCount < 0) {
    throw new AutomationsError("state_corrupt", "stored task.run_count invalid");
  }
  const disabledAt = raw.disabled_at;
  if (disabledAt !== null && disabledAt !== undefined && typeof disabledAt !== "string") {
    throw new AutomationsError("state_corrupt", "stored task.disabled_at invalid");
  }
  return {
    contract: CONTRACT,
    task_id: asString(raw.task_id, "task.task_id"),
    name: asString(raw.name, "task.name"),
    prompt: asString(raw.prompt, "task.prompt"),
    schedule: parseStoredSchedule(raw.schedule),
    enabled,
    misfire,
    destination: parseStoredDestination(raw.destination),
    created_by: asString(raw.created_by, "task.created_by"),
    created_at: asString(raw.created_at, "task.created_at"),
    updated_at: asString(raw.updated_at, "task.updated_at"),
    enabled_at: asString(raw.enabled_at, "task.enabled_at"),
    disabled_at: disabledAt === undefined ? null : (disabledAt as string | null),
    schedule_anchor_at: asString(raw.schedule_anchor_at, "task.schedule_anchor_at"),
    last_run_at: asNullableString(raw.last_run_at, "task.last_run_at"),
    run_count: runCount,
  };
}

export function parseStoredRun(raw: unknown): RunRecord {
  if (!isRecord(raw)) {
    throw new AutomationsError("state_corrupt", "stored run is not an object");
  }
  const status = raw.status;
  if (typeof status !== "string" || !(RUN_STATUSES as readonly string[]).includes(status)) {
    throw new AutomationsError("state_corrupt", "stored run.status invalid");
  }
  const trigger = raw.trigger;
  if (typeof trigger !== "string" || !(RUN_TRIGGERS as readonly string[]).includes(trigger)) {
    throw new AutomationsError("state_corrupt", "stored run.trigger invalid");
  }
  const scheduledFor = raw.scheduled_for;
  if (scheduledFor !== null && typeof scheduledFor !== "string") {
    throw new AutomationsError("state_corrupt", "stored run.scheduled_for invalid");
  }
  return {
    contract: CONTRACT,
    run_id: asString(raw.run_id, "run.run_id"),
    task_id: asString(raw.task_id, "run.task_id"),
    trigger: trigger as RunTrigger,
    scheduled_for: scheduledFor as string | null,
    status: status as RunStatus,
    created_at: asString(raw.created_at, "run.created_at"),
    started_at: asNullableString(raw.started_at, "run.started_at"),
    finished_at: asNullableString(raw.finished_at, "run.finished_at"),
    destination_snapshot:
      raw.destination_snapshot === null || raw.destination_snapshot === undefined
        ? null
        : (raw.destination_snapshot as Record<string, unknown>),
    result:
      raw.result === null || raw.result === undefined ? null : (raw.result as RunRecord["result"]),
    error: raw.error === null || raw.error === undefined ? null : (raw.error as RunRecord["error"]),
  };
}

// ---------------------------------------------------------------------------
// Schedule occurrence math (deterministic; `now` injected)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = dtfCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    dtfCache.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** Milliseconds the zone's wall clock is ahead of UTC at instant `ms`. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Second precision is enough: offsets are whole minutes.
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC epoch-ms instant.
 * Two-pass offset resolution handles DST transitions; ambiguous times
 * resolve to the first occurrence (documented, deterministic).
 */
export function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - zoneOffsetMs(guess, timeZone);
  // Re-resolve once in case the first guess landed across a transition.
  utc = guess - zoneOffsetMs(utc, timeZone);
  return utc;
}

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function scheduleZone(schedule: Extract<Schedule, { type: "fixed_time" }>): string {
  return schedule.time_zone ?? hostTimeZone();
}

function parseTimeOfDay(tod: string): { hour: number; minute: number } {
  const [h, m] = tod.split(":");
  return { hour: Number(h), minute: Number(m) };
}

/**
 * Owed-occurrence window: `[enabled_at, horizon]` where horizon is
 * `min(now, disabled_at)` — occurrences while disabled are never owed.
 * All comparisons in epoch ms.
 */
export function owedWindowMs(task: TaskRecord, nowMs: number): { startMs: number; endMs: number } {
  const startMs = Date.parse(task.enabled_at);
  const disabledMs = task.disabled_at === null ? null : Date.parse(task.disabled_at);
  const endMs = disabledMs === null ? nowMs : Math.min(nowMs, disabledMs);
  return { startMs, endMs };
}

/**
 * Occurrence instants (epoch ms, ascending) in the owed window up to
 * `nowMs - MISSED_GRACE_MS`, capped at `limit` — the MOST RECENT
 * `limit` occurrences. Returns `total` (uncapped count) and
 * `truncated` so callers can report honestly.
 */
export function owedPastOccurrences(
  task: TaskRecord,
  nowMs: number,
  limit: number = MAX_MISSED_REPORTED,
): { instants: number[]; total: number; truncated: boolean } {
  const graceCutoff = nowMs - MISSED_GRACE_MS;
  const { startMs, endMs } = owedWindowMs(task, nowMs);
  const effectiveEnd = Math.min(endMs, graceCutoff);
  if (effectiveEnd < startMs) return { instants: [], total: 0, truncated: false };

  const instants = collectPastInstants(task, startMs, effectiveEnd, limit);
  return instants;
}

function collectPastInstants(
  task: TaskRecord,
  startMs: number,
  endMs: number,
  limit: number,
): { instants: number[]; total: number; truncated: boolean } {
  const schedule = task.schedule;
  switch (schedule.type) {
    case "interval": {
      const every = schedule.every_ms;
      const anchor = Date.parse(task.schedule_anchor_at);
      // First k whose instant is >= startMs; occurrences are
      // anchor + k*every for k >= 1.
      let k = Math.max(1, Math.ceil((startMs - anchor) / every));
      while (anchor + k * every < startMs) k += 1;
      const lastK = Math.floor((endMs - anchor) / every);
      const total = Math.max(0, lastK - k + 1);
      const truncated = total > limit;
      const take = truncated ? limit : total;
      const instants: number[] = [];
      // Most recent `take` occurrences.
      const kStart = lastK - take + 1;
      for (let i = kStart; i <= lastK; i += 1) instants.push(anchor + i * every);
      return { instants, total, truncated };
    }
    case "once": {
      const at = Date.parse(schedule.run_at);
      if (at < startMs || at > endMs) return { instants: [], total: 0, truncated: false };
      return { instants: [at], total: 1, truncated: false };
    }
    case "fixed_time": {
      const zone = scheduleZone(schedule);
      const { hour, minute } = parseTimeOfDay(schedule.time_of_day);
      const weekdays = schedule.weekdays;
      // Local date of startMs/endMs in the task zone bounds the scan.
      const startParts = zonedParts(startMs, zone);
      const endParts = zonedParts(endMs, zone);
      const startDay = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
      const endDay = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
      const dayCount = Math.floor((endDay - startDay) / 86_400_000);
      const cappedDays = Math.min(dayCount, MAX_FIXED_TIME_DAYS_BACK);
      const found: number[] = [];
      for (let d = cappedDays; d >= 0; d -= 1) {
        const day = new Date(endDay - d * 86_400_000);
        const y = day.getUTCFullYear();
        const mo = day.getUTCMonth() + 1;
        const da = day.getUTCDate();
        const instant = zonedLocalToUtc(y, mo, da, hour, minute, zone);
        if (instant < startMs || instant > endMs) continue;
        if (weekdays !== undefined) {
          const wd = zonedParts(instant, zone).weekday;
          if (!weekdays.includes(wd)) continue;
        }
        found.push(instant);
      }
      found.sort((a, b) => a - b);
      const truncated = found.length > limit;
      const instants = truncated ? found.slice(found.length - limit) : found;
      return { instants, total: found.length, truncated };
    }
    case "event":
      // Event schedules have no clock occurrences — fires come from
      // pending hook marks drained by `tick` (#146), never `missed`.
      return { instants: [], total: 0, truncated: false };
  }
}

/**
 * Instants (epoch ms) that already have a run record — resolved
 * occurrences are never re-reported as missed, whatever the status
 * (a materialized `missed`/`skipped`/`cancelled` record counts).
 */
export function resolvedOccurrenceKeys(runs: Iterable<RunRecord>, taskId: string): Set<string> {
  const keys = new Set<string>();
  for (const run of runs) {
    if (run.task_id === taskId && run.scheduled_for !== null) {
      keys.add(run.scheduled_for);
    }
  }
  return keys;
}

/**
 * Derived missed occurrences for a task at `nowMs`: owed-window
 * occurrences past the grace with no run record for
 * `task_id + scheduled_for`. Deterministic — same inputs, same output.
 * `unresolved_total` counts ALL unresolved owed occurrences (the
 * reported `missed` list is capped at `limit`, most recent first in
 * ascending order).
 */
export function deriveMissed(
  task: TaskRecord,
  runs: Iterable<RunRecord>,
  nowMs: number,
  limit: number = MAX_MISSED_REPORTED,
): {
  missed: DerivedMissedRun[];
  unresolved_total: number;
  truncated: boolean;
} {
  // Scan the most recent MISSED_SCAN_LIMIT owed instants; `total` stays
  // exact regardless (interval arithmetic / bounded fixed_time scan).
  const {
    instants,
    total,
    truncated: scanTruncated,
  } = owedPastOccurrences(task, nowMs, MISSED_SCAN_LIMIT);
  const resolved = resolvedOccurrenceKeys(runs, task.task_id);
  const runList = [...runs];
  const unresolved: number[] = [];
  for (const ms of instants) {
    if (!resolved.has(new Date(ms).toISOString())) unresolved.push(ms);
  }
  // Exact unresolved total = owed occurrences minus resolved ones in
  // the owed window (counted over run records, not instants).
  const { startMs, endMs } = owedWindowMs(task, nowMs);
  const horizon = Math.min(endMs, nowMs - MISSED_GRACE_MS);
  let resolvedOwed = 0;
  for (const run of runList) {
    if (run.task_id !== task.task_id || run.scheduled_for === null) continue;
    const ms = Date.parse(run.scheduled_for);
    if (ms >= startMs && ms <= horizon) resolvedOwed += 1;
  }
  const unresolved_total = Math.max(0, total - resolvedOwed);
  const take = unresolved.slice(Math.max(0, unresolved.length - limit));
  const missed: DerivedMissedRun[] = take.map((ms) => ({
    contract: CONTRACT,
    run_id: null,
    task_id: task.task_id,
    trigger: "schedule",
    scheduled_for: new Date(ms).toISOString(),
    status: "missed",
    derived: true,
    created_at: null,
    started_at: null,
    finished_at: null,
    destination_snapshot: null,
    result: null,
    error: {
      code: "missed",
      message:
        "scheduled occurrence passed with no run record (driver absent or herdr unreachable); never reported as executed",
    },
  }));
  return {
    missed,
    unresolved_total,
    truncated: unresolved_total > missed.length || scanTruncated,
  };
}

/**
 * Next future occurrence (epoch ms) strictly after `afterMs`, or null
 * when the schedule can never fire again (past `once`, exhausted
 * window). Caller checks `enabled` — disabled tasks report null.
 */
export function nextOccurrenceAfter(task: TaskRecord, afterMs: number): number | null {
  const schedule = task.schedule;
  switch (schedule.type) {
    case "interval": {
      const every = schedule.every_ms;
      const anchor = Date.parse(task.schedule_anchor_at);
      // Occurrences are anchor + k*every for k >= 1; first one
      // strictly after afterMs.
      const k = Math.max(1, Math.floor((afterMs - anchor) / every) + 1);
      return anchor + k * every;
    }
    case "once": {
      const at = Date.parse(schedule.run_at);
      // Owed-window check: a `once` whose run_at precedes the current
      // enabled_at was never owed (disabled through its instant).
      if (at <= afterMs) return null;
      if (at < Date.parse(task.enabled_at)) return null;
      return at;
    }
    case "fixed_time": {
      const zone = scheduleZone(schedule);
      const { hour, minute } = parseTimeOfDay(schedule.time_of_day);
      const weekdays = schedule.weekdays;
      // Scan local dates forward from the day containing afterMs.
      const afterParts = zonedParts(afterMs, zone);
      const startDay = Date.UTC(afterParts.year, afterParts.month - 1, afterParts.day);
      for (let d = 0; d <= 8; d += 1) {
        const day = new Date(startDay + d * 86_400_000);
        const instant = zonedLocalToUtc(
          day.getUTCFullYear(),
          day.getUTCMonth() + 1,
          day.getUTCDate(),
          hour,
          minute,
          zone,
        );
        if (instant <= afterMs) continue;
        if (instant < Date.parse(task.enabled_at)) continue;
        if (weekdays !== undefined) {
          const wd = zonedParts(instant, zone).weekday;
          if (!weekdays.includes(wd)) continue;
        }
        return instant;
      }
      return null;
    }
    case "event":
      // No clock occurrence — event fires are mark-driven (#146).
      return null;
  }
}

/**
 * `fire <task-id> --scheduled-for <ts>` validation (#145): is `ms` a
 * genuine occurrence instant of the task's schedule? Driver-supplied
 * values are validated, never trusted (contract §Idempotency).
 * - interval: `schedule_anchor_at + k·every_ms`, k ≥ 1.
 * - once: exactly `run_at`.
 * - fixed_time: the instant round-trips through the zone wall clock —
 *   HH:MM + weekday match AND `zonedLocalToUtc(parts) === ms` (ambiguous
 *   DST times resolve to the first occurrence only, same rule as
 *   `nextOccurrenceAfter`).
 */
export function isOccurrenceInstant(task: TaskRecord, ms: number): boolean {
  const schedule = task.schedule;
  switch (schedule.type) {
    case "interval": {
      const anchor = Date.parse(task.schedule_anchor_at);
      const every = schedule.every_ms;
      return ms > anchor && (ms - anchor) % every === 0;
    }
    case "once": {
      return ms === Date.parse(schedule.run_at);
    }
    case "fixed_time": {
      const zone = scheduleZone(schedule);
      const { hour, minute } = parseTimeOfDay(schedule.time_of_day);
      const parts = zonedParts(ms, zone);
      if (parts.hour !== hour || parts.minute !== minute) return false;
      if (schedule.weekdays !== undefined && !schedule.weekdays.includes(parts.weekday)) {
        return false;
      }
      return zonedLocalToUtc(parts.year, parts.month, parts.day, hour, minute, zone) === ms;
    }
    case "event":
      // Event occurrences are hook marks, not clock instants — `fire`
      // can never validate one; event runs come from `tick` drain only.
      return false;
  }
}

export interface TickPlan {
  /**
   * Unresolved occurrence instants (epoch ms, ascending) still inside
   * the driver-jitter grace — `tick` fires each through the run path.
   */
  fireNow: number[];
  /**
   * Unresolved occurrence instants at/past the grace boundary —
   * "late" per the misfire policy (`skip` → materialize `missed`;
   * `run_once` → fire the most recent once).
   */
  late: number[];
}

/**
 * Due-occurrence scan for `tick`/`watch` (#145). An occurrence is
 * "resolved" by ANY stored run record for `task_id + scheduled_for`
 * (including `missed`/`skipped`/`cancelled` — the key is spent).
 * The partition boundary is exactly the `deriveMissed` cutoff
 * (`nowMs - MISSED_GRACE_MS`): an instant is either fireable on-time
 * or missed-eligible, never both — reads and fires agree.
 */
export function tickPlan(task: TaskRecord, runs: Iterable<RunRecord>, nowMs: number): TickPlan {
  const empty: TickPlan = { fireNow: [], late: [] };
  if (!task.enabled) return empty;
  const { startMs, endMs } = owedWindowMs(task, nowMs);
  if (endMs < startMs) return empty;
  const { instants } = collectPastInstants(task, startMs, endMs, MISSED_SCAN_LIMIT);
  const resolved = resolvedOccurrenceKeys(runs, task.task_id);
  const lateCutoff = nowMs - MISSED_GRACE_MS;
  const plan: TickPlan = { fireNow: [], late: [] };
  for (const ms of instants) {
    if (resolved.has(new Date(ms).toISOString())) continue;
    if (ms <= lateCutoff) plan.late.push(ms);
    else plan.fireNow.push(ms);
  }
  return plan;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the honest `driver.state` for task views from persisted
 * driver records. Live `watch` (pid alive) wins; then an installed OS
 * scheduler entry; then `install_failed`; then `stale`; else `none`.
 * `pidAlive` is injectable for tests.
 */
export function resolveDriverState(
  drivers: Iterable<DriverRecord>,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
): { state: DriverState; detail: string } {
  let watchLive: DriverRecord | null = null;
  let watchDead: DriverRecord | null = null;
  let osInstalled: DriverRecord | null = null;
  let osError: DriverRecord | null = null;
  let osStale: DriverRecord | null = null;
  for (const driver of drivers) {
    if (driver.kind === "watch") {
      if (driver.status === "active" && driver.pid !== null && pidAlive(driver.pid)) {
        watchLive = driver;
      } else {
        watchDead = driver;
      }
    } else if (driver.kind === "os-scheduler") {
      if (driver.status === "installed") osInstalled = driver;
      else if (driver.status === "error") osError = driver;
      else osStale = driver;
    }
  }
  if (watchLive !== null) {
    return {
      state: "watch",
      detail: `opt-in watch process live (pid ${watchLive.pid})`,
    };
  }
  if (osInstalled !== null) {
    return {
      state: "os-scheduler",
      detail: osInstalled.detail || `OS scheduler entry '${osInstalled.entry ?? "?"}' installed`,
    };
  }
  if (osError !== null) {
    return { state: "install_failed", detail: osError.detail };
  }
  if (watchDead !== null) {
    return {
      state: "stale",
      detail: `watch record exists but pid ${watchDead.pid ?? "?"} is not running`,
    };
  }
  if (osStale !== null) {
    return { state: "stale", detail: osStale.detail };
  }
  return {
    state: "none",
    detail:
      "no firing driver reporting — occurrences resolve as missed until `schedule install` or `watch` runs",
  };
}

/** Cap on undrained hook marks per session registry (#146). */
export const MAX_PENDING_EVENTS = 500;

/** Stored pending-event parsing (state load — strict; corrupt is an error). */
export function parseStoredPendingEvent(raw: unknown): PendingEventMark {
  if (!isRecord(raw)) {
    throw new AutomationsError("state_corrupt", "stored pending event is not an object");
  }
  const event = asString(raw.event, "pending_event.event");
  if (!(HOOK_EVENT_NAMES as readonly string[]).includes(event)) {
    throw new AutomationsError(
      "state_corrupt",
      `stored pending event '${event}' is not a hook event`,
    );
  }
  const receivedAt = asString(raw.received_at, "pending_event.received_at");
  if (Number.isNaN(Date.parse(receivedAt))) {
    throw new AutomationsError(
      "state_corrupt",
      "stored pending event.received_at is not a timestamp",
    );
  }
  const data = raw.data;
  if (!isRecord(data)) {
    throw new AutomationsError("state_corrupt", "stored pending event.data is not an object");
  }
  return { event, received_at: receivedAt, data: data as Record<string, unknown> };
}

/** Stored-driver parsing (state load — strict; corrupt state is an error). */
export function parseStoredDriver(raw: unknown): DriverRecord {
  if (!isRecord(raw)) {
    throw new AutomationsError("state_corrupt", "stored driver is not an object");
  }
  const kind = raw.kind;
  if (kind !== "watch" && kind !== "os-scheduler") {
    throw new AutomationsError("state_corrupt", "stored driver.kind invalid");
  }
  const pid = raw.pid;
  if (pid !== null && pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid))) {
    throw new AutomationsError("state_corrupt", "stored driver.pid invalid");
  }
  const nullable = (v: unknown, field: string): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") {
      throw new AutomationsError("state_corrupt", `stored driver.${field} invalid`);
    }
    return v;
  };
  return {
    contract: CONTRACT,
    driver_id: asString(raw.driver_id, "driver.driver_id"),
    kind,
    status: asString(raw.status, "driver.status"),
    detail: asString(raw.detail, "driver.detail"),
    pid: (pid ?? null) as number | null,
    platform: nullable(raw.platform, "platform"),
    entry: nullable(raw.entry, "entry"),
    installed_at: nullable(raw.installed_at, "installed_at"),
    updated_at: asString(raw.updated_at, "driver.updated_at"),
  };
}

/**
 * Read-side task view: stored record plus derived `next_run_at`,
 * honest `driver` coverage, and missed-occurrence totals. `driver`
 * is supplied by the caller (registry resolves persisted driver
 * records); the default reports `none`.
 */
export function viewTask(
  task: TaskRecord,
  runs: Iterable<RunRecord>,
  nowMs: number,
  driver?: { state: string; detail: string },
): TaskView {
  const runList = [...runs];
  const { unresolved_total, truncated } = deriveMissed(task, runList, nowMs);
  const next = task.enabled ? nextOccurrenceAfter(task, nowMs) : null;
  return {
    ...task,
    next_run_at: next === null ? null : new Date(next).toISOString(),
    driver: driver ?? {
      state: "none",
      detail: "no firing driver reporting",
    },
    missed_total: unresolved_total,
    missed_truncated: truncated,
  };
}
