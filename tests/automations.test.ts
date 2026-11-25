import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTRACT,
  capabilityDocument,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "../plugins/automations/src/cli";
import {
  AutomationsError,
  assertOnceInFuture,
  deriveMissed,
  nextOccurrenceAfter,
  parseSchedule,
  type RunRecord,
} from "../plugins/automations/src/model";
import {
  createTask,
  deleteTask,
  findRunByOccurrence,
  listRuns,
  listTaskViews,
  materializeMissed,
  runNow,
  setTaskEnabled,
  taskView,
  updateTask,
} from "../plugins/automations/src/registry";
import {
  emptyRegistry,
  type emptyState,
  loadState,
  sessionKeyFor,
  sessionRegistry,
  stateFilePath,
  updateState,
} from "../plugins/automations/src/state";

// ---------------------------------------------------------------------------
// T1 scaffold tests (#137) — kept, updated for the T2 command surface.
// ---------------------------------------------------------------------------

describe("automations capability (T1 scaffold, #137)", () => {
  test("declares the draft v1 contract identity", () => {
    const doc = capabilityDocument();
    expect(doc.contract).toBe("herdr-plugins.automations/v1");
    expect(doc.contract).toBe(CONTRACT);
    expect(doc.plugin).toBe("rebuildup.automations");
    expect(doc.plugin).toBe(PLUGIN_ID);
    expect(doc.version).toBe(PLUGIN_VERSION);
    expect(doc.contract_status).toBe("draft");
  });

  test("advertises implemented registry commands, plans drivers", () => {
    const doc = capabilityDocument();
    for (const cmd of [
      "capability",
      "create",
      "list",
      "get",
      "update",
      "set-enabled",
      "delete",
      "run-now",
      "runs",
      "reconcile",
      "fire",
      "tick",
      "watch",
      "schedule",
    ]) {
      expect(doc.commands).toContain(cmd);
    }
    for (const planned of ["hook", "serve"]) {
      expect(doc.planned_commands).toContain(planned);
      expect(doc.commands).not.toContain(planned);
    }
  });

  test("v1 schedule scope: interval/fixed_time/once in, webhook/event reserved", () => {
    const doc = capabilityDocument();
    expect(doc.schedules).toEqual(["interval", "fixed_time", "once"]);
    expect(doc.reserved_schedules).toEqual(["webhook", "event"]);
    for (const reserved of doc.reserved_schedules) {
      expect(doc.schedules).not.toContain(reserved);
    }
  });

  test("state_file points at the plugin state dir document", () => {
    expect(capabilityDocument().state_file).toBe("state.json");
  });
});

// ---------------------------------------------------------------------------
// Schedule schema validation (#144)
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AutomationsError);
    expect((err as AutomationsError).code).toBe(code);
  }
}

describe("schedule validation", () => {
  test("interval accepts every_ms >= 60000", () => {
    expect(parseSchedule({ type: "interval", every_ms: 60_000 })).toEqual({
      type: "interval",
      every_ms: 60_000,
    });
    expect(parseSchedule({ type: "interval", every_ms: 3_600_000 })).toEqual({
      type: "interval",
      every_ms: 3_600_000,
    });
  });

  test("interval below the 60s floor is invalid_schedule", () => {
    expectCode(() => parseSchedule({ type: "interval", every_ms: 59_999 }), "invalid_schedule");
    expectCode(() => parseSchedule({ type: "interval" }), "invalid_schedule");
    expectCode(() => parseSchedule({ type: "interval", every_ms: "x" }), "invalid_schedule");
  });

  test("fixed_time validates HH:MM, weekdays 0-6, IANA zone", () => {
    const s = parseSchedule({
      type: "fixed_time",
      time_of_day: "09:30",
      weekdays: [1, 2, 3, 4, 5],
      time_zone: "Asia/Tokyo",
    });
    expect(s).toEqual({
      type: "fixed_time",
      time_of_day: "09:30",
      weekdays: [1, 2, 3, 4, 5],
      time_zone: "Asia/Tokyo",
    });
    // Absent optionals stay absent (exactOptionalPropertyTypes).
    const minimal = parseSchedule({ type: "fixed_time", time_of_day: "23:59" });
    if (minimal.type !== "fixed_time") throw new Error("expected fixed_time");
    expect(minimal.weekdays).toBeUndefined();
    expect(minimal.time_zone).toBeUndefined();
  });

  test("fixed_time rejects bad time, empty/invalid weekdays, bad zone", () => {
    expectCode(
      () => parseSchedule({ type: "fixed_time", time_of_day: "9:30" }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "fixed_time", time_of_day: "24:00" }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "fixed_time", time_of_day: "10:00", weekdays: [] }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "fixed_time", time_of_day: "10:00", weekdays: [7] }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "fixed_time", time_of_day: "10:00", time_zone: "Mars/Olympus" }),
      "invalid_schedule",
    );
  });

  test("once requires ISO with explicit offset and a future run_at", () => {
    expect(parseSchedule({ type: "once", run_at: "2026-03-01T09:00:00+09:00" })).toEqual({
      type: "once",
      run_at: "2026-03-01T00:00:00.000Z",
    });
    // Z counts as an explicit offset.
    expect(parseSchedule({ type: "once", run_at: "2026-03-01T00:00:00Z" }).type).toBe("once");
    expectCode(
      () => parseSchedule({ type: "once", run_at: "2026-03-01T09:00:00" }),
      "invalid_schedule",
    );
    expectCode(() => parseSchedule({ type: "once", run_at: "not-a-date" }), "invalid_schedule");
    expectCode(() => parseSchedule({ type: "once" }), "invalid_schedule");
    // Shape-valid but past → invalid_schedule at write time.
    const past = parseSchedule({ type: "once", run_at: "2020-01-01T00:00:00Z" });
    expectCode(() => assertOnceInFuture(past, T0), "invalid_schedule");
    const future = parseSchedule({ type: "once", run_at: "2027-01-01T00:00:00Z" });
    assertOnceInFuture(future, T0); // no throw
  });

  test("reserved webhook/event schedules are unsupported_schedule", () => {
    expectCode(() => parseSchedule({ type: "webhook" }), "unsupported_schedule");
    expectCode(() => parseSchedule({ type: "event", on: "pane.closed" }), "unsupported_schedule");
  });

  test("unknown/malformed schedules are invalid_schedule", () => {
    expectCode(() => parseSchedule(null), "invalid_schedule");
    expectCode(() => parseSchedule({}), "invalid_schedule");
    expectCode(() => parseSchedule({ type: "cron", expr: "* * * * *" }), "invalid_schedule");
  });
});

// ---------------------------------------------------------------------------
// Registry CRUD (#144)
// ---------------------------------------------------------------------------

const DESTINATION = { kind: "pane", pane_id: "w1:t1:p1" } as const;

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "nightly review",
    prompt: "Review open PRs.",
    schedule: { type: "interval", every_ms: 3_600_000 },
    destination: DESTINATION,
    ...overrides,
  };
}

describe("task registry CRUD", () => {
  test("create produces a contract-shaped task record", () => {
    const reg = emptyRegistry();
    const task = createTask(reg, makeInput(), T0);
    expect(task.contract).toBe(CONTRACT);
    expect(task.task_id).toMatch(/^task_/);
    expect(task.enabled).toBe(true);
    expect(task.misfire).toBe("skip");
    expect(task.created_by).toBe("cli");
    expect(task.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(task.enabled_at).toBe(task.created_at);
    expect(task.disabled_at).toBeNull();
    expect(task.schedule_anchor_at).toBe(task.created_at);
    expect(task.last_run_at).toBeNull();
    expect(task.run_count).toBe(0);
    expect(reg.tasks[task.task_id]).toBe(task);
  });

  test("create rejects unsupported/invalid schedules and bad destinations", () => {
    const reg = emptyRegistry();
    expectCode(
      () => createTask(reg, makeInput({ schedule: { type: "webhook" } }), T0),
      "unsupported_schedule",
    );
    expectCode(
      () => createTask(reg, makeInput({ schedule: { type: "interval", every_ms: 1 } }), T0),
      "invalid_schedule",
    );
    expectCode(
      () =>
        createTask(
          reg,
          makeInput({
            schedule: { type: "once", run_at: "2020-01-01T00:00:00Z" },
          }),
          T0,
        ),
      "invalid_schedule",
    );
    expectCode(
      () => createTask(reg, makeInput({ destination: { kind: "pane" } }), T0),
      "invalid_task",
    );
    expectCode(
      () => createTask(reg, makeInput({ destination: { kind: "bogus" } }), T0),
      "invalid_task",
    );
    expectCode(() => createTask(reg, makeInput({ name: "  " }), T0), "invalid_task");
    expect(Object.keys(reg.tasks)).toHaveLength(0);
  });

  test("create honors --enabled false: disabled task owes nothing", () => {
    const reg = emptyRegistry();
    const task = createTask(reg, makeInput({ enabled: false }), T0);
    expect(task.enabled).toBe(false);
    expect(task.disabled_at).toBe(task.created_at);
    const view = taskView(reg, task.task_id, T0 + 5 * 3_600_000);
    expect(view.next_run_at).toBeNull();
    expect(view.missed_total).toBe(0);
  });

  test("list/get/update/set-enabled/delete round trip", () => {
    const reg = emptyRegistry();
    const task = createTask(reg, makeInput(), T0);

    // get via view
    const view = taskView(reg, task.task_id, T0 + 30 * 60_000);
    expect(view.task_id).toBe(task.task_id);
    expect(view.next_run_at).toBe("2026-01-01T01:00:00.000Z");

    // update name + schedule
    const updated = updateTask(
      reg,
      task.task_id,
      {
        name: "renamed",
        schedule: { type: "interval", every_ms: 7_200_000 },
        misfire: "run_once",
      },
      T0 + 60_000,
    );
    expect(updated.name).toBe("renamed");
    expect(updated.misfire).toBe("run_once");
    expect(updated.schedule_anchor_at).toBe("2026-01-01T00:01:00.000Z");

    // pause / resume
    const paused = setTaskEnabled(reg, task.task_id, false, T0 + 120_000);
    expect(paused.enabled).toBe(false);
    expect(paused.disabled_at).toBe("2026-01-01T00:02:00.000Z");
    const resumed = setTaskEnabled(reg, task.task_id, true, T0 + 180_000);
    expect(resumed.enabled).toBe(true);
    expect(resumed.enabled_at).toBe("2026-01-01T00:03:00.000Z");
    expect(resumed.disabled_at).toBeNull();

    // unknown task errors
    expectCode(() => taskView(reg, "task_nope", T0), "task_not_found");
    expectCode(() => updateTask(reg, "task_nope", { name: "x" }, T0), "task_not_found");
    expectCode(() => setTaskEnabled(reg, "task_nope", true, T0), "task_not_found");
    expectCode(() => deleteTask(reg, "task_nope"), "task_not_found");

    // delete removes task + runs
    runNow(reg, task.task_id, T0);
    const del = deleteTask(reg, task.task_id);
    expect(del.task_id).toBe(task.task_id);
    expect(del.runs_removed).toBe(1);
    expect(reg.tasks[task.task_id]).toBeUndefined();
    expect(Object.keys(reg.runs)).toHaveLength(0);
  });

  test("list filters by enabled and sorts by created_at", () => {
    const reg = emptyRegistry();
    createTask(reg, makeInput({ name: "a" }), T0);
    createTask(reg, makeInput({ name: "b", enabled: false }), T0 + 1000);
    createTask(reg, makeInput({ name: "c" }), T0 + 2000);
    const all = listTaskViews(reg, { nowMs: T0 + 3000 });
    expect(all.map((t) => t.name)).toEqual(["a", "b", "c"]);
    const enabledOnly = listTaskViews(reg, { enabled: true, nowMs: T0 + 3000 });
    expect(enabledOnly.map((t) => t.name)).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// run-now / runs / idempotency (#144)
// ---------------------------------------------------------------------------

describe("manual runs and idempotency", () => {
  test("run-now records a manual run distinct from scheduled occurrences", () => {
    const reg = emptyRegistry();
    const task = createTask(reg, makeInput(), T0);
    const run = runNow(reg, task.task_id, T0 + 5000);
    expect(run.run_id).toMatch(/^run_/);
    expect(run.trigger).toBe("manual");
    expect(run.scheduled_for).toBeNull();
    expect(run.status).toBe("scheduled");
    expect(run.task_id).toBe(task.task_id);
    // Manual runs never collide with the task_id+scheduled_for key.
    expect(findRunByOccurrence(reg, task.task_id, "2026-01-01T01:00:00.000Z")).toBeNull();

    const runs = listRuns(reg, { taskId: task.task_id, nowMs: T0 + 5000 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.run_id).toBe(run.run_id);
  });

  test("occurrence idempotency key dedupes stored records", () => {
    const reg = emptyRegistry();
    const task = createTask(reg, makeInput(), T0);
    const scheduledFor = "2026-01-01T01:00:00.000Z";
    const first: RunRecord = {
      contract: CONTRACT,
      run_id: "run_a",
      task_id: task.task_id,
      trigger: "schedule",
      scheduled_for: scheduledFor,
      status: "success",
      created_at: scheduledFor,
      started_at: scheduledFor,
      finished_at: scheduledFor,
      destination_snapshot: null,
      result: null,
      error: null,
    };
    reg.runs[first.run_id] = first;
    // A second record for the same key is findable — fire/tick (#145)
    // returns the existing record instead of duplicating execution.
    expect(findRunByOccurrence(reg, task.task_id, scheduledFor)?.run_id).toBe("run_a");
    // And the resolved occurrence is not reported missed. now=03:30 →
    // owed 01:00/02:00/03:00; 01:00 resolved → 02:00+03:00 remain.
    const { missed, unresolved_total } = deriveMissed(
      task,
      Object.values(reg.runs),
      T0 + 3.5 * 3_600_000,
    );
    expect(unresolved_total).toBe(2);
    expect(missed.map((m) => m.scheduled_for)).toEqual([
      "2026-01-01T02:00:00.000Z",
      "2026-01-01T03:00:00.000Z",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Missed-run derivation — fake clock (#144 acceptance)
// ---------------------------------------------------------------------------

describe("missed-run detection (fake clock)", () => {
  test("interval: occurrences past the 60s grace derive as missed", () => {
    const reg = emptyRegistry();
    const task = createTask(reg, makeInput(), T0); // hourly from 00:00
    // 03:30 → occurrences 01:00, 02:00, 03:00 all past grace (cutoff 03:29).
    const now = T0 + 3.5 * 3_600_000;
    const view = taskView(reg, task.task_id, now);
    expect(view.missed_total).toBe(3);
    expect(view.next_run_at).toBe("2026-01-01T04:00:00.000Z");

    const { missed } = deriveMissed(task, [], now);
    expect(missed.map((m) => m.scheduled_for)).toEqual([
      "2026-01-01T01:00:00.000Z",
      "2026-01-01T02:00:00.000Z",
      "2026-01-01T03:00:00.000Z",
    ]);
    for (const m of missed) {
      expect(m.status).toBe("missed");
      expect(m.derived).toBe(true);
      expect(m.run_id).toBeNull();
    }
  });

  test("occurrences inside the driver jitter grace are not yet missed", () => {
    const reg = emptyRegistry();
    const task = createTask(reg, makeInput(), T0);
    // 01:00:30 — the 01:00 occurrence is 30s old, inside the 60s grace.
    const now = T0 + 3_600_000 + 30_000;
    const view = taskView(reg, task.task_id, now);
    expect(view.missed_total).toBe(0);
    expect(view.next_run_at).toBe("2026-01-01T02:00:00.000Z");
  });

  test("once: future run_at is next_run_at; past run_at is missed", () => {
    const reg = emptyRegistry();
    const task = createTask(
      reg,
      makeInput({ schedule: { type: "once", run_at: "2026-01-01T02:00:00Z" } }),
      T0,
    );
    const before = taskView(reg, task.task_id, T0 + 3_600_000);
    expect(before.next_run_at).toBe("2026-01-01T02:00:00.000Z");
    expect(before.missed_total).toBe(0);

    const after = taskView(reg, task.task_id, T0 + 2 * 3_600_000 + 120_000);
    expect(after.next_run_at).toBeNull();
    expect(after.missed_total).toBe(1);
    const runs = listRuns(reg, { taskId: task.task_id, nowMs: T0 + 2 * 3_600_000 + 120_000 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("missed");
    expect(runs[0]?.scheduled_for).toBe("2026-01-01T02:00:00.000Z");
  });

  test("fixed_time: daily UTC occurrences derive deterministically", () => {
    const reg = emptyRegistry();
    const task = createTask(
      reg,
      makeInput({
        schedule: { type: "fixed_time", time_of_day: "09:00", time_zone: "UTC" },
      }),
      T0, // 2026-01-01T00:00Z
    );
    // now = Jan 3 10:00Z → owed 09:00 occurrences Jan 2 + Jan 3 (Jan 1 09:00
    // is also owed: created 00:00, so Jan1 09:00 > enabled_at).
    const now = Date.parse("2026-01-03T10:00:00Z");
    const view = taskView(reg, task.task_id, now);
    expect(view.missed_total).toBe(3);
    expect(view.next_run_at).toBe("2026-01-04T09:00:00.000Z");
    const { missed } = deriveMissed(task, [], now);
    expect(missed.map((m) => m.scheduled_for)).toEqual([
      "2026-01-01T09:00:00.000Z",
      "2026-01-02T09:00:00.000Z",
      "2026-01-03T09:00:00.000Z",
    ]);
  });

  test("fixed_time honors weekdays and non-UTC zones", () => {
    const reg = emptyRegistry();
    // 2026-01-05 is a Monday; weekdays=[1] → Mondays only, 09:00 JST = 00:00Z.
    const task = createTask(
      reg,
      makeInput({
        schedule: {
          type: "fixed_time",
          time_of_day: "09:00",
          weekdays: [1],
          time_zone: "Asia/Tokyo",
        },
      }),
      T0,
    );
    const next = nextOccurrenceAfter(task, T0);
    expect(next).not.toBeNull();
    expect(new Date(next as number).toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  test("disabled periods are never owed: pause flushes missed, resume restarts", () => {
    const reg = emptyRegistry();
    const task = createTask(reg, makeInput(), T0);
    // Pause at 01:30 — the owed 01:00 occurrence is materialized as a
    // real `missed` run record before the window closes.
    setTaskEnabled(reg, task.task_id, false, T0 + 90 * 60_000);
    const during = taskView(reg, task.task_id, T0 + 5 * 3_600_000);
    expect(during.next_run_at).toBeNull();
    expect(during.missed_total).toBe(0); // resolved by the stored record
    const storedMissed = Object.values(reg.runs).filter((r) => r.status === "missed");
    expect(storedMissed).toHaveLength(1);
    expect(storedMissed[0]?.scheduled_for).toBe("2026-01-01T01:00:00.000Z");

    // Resume at 05:00 — occurrences 02:00..05:00 during the disabled
    // period are NOT owed; the stored missed record stays put.
    setTaskEnabled(reg, task.task_id, true, T0 + 5 * 3_600_000);
    const after = taskView(reg, task.task_id, T0 + 5 * 3_600_000 + 30_000);
    expect(after.missed_total).toBe(0);
    expect(after.next_run_at).toBe("2026-01-01T06:00:00.000Z");
    const allMissed = listRuns(reg, { taskId: task.task_id, nowMs: T0 + 5 * 3_600_000 + 30_000 });
    expect(allMissed.filter((r) => r.status === "missed")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// reconcile + persistence / lock (#144)
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const SOCKET = "/tmp/herdr-automations-test.sock";
const SESSION_KEY = sessionKeyFor({ socketPath: SOCKET });

function tempStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "automations-test-"));
  dirs.push(dir);
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
});

function registryOf(state: ReturnType<typeof emptyState>) {
  return sessionRegistry(state, SESSION_KEY);
}

describe("state persistence, session namespacing, lock", () => {
  test("state file lives under HERDR_PLUGIN_STATE_DIR and round-trips", async () => {
    tempStateDir();
    expect(stateFilePath()).toContain("automations");
    const task = await updateState((state) => createTask(registryOf(state), makeInput(), T0));
    const reloaded = await loadState();
    const reg = reloaded.sessions[SESSION_KEY];
    expect(reg).toBeDefined();
    expect(reg?.tasks[task.task_id]?.name).toBe("nightly review");
  });

  test("sessions are namespaced: same task_id space per socket", async () => {
    tempStateDir();
    const otherKey = sessionKeyFor({ socketPath: "/tmp/other-herdr.sock" });
    await updateState((state) => {
      createTask(sessionRegistry(state, SESSION_KEY), makeInput({ name: "s1" }), T0);
      createTask(sessionRegistry(state, otherKey), makeInput({ name: "s2" }), T0);
      return null;
    });
    const state = await loadState();
    expect(Object.keys(state.sessions[SESSION_KEY]?.tasks ?? {})).toHaveLength(1);
    expect(Object.keys(state.sessions[otherKey]?.tasks ?? {})).toHaveLength(1);
  });

  test("concurrent creates serialize on the single-writer lock", async () => {
    tempStateDir();
    const [a, b] = await Promise.all([
      updateState((state) => createTask(registryOf(state), makeInput({ name: "a" }), T0)),
      updateState((state) => createTask(registryOf(state), makeInput({ name: "b" }), T0)),
    ]);
    expect(a.task_id).not.toBe(b.task_id);
    const state = await loadState();
    expect(Object.keys(state.sessions[SESSION_KEY]?.tasks ?? {})).toHaveLength(2);
  });

  test("reconcile materializes missed runs once (idempotent)", async () => {
    tempStateDir();
    const now = T0 + 3.5 * 3_600_000;
    const task = await updateState((state) => createTask(registryOf(state), makeInput(), T0));
    // Sanity: derived missed exists before reconcile.
    let state = await loadState();
    let reg = state.sessions[SESSION_KEY];
    if (!reg) throw new Error("registry missing");
    const storedTask = reg.tasks[task.task_id];
    if (!storedTask) throw new Error("task missing");
    expect(deriveMissed(storedTask, [], now).missed).toHaveLength(3);

    const written = await updateState((state) =>
      materializeMissed(registryOf(state), { taskId: task.task_id, nowMs: now }),
    );
    expect(written).toBe(3);
    state = await loadState();
    reg = state.sessions[SESSION_KEY];
    const missedRuns = Object.values(reg?.runs ?? {}).filter((r) => r.status === "missed");
    expect(missedRuns).toHaveLength(3);
    for (const r of missedRuns) {
      expect(r.trigger).toBe("schedule");
      expect(r.run_id).toMatch(/^run_/);
      expect(r.error?.code).toBe("missed");
    }
    // Second reconcile writes nothing — records already exist.
    const again = await updateState((state) =>
      materializeMissed(registryOf(state), { taskId: task.task_id, nowMs: now }),
    );
    expect(again).toBe(0);
    // And derived view no longer double-reports them.
    state = await loadState();
    reg = state.sessions[SESSION_KEY];
    if (!reg) throw new Error("registry missing");
    const view = taskView(reg, task.task_id, now);
    expect(view.missed_total).toBe(0);
  });
});
