import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HerdrRpcError } from "../packages/herdr-client/src/socket";
import {
  type AutomationsTransport,
  automationAgentName,
  deliverRun,
  isTransportError,
} from "../plugins/automations/src/execute";
import {
  AutomationsError,
  isOccurrenceInstant,
  type RunRecord,
  tickPlan,
} from "../plugins/automations/src/model";
import {
  advanceIntervalAnchor,
  createOccurrenceRun,
  createRunRecord,
  createTask,
  finalizeRun,
  findRunsByOccurrence,
  prepareFire,
  prepareTick,
  registryDriverState,
  removeDriver,
  runNow,
  startRun,
  upsertDriver,
} from "../plugins/automations/src/registry";
import { type CommandRunner, schedulerAdapterFor } from "../plugins/automations/src/scheduler";
import { emptyRegistry, type SessionRegistry } from "../plugins/automations/src/state";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;

const PANE_DEST = { kind: "pane", pane_id: "w1:t1:p1" } as const;

function makeTask(reg: SessionRegistry, overrides: Record<string, unknown> = {}, nowMs = T0) {
  return createTask(
    reg,
    {
      name: "nightly review",
      prompt: "Review open PRs.",
      schedule: { type: "interval", every_ms: HOUR },
      destination: PANE_DEST,
      ...overrides,
    },
    nowMs,
  );
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AutomationsError);
    expect((err as AutomationsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Occurrence validation + tick planning (fake clock)
// ---------------------------------------------------------------------------

describe("isOccurrenceInstant", () => {
  test("interval: on-grid instants only", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg); // hourly from T0
    expect(isOccurrenceInstant(task, T0 + HOUR)).toBe(true);
    expect(isOccurrenceInstant(task, T0 + 2 * HOUR)).toBe(true);
    expect(isOccurrenceInstant(task, T0 + HOUR / 2)).toBe(false);
    expect(isOccurrenceInstant(task, T0)).toBe(false); // anchor itself is k=0
  });

  test("once: exact run_at only", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, {
      schedule: { type: "once", run_at: "2026-01-01T02:00:00Z" },
    });
    expect(isOccurrenceInstant(task, T0 + 2 * HOUR)).toBe(true);
    expect(isOccurrenceInstant(task, T0 + HOUR)).toBe(false);
  });

  test("fixed_time: wall-clock round-trip in the task zone", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, {
      schedule: { type: "fixed_time", time_of_day: "09:00", time_zone: "UTC" },
    });
    expect(isOccurrenceInstant(task, Date.parse("2026-01-02T09:00:00Z"))).toBe(true);
    expect(isOccurrenceInstant(task, Date.parse("2026-01-02T09:30:00Z"))).toBe(false);
    expect(isOccurrenceInstant(task, Date.parse("2026-01-02T10:00:00Z"))).toBe(false);
  });
});

describe("tickPlan", () => {
  test("partitions due occurrences at the missed-grace boundary", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg); // hourly
    // now = 03:30 → occurrences 01:00,02:00,03:00 owed; grace cutoff 03:29
    // → all three are "late"; nothing fireable on-time.
    const now = T0 + 3.5 * HOUR;
    const plan = tickPlan(task, [], now);
    expect(plan.fireNow).toEqual([]);
    expect(plan.late).toEqual([T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
    // now = 03:00:30 → 03:00 is 30s old (inside grace → fireNow);
    // 01:00/02:00 are late.
    const plan2 = tickPlan(task, [], T0 + 3 * HOUR + 30_000);
    expect(plan2.fireNow).toEqual([T0 + 3 * HOUR]);
    expect(plan2.late).toEqual([T0 + HOUR, T0 + 2 * HOUR]);
  });

  test("resolved occurrences (any run record) are never re-planned", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const run: RunRecord = {
      contract: "herdr-plugins.automations/v1",
      run_id: "run_x",
      task_id: task.task_id,
      trigger: "schedule",
      scheduled_for: new Date(T0 + HOUR).toISOString(),
      status: "missed",
      created_at: new Date(T0 + HOUR).toISOString(),
      started_at: null,
      finished_at: null,
      destination_snapshot: null,
      result: null,
      error: null,
    };
    const plan = tickPlan(task, [run], T0 + 2 * HOUR + 30_000);
    // 01:00 resolved by the missed record; 02:00 is 30s old → fireNow.
    expect(plan.late).toEqual([]);
    expect(plan.fireNow).toEqual([T0 + 2 * HOUR]);
  });

  test("disabled tasks plan nothing", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, { enabled: false });
    expect(tickPlan(task, [], T0 + 5 * HOUR)).toEqual({ fireNow: [], late: [] });
  });
});

// ---------------------------------------------------------------------------
// prepareFire — idempotency, validation, misfire
// ---------------------------------------------------------------------------

describe("prepareFire", () => {
  test("creates a running run and advances the interval anchor", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const now = T0 + HOUR + 5_000; // 00:00 occurrence? anchor=T0 → first at T0+HOUR
    const prep = prepareFire(reg, task.task_id, new Date(T0 + HOUR).toISOString(), now);
    expect(prep.action).toBe("execute");
    expect(prep.run.status).toBe("running");
    expect(prep.run.trigger).toBe("schedule");
    expect(prep.run.scheduled_for).toBe(new Date(T0 + HOUR).toISOString());
    expect(task.schedule_anchor_at).toBe(new Date(T0 + HOUR).toISOString());
    expect(task.run_count).toBe(1);
  });

  test("second fire for the same key returns the existing run (idempotent)", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const ts = new Date(T0 + HOUR).toISOString();
    const first = prepareFire(reg, task.task_id, ts, T0 + HOUR + 1_000);
    const second = prepareFire(reg, task.task_id, ts, T0 + HOUR + 2_000);
    expect(second.action).toBe("existing");
    expect(second.run.run_id).toBe(first.run.run_id);
    expect(findRunsByOccurrence(reg, task.task_id, ts)).toHaveLength(1);
    expect(task.run_count).toBe(1);
  });

  test("a failed run still blocks re-fire of the same key", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const ts = new Date(T0 + HOUR).toISOString();
    const prep = prepareFire(reg, task.task_id, ts, T0 + HOUR + 1_000);
    finalizeRun(reg, prep.run.run_id, {
      status: "failed",
      finishedAtMs: T0 + HOUR + 2_000,
      error: { code: "destination_unavailable", message: "pane gone" },
    });
    const again = prepareFire(reg, task.task_id, ts, T0 + HOUR + 3_000);
    expect(again.action).toBe("existing");
    expect(again.run.status).toBe("failed");
  });

  test("rejects non-occurrence, future, and out-of-window instants", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    expectCode(
      () => prepareFire(reg, task.task_id, new Date(T0 + HOUR / 2).toISOString(), T0 + HOUR),
      "invalid_occurrence",
    );
    expectCode(
      () => prepareFire(reg, task.task_id, new Date(T0 + 5 * HOUR).toISOString(), T0 + HOUR),
      "invalid_occurrence", // in the future relative to now
    );
    expectCode(() => prepareFire(reg, task.task_id, "not-a-date", T0 + HOUR), "invalid_occurrence");
    expectCode(
      () => prepareFire(reg, "task_nope", new Date(T0).toISOString(), T0),
      "task_not_found",
    );
  });

  test("late fire under misfire:skip records a terminal skipped run, no execution", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg); // default misfire skip
    const ts = new Date(T0 + HOUR).toISOString();
    const now = T0 + HOUR + 120_000; // 2min late > 60s grace
    const prep = prepareFire(reg, task.task_id, ts, now);
    expect(prep.action).toBe("existing");
    expect(prep.run.status).toBe("skipped");
    expect(prep.run.error?.code).toBe("misfire_skip");
    expect(prep.run.finished_at).not.toBeNull();
    // Repeat explicit fire returns the same skipped record.
    const again = prepareFire(reg, task.task_id, ts, now + 1_000);
    expect(again.run.run_id).toBe(prep.run.run_id);
  });

  test("late fire under misfire:run_once executes", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, { misfire: "run_once" });
    const ts = new Date(T0 + HOUR).toISOString();
    const prep = prepareFire(reg, task.task_id, ts, T0 + HOUR + 120_000);
    expect(prep.action).toBe("execute");
    expect(prep.run.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// prepareTick — misfire policies end to end (fake clock)
// ---------------------------------------------------------------------------

describe("prepareTick", () => {
  test("skip policy: on-time occurrences fire, late ones materialize missed", () => {
    const reg = emptyRegistry();
    makeTask(reg); // hourly, skip
    // now = 03:00:30 → 03:00 fires (30s old), 01:00/02:00 → missed records.
    const prep = prepareTick(reg, T0 + 3 * HOUR + 30_000);
    expect(prep.tasksScanned).toBe(1);
    expect(prep.pending).toHaveLength(1);
    expect(prep.pending[0]?.scheduled_for).toBe(new Date(T0 + 3 * HOUR).toISOString());
    expect(prep.missedMaterialized).toBe(2);
    const missed = Object.values(reg.runs).filter((r) => r.status === "missed");
    expect(missed.map((r) => r.scheduled_for)).toEqual([
      new Date(T0 + HOUR).toISOString(),
      new Date(T0 + 2 * HOUR).toISOString(),
    ]);
  });

  test("run_once policy: most recent late occurrence fires once, rest missed", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, { misfire: "run_once" });
    // now = 03:30 → all three owed occurrences are late.
    const prep = prepareTick(reg, T0 + 3.5 * HOUR);
    expect(prep.pending).toHaveLength(1);
    expect(prep.pending[0]?.scheduled_for).toBe(new Date(T0 + 3 * HOUR).toISOString());
    expect(prep.missedMaterialized).toBe(2);
    // Anchor advanced to the fired occurrence.
    expect(task.schedule_anchor_at).toBe(new Date(T0 + 3 * HOUR).toISOString());
  });

  test("second tick is idempotent — resolved keys never re-fire", () => {
    const reg = emptyRegistry();
    makeTask(reg);
    const now = T0 + 3 * HOUR + 30_000;
    const first = prepareTick(reg, now);
    expect(first.pending).toHaveLength(1);
    // Simulate delivery finishing, then tick again at a later time.
    finalizeRun(reg, first.pending[0]?.run_id as string, {
      status: "success",
      finishedAtMs: now,
      result: { summary: "ok" },
    });
    const second = prepareTick(reg, now + 60_000);
    // 04:00 is now within grace → fires; nothing else pending twice.
    expect(second.pending.every((r) => r.scheduled_for !== first.pending[0]?.scheduled_for)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// deliverRun — destinations, provenance, honest failures (fake transport)
// ---------------------------------------------------------------------------

class FakeTransport implements AutomationsTransport {
  calls: string[] = [];
  prompts: Array<{ target: string; text: string }> = [];
  agentStatus = "idle";
  failWith: unknown = null;
  snapshotPanes: Array<Record<string, unknown>> = [];

  async sessionSnapshot() {
    this.calls.push("sessionSnapshot");
    if (this.failWith) throw this.failWith;
    return { panes: this.snapshotPanes } as never;
  }
  async agentGet(target: string) {
    this.calls.push(`agentGet:${target}`);
    if (this.failWith) throw this.failWith;
    return { pane_id: target, agent_status: this.agentStatus } as never;
  }
  async agentPrompt(target: string, text: string) {
    this.calls.push(`agentPrompt:${target}`);
    if (this.failWith) throw this.failWith;
    this.prompts.push({ target, text });
    return {};
  }
  async agentStart(params: { name: string; kind: string; paneId: string }) {
    this.calls.push(`agentStart:${params.paneId}:${params.kind}`);
    if (this.failWith) throw this.failWith;
    return {
      agent: { pane_id: params.paneId, agent_status: "idle" },
      argv: [params.kind],
    } as never;
  }
  async workspaceCreate() {
    this.calls.push("workspaceCreate");
    if (this.failWith) throw this.failWith;
    return {
      workspace: { workspace_id: "w9" },
      tab: { tab_id: "w9:t1" },
      root_pane: { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1" },
    } as never;
  }
  async tabCreate() {
    this.calls.push("tabCreate");
    if (this.failWith) throw this.failWith;
    return {
      tab: { tab_id: "w9:t2" },
      root_pane: { pane_id: "w9:p2", workspace_id: "w9", tab_id: "w9:t2" },
    } as never;
  }
  async paneSplit(params: { target_pane_id?: string | undefined }) {
    this.calls.push(`paneSplit:${params.target_pane_id}`);
    if (this.failWith) throw this.failWith;
    return { type: "pane_split", pane: { pane_id: "w9:p3", tab_id: "w9:t9" } } as never;
  }
}

function makeRun(task: ReturnType<typeof makeTask>, reg: SessionRegistry): RunRecord {
  return createRunRecord(reg, task, {
    trigger: "schedule",
    scheduledFor: new Date(T0 + HOUR).toISOString(),
    nowMs: T0 + HOUR,
    status: "running",
  });
}

describe("deliverRun pane destination", () => {
  test("agent.prompt with provenance prefix; observed agent_status recorded", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    transport.agentStatus = "working";
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("success");
    expect(outcome.result?.agent_status).toBe("working");
    expect(transport.calls).toEqual([
      "agentGet:w1:t1:p1",
      "agentPrompt:w1:t1:p1",
      "agentGet:w1:t1:p1",
    ]);
    const text = transport.prompts[0]?.text ?? "";
    expect(text).toContain(`[automations] scheduled task ${task.task_id}`);
    expect(text).toContain(`run ${run.run_id}`);
    expect(text).toContain("scheduled_for");
    expect(text).toContain("Review open PRs.");
    expect(outcome.destinationSnapshot.pane_id).toBe("w1:t1:p1");
  });

  test("missing agent/pane → failed destination_unavailable, never success", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    transport.failWith = new HerdrRpcError({
      code: "agent_not_found",
      message: "no agent in pane",
    });
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("destination_unavailable");
    expect(transport.prompts).toHaveLength(0);
  });

  test("agent_blocked rejection → failed with the server code", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    transport.agentPrompt = async () => {
      throw new HerdrRpcError({ code: "agent_blocked", message: "agent is blocked" });
    };
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("agent_blocked");
  });

  test("transport failure during delivery → failed socket_unavailable", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    transport.failWith = new Error("connect ECONNREFUSED");
    expect(isTransportError(transport.failWith)).toBe(true);
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("socket_unavailable");
  });
});

describe("deliverRun launch destination", () => {
  test("new_workspace → workspace.create + agent.start + agent.prompt", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, {
      destination: {
        kind: "launch",
        surface: { new_workspace: true },
        agent: "claude",
      },
    });
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("success");
    expect(transport.calls[0]).toBe("workspaceCreate");
    expect(transport.calls.some((c) => c.startsWith("agentStart:w9:p1:claude"))).toBe(true);
    expect(transport.prompts[0]?.target).toBe("w9:p1");
    expect(outcome.destinationSnapshot.pane_id).toBe("w9:p1");
    expect(outcome.destinationSnapshot.surface_created).toBe("workspace");
    expect(automationAgentName(run.run_id)).toMatch(/^auto-[a-z0-9-]+$/);
  });

  test("workspace_id surface → tab.create in that workspace", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, {
      destination: {
        kind: "launch",
        surface: { workspace_id: "w7" },
        agent: "codex",
        launch_args: ["--search"],
      },
    });
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("success");
    expect(transport.calls[0]).toBe("tabCreate");
    expect(transport.prompts[0]?.target).toBe("w9:p2");
  });

  test("tab_id surface → pane.split of the tab's first pane", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, {
      destination: {
        kind: "launch",
        surface: { tab_id: "w9:t9" },
        agent: "claude",
      },
    });
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    transport.snapshotPanes = [{ pane_id: "w9:p0", tab_id: "w9:t9", workspace_id: "w9" }];
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("success");
    expect(transport.calls).toContain("paneSplit:w9:p0");
    expect(transport.prompts[0]?.target).toBe("w9:p3");
  });

  test("tab_id surface with no pane → failed destination_unavailable", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, {
      destination: {
        kind: "launch",
        surface: { tab_id: "w9:empty" },
        agent: "claude",
      },
    });
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    transport.snapshotPanes = [];
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("destination_unavailable");
  });

  test("via handoff-execute is reserved → failed unsupported_destination", async () => {
    const reg = emptyRegistry();
    const task = makeTask(reg, {
      destination: {
        kind: "launch",
        surface: { new_workspace: true },
        agent: "claude",
        via: "handoff-execute",
        handoff_record_id: "ho-1",
      },
    });
    const run = makeRun(task, reg);
    const transport = new FakeTransport();
    const outcome = await deliverRun(task, run, transport);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("unsupported_destination");
    expect(transport.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// finalizeRun / startRun / manual run-now seam
// ---------------------------------------------------------------------------

describe("run lifecycle transitions", () => {
  test("scheduled → running → success with observed result", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const run = runNow(reg, task.task_id, T0 + 10_000);
    expect(run.status).toBe("scheduled");
    startRun(reg, run.run_id, T0 + 11_000);
    expect(reg.runs[run.run_id]?.status).toBe("running");
    expect(reg.runs[run.run_id]?.started_at).toBe("2026-01-01T00:00:11.000Z");
    const done = finalizeRun(reg, run.run_id, {
      status: "success",
      finishedAtMs: T0 + 20_000,
      result: { summary: "delivered", agent_status: "idle" },
    });
    expect(done.status).toBe("success");
    expect(done.finished_at).toBe("2026-01-01T00:00:20.000Z");
    expect(done.result?.agent_status).toBe("idle");
    expect(task.run_count).toBe(1);
    expect(task.last_run_at).not.toBeNull();
  });

  test("finalizeRun leaves terminal records untouched", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    const run = createOccurrenceRun(reg, task, T0 + HOUR, T0 + HOUR);
    if (!run) throw new Error("expected run");
    finalizeRun(reg, run.run_id, { status: "failed", finishedAtMs: T0 + HOUR + 1 });
    const again = finalizeRun(reg, run.run_id, {
      status: "success",
      finishedAtMs: T0 + HOUR + 2,
    });
    expect(again.status).toBe("failed");
  });

  test("advanceIntervalAnchor only moves forward", () => {
    const reg = emptyRegistry();
    const task = makeTask(reg);
    advanceIntervalAnchor(reg, task.task_id, T0 + 3 * HOUR);
    expect(task.schedule_anchor_at).toBe(new Date(T0 + 3 * HOUR).toISOString());
    advanceIntervalAnchor(reg, task.task_id, T0 + HOUR);
    expect(task.schedule_anchor_at).toBe(new Date(T0 + 3 * HOUR).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Driver records → driver.state reporting
// ---------------------------------------------------------------------------

describe("driver state reporting", () => {
  test("no drivers → state none", () => {
    const reg = emptyRegistry();
    makeTask(reg);
    expect(registryDriverState(reg).state).toBe("none");
  });

  test("live watch pid → watch; dead pid → stale", () => {
    const reg = emptyRegistry();
    makeTask(reg);
    upsertDriver(reg, {
      contract: "herdr-plugins.automations/v1",
      driver_id: "watch",
      kind: "watch",
      status: "active",
      detail: "watch process",
      pid: process.pid, // alive
      platform: process.platform,
      entry: null,
      installed_at: null,
      updated_at: new Date().toISOString(),
    });
    expect(registryDriverState(reg).state).toBe("watch");
    upsertDriver(reg, {
      contract: "herdr-plugins.automations/v1",
      driver_id: "watch",
      kind: "watch",
      status: "active",
      detail: "watch process",
      pid: 999_999, // almost certainly dead
      platform: process.platform,
      entry: null,
      installed_at: null,
      updated_at: new Date().toISOString(),
    });
    expect(registryDriverState(reg).state).toBe("stale");
    removeDriver(reg, "watch");
    expect(registryDriverState(reg).state).toBe("none");
  });

  test("os-scheduler installed → os-scheduler; error → install_failed", () => {
    const reg = emptyRegistry();
    makeTask(reg);
    upsertDriver(reg, {
      contract: "herdr-plugins.automations/v1",
      driver_id: "os-scheduler",
      kind: "os-scheduler",
      status: "installed",
      detail: "launchd agent installed",
      pid: null,
      platform: "darwin",
      entry: "rebuildup.automations.tick",
      installed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(registryDriverState(reg).state).toBe("os-scheduler");
    upsertDriver(reg, {
      contract: "herdr-plugins.automations/v1",
      driver_id: "os-scheduler",
      kind: "os-scheduler",
      status: "error",
      detail: "launchctl failed",
      pid: null,
      platform: "darwin",
      entry: "rebuildup.automations.tick",
      installed_at: null,
      updated_at: new Date().toISOString(),
    });
    expect(registryDriverState(reg).state).toBe("install_failed");
  });
});

// ---------------------------------------------------------------------------
// OS scheduler adapters (fake runner)
// ---------------------------------------------------------------------------

interface RecordedCall {
  file: string;
  args: string[];
}

function fakeRunner(handlers: Record<string, (args: string[]) => { code: number; out?: string }>) {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    const key = `${file}:${args[0]}`;
    const handler = handlers[key] ?? handlers[`${file}:${args.slice(0, 2).join(" ")}`];
    const res = handler ? handler(args) : { code: 0 };
    return { code: res.code, stdout: res.out ?? "", stderr: res.out ?? "" };
  };
  return { calls, run };
}

const TICK_CMD = {
  bun: "/usr/local/bin/bun",
  cli: "/repo/plugins/automations/src/cli.ts",
  socketPath: "/tmp/herdr.sock",
};

function adapterDeps(run: CommandRunner, platform: string, home: string) {
  return {
    run,
    homeDir: home,
    stateDir: path.join(home, ".local", "state", "hoxay-plugins", "automations"),
    platform,
  };
}

describe("scheduler adapters", () => {
  test("launchd install writes a StartInterval plist and bootstraps", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "auto-launchd-"));
    try {
      const { calls, run } = fakeRunner({
        "launchctl:bootstrap": () => ({ code: 0 }),
      });
      const adapter = schedulerAdapterFor("darwin", adapterDeps(run, "darwin", home));
      const res = await adapter.install(TICK_CMD);
      expect(res.ok).toBe(true);
      const plist = path.join(home, "Library", "LaunchAgents", "rebuildup.automations.tick.plist");
      const xml = readFileSync(plist, "utf8");
      expect(xml).toContain("<key>StartInterval</key><integer>60</integer>");
      expect(xml).toContain("rebuildup.automations.tick");
      expect(xml).toContain("tick");
      expect(xml).toContain("--socket");
      expect(calls.some((c) => c.file === "launchctl" && c.args[0] === "bootstrap")).toBe(true);
      const status = await adapter.status();
      // bootstrap fake returns 0 for `launchctl print` too → installed.
      expect(status.state).toBe("installed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("launchd status reports stale when plist exists but agent not loaded", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "auto-launchd-"));
    try {
      const agentsDir = path.join(home, "Library", "LaunchAgents");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(path.join(agentsDir, "rebuildup.automations.tick.plist"), "<plist/>");
      const { run } = fakeRunner({
        "launchctl:print": () => ({ code: 1 }),
      });
      const adapter = schedulerAdapterFor("darwin", adapterDeps(run, "darwin", home));
      const status = await adapter.status();
      expect(status.state).toBe("stale");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("systemd install writes service+timer units and enables the timer", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "auto-systemd-"));
    try {
      const { calls, run } = fakeRunner({});
      const adapter = schedulerAdapterFor("linux", adapterDeps(run, "linux", home));
      const res = await adapter.install(TICK_CMD);
      expect(res.ok).toBe(true);
      const unitDir = path.join(home, ".config", "systemd", "user");
      const timer = readFileSync(path.join(unitDir, "rebuildup.automations.tick.timer"), "utf8");
      expect(timer).toContain("OnUnitActiveSec=1min");
      expect(timer).toContain("Persistent=true");
      const service = readFileSync(
        path.join(unitDir, "rebuildup.automations.tick.service"),
        "utf8",
      );
      expect(service).toContain("tick");
      expect(service).toContain("--socket");
      expect(
        calls.some(
          (c) => c.file === "systemctl" && c.args.includes("enable") && c.args.includes("--now"),
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("schtasks install creates a 1-minute entry", async () => {
    const { calls, run } = fakeRunner({});
    const adapter = schedulerAdapterFor("win32", {
      run,
      homeDir: "C:\\Users\\x",
      stateDir: "C:\\state",
    });
    const res = await adapter.install(TICK_CMD);
    expect(res.ok).toBe(true);
    const create = calls.find((c) => c.file === "schtasks" && c.args[0] === "/create");
    expect(create).toBeDefined();
    expect(create?.args).toContain("/sc");
    expect(create?.args).toContain("minute");
    expect(create?.args.join(" ")).toContain("tick");
  });

  test("unsupported platform reports honestly", async () => {
    const { run } = fakeRunner({});
    const adapter = schedulerAdapterFor("freebsd", {
      run,
      homeDir: "/tmp",
      stateDir: "/tmp/state",
    });
    const status = await adapter.status();
    expect(status.state).toBe("error");
    try {
      await adapter.install(TICK_CMD);
      expect.unreachable("expected unsupported_platform");
    } catch (err) {
      expect(err).toBeInstanceOf(AutomationsError);
      expect((err as AutomationsError).code).toBe("unsupported_platform");
    }
  });
});
