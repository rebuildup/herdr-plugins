import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalEventName,
  eventDimensions,
  markMatchesSchedule,
} from "../plugins/automations/src/events";
import {
  AutomationsError,
  MAX_PENDING_EVENTS,
  type PendingEventMark,
  parseSchedule,
} from "../plugins/automations/src/model";
import {
  createRunRecord,
  createTask,
  finalizeRun,
  observeRunAgentStatus,
  prepareEventTick,
  prepareFire,
  recordPendingEvents,
} from "../plugins/automations/src/registry";
import { emptyRegistry, type SessionRegistry } from "../plugins/automations/src/state";
import { herdrSocketEndpoint, testEnv } from "./helpers/test-env";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;

const PANE_DEST = { kind: "pane", pane_id: "w1:t1:p1" } as const;

function makeEventTask(
  reg: SessionRegistry,
  schedule: Record<string, unknown> = { type: "event", on: "pane.agent_status_changed" },
  overrides: Record<string, unknown> = {},
  nowMs = T0,
) {
  return createTask(
    reg,
    {
      name: "on agent done",
      prompt: "Agent finished — summarize.",
      schedule,
      destination: PANE_DEST,
      ...overrides,
    },
    nowMs,
  );
}

function mark(
  event: string,
  receivedMs: number,
  data: Record<string, unknown> = {},
): PendingEventMark {
  return { event, received_at: new Date(receivedMs).toISOString(), data };
}

function statusMark(paneId: string, status: string, receivedMs: number): PendingEventMark {
  return mark("pane.agent_status_changed", receivedMs, {
    type: "pane_agent_status_changed",
    pane_id: paneId,
    workspace_id: "w1",
    agent_status: status,
    agent: "claude",
  });
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
// event schedule schema (#146)
// ---------------------------------------------------------------------------

describe("event schedule validation", () => {
  test("accepts minimal and full event schedules", () => {
    expect(parseSchedule({ type: "event", on: "pane.agent_status_changed" })).toEqual({
      type: "event",
      on: "pane.agent_status_changed",
    });
    const full = parseSchedule({
      type: "event",
      on: "worktree.created",
      filter: { workspace_id: "w9", agent_status: "done" },
      debounce_ms: 5_000,
      cooldown_ms: 60_000,
      max_fires: 10,
    });
    expect(full).toEqual({
      type: "event",
      on: "worktree.created",
      filter: { workspace_id: "w9", agent_status: "done" },
      debounce_ms: 5_000,
      cooldown_ms: 60_000,
      max_fires: 10,
    });
  });

  test("rejects unknown on, snake_case on, bad filter and bad knobs", () => {
    expectCode(() => parseSchedule({ type: "event" }), "invalid_schedule");
    expectCode(
      () => parseSchedule({ type: "event", on: "pane_agent_status_changed" }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "event", on: "pane.output_changed" }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "event", on: "pane.closed", filter: "x" }),
      "invalid_schedule",
    );
    expectCode(
      () =>
        parseSchedule({
          type: "event",
          on: "pane.closed",
          filter: { agent_status: "exploded" },
        }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "event", on: "pane.closed", debounce_ms: -1 }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "event", on: "pane.closed", cooldown_ms: 1.5 }),
      "invalid_schedule",
    );
    expectCode(
      () => parseSchedule({ type: "event", on: "pane.closed", max_fires: 0 }),
      "invalid_schedule",
    );
  });

  test("create/update accept event schedules; fire rejects them", () => {
    const reg = emptyRegistry();
    const task = makeEventTask(reg);
    expect(task.schedule.type).toBe("event");
    // `fire --scheduled-for` can never validate an event occurrence.
    expectCode(
      () => prepareFire(reg, task.task_id, new Date(T0).toISOString(), T0 + MIN),
      "invalid_occurrence",
    );
    // And event tasks owe no clock occurrences → never missed.
    const view = prepareEventTick(reg, T0 + 10 * MIN);
    expect(view.pending).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Event name normalization + dimension extraction + filters
// ---------------------------------------------------------------------------

describe("event name normalization", () => {
  test("accepts dotted and snake_case wire forms", () => {
    expect(canonicalEventName("pane.agent_status_changed")).toBe("pane.agent_status_changed");
    expect(canonicalEventName("pane_agent_status_changed")).toBe("pane.agent_status_changed");
    expect(canonicalEventName("pane_closed")).toBe("pane.closed");
    expect(canonicalEventName("worktree_created")).toBe("worktree.created");
  });

  test("rejects unknown/empty names", () => {
    expect(canonicalEventName("pane.output_changed")).toBeNull();
    expect(canonicalEventName("bogus.event")).toBeNull();
    expect(canonicalEventName("")).toBeNull();
    expect(canonicalEventName(undefined)).toBeNull();
  });
});

describe("event dimensions and filters", () => {
  test("extracts flat ids from nested and flat payloads", () => {
    const nested = eventDimensions({
      type: "pane_created",
      pane: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", agent: "claude" },
    });
    expect(nested.pane_id).toBe("w1:p2");
    expect(nested.workspace_id).toBe("w1");
    expect(nested.tab_id).toBe("w1:t1");
    expect(nested.agent).toBe("claude");

    const flat = eventDimensions({
      type: "pane_closed",
      pane_id: "w1:p2",
      workspace_id: "w1",
    });
    expect(flat.pane_id).toBe("w1:p2");
    expect(flat.workspace_id).toBe("w1");

    const workspace = eventDimensions({
      type: "workspace_created",
      workspace: { workspace_id: "w7", label: "proj", agent_status: "idle" },
    });
    expect(workspace.workspace_id).toBe("w7");
    expect(workspace.workspace_label).toBe("proj");
    expect(workspace.agent_status).toBe("idle");
  });

  test("markMatchesSchedule requires on-match plus every filter field", () => {
    const m = statusMark("w1:p1", "done", T0);
    expect(markMatchesSchedule(m, "pane.agent_status_changed", undefined)).toBe(true);
    expect(markMatchesSchedule(m, "pane.agent_status_changed", { agent_status: "done" })).toBe(
      true,
    );
    expect(markMatchesSchedule(m, "pane.agent_status_changed", { agent_status: "working" })).toBe(
      false,
    );
    expect(markMatchesSchedule(m, "pane.agent_status_changed", { pane_id: "w1:p9" })).toBe(false);
    expect(markMatchesSchedule(m, "pane.closed", undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pending mark recording
// ---------------------------------------------------------------------------

describe("recordPendingEvents", () => {
  test("appends marks and drops oldest beyond the cap, counted", () => {
    const reg = emptyRegistry();
    const marks: PendingEventMark[] = [];
    for (let i = 0; i < MAX_PENDING_EVENTS + 10; i += 1) {
      marks.push(mark("pane.closed", T0 + i, { pane_id: `p${i}` }));
    }
    recordPendingEvents(reg, marks);
    expect(reg.pending_events).toHaveLength(MAX_PENDING_EVENTS);
    expect(reg.pending_events_dropped).toBe(10);
    // Oldest dropped: first retained mark is index 10.
    expect(reg.pending_events[0]?.data.pane_id).toBe("p10");
  });
});

// ---------------------------------------------------------------------------
// prepareEventTick — drain semantics (fake clock)
// ---------------------------------------------------------------------------

describe("prepareEventTick", () => {
  test("matching mark fires one event run anchored at the mark", () => {
    const reg = emptyRegistry();
    const task = makeEventTask(reg, {
      type: "event",
      on: "pane.agent_status_changed",
      filter: { agent_status: "done" },
    });
    recordPendingEvents(reg, [
      statusMark("w1:p1", "done", T0 + 5_000),
      statusMark("w1:p1", "working", T0 + 6_000), // filtered out
      mark("pane.closed", T0 + 7_000, { pane_id: "w1:p1" }), // wrong event
    ]);
    const prep = prepareEventTick(reg, T0 + 10_000);
    expect(prep.fired).toBe(1);
    expect(prep.consumed).toBe(1);
    expect(prep.pending).toHaveLength(1);
    const run = prep.pending[0];
    expect(run?.trigger).toBe("event");
    expect(run?.status).toBe("running");
    expect(run?.scheduled_for).toBe(new Date(T0 + 5_000).toISOString());
    expect(run?.task_id).toBe(task.task_id);
    // Filtered-out and wrong-event marks stay pending for a later match.
    expect(prep.remaining).toBe(2);
    expect(reg.pending_events).toHaveLength(2);
    // Second drain: nothing left to fire.
    const again = prepareEventTick(reg, T0 + 20_000);
    expect(again.fired).toBe(0);
    expect(again.pending).toHaveLength(0);
  });

  test("no marks / no event tasks → honest no-op", () => {
    const reg = emptyRegistry();
    expect(prepareEventTick(reg, T0)).toEqual({
      pending: [],
      consumed: 0,
      fired: 0,
      suppressed: 0,
      deduplicated: 0,
      remaining: 0,
    });
    makeEventTask(reg);
    // A mark for an event no task subscribes to stays pending.
    recordPendingEvents(reg, [mark("tab.created", T0, { tab: { tab_id: "w1:t9" } })]);
    const prep = prepareEventTick(reg, T0 + MIN);
    expect(prep.fired).toBe(0);
    expect(prep.remaining).toBe(1);
  });

  test("disabled task and out-of-window marks never fire", () => {
    const reg = emptyRegistry();
    const task = makeEventTask(reg, { type: "event", on: "pane.closed" }, { enabled: false });
    void task;
    recordPendingEvents(reg, [mark("pane.closed", T0 + 5_000, { pane_id: "w1:p1" })]);
    const prep = prepareEventTick(reg, T0 + 10_000);
    expect(prep.fired).toBe(0);
    expect(prep.remaining).toBe(1);
  });

  test("debounce collapses bursts; spaced marks fire separately", () => {
    const reg = emptyRegistry();
    makeEventTask(reg, {
      type: "event",
      on: "pane.agent_status_changed",
      debounce_ms: 5_000,
    });
    recordPendingEvents(reg, [
      statusMark("w1:p1", "working", T0),
      statusMark("w1:p1", "working", T0 + 2_000), // within 5s → same burst
      statusMark("w1:p1", "working", T0 + 4_000), // still within chain → same burst
      statusMark("w1:p1", "working", T0 + 20_000), // >5s after prev → new burst
    ]);
    const prep = prepareEventTick(reg, T0 + 30_000);
    expect(prep.fired).toBe(2);
    expect(prep.pending.map((r) => r.scheduled_for)).toEqual([
      new Date(T0).toISOString(),
      new Date(T0 + 20_000).toISOString(),
    ]);
  });

  test("cooldown declines bursts into skipped runs, honestly recorded", () => {
    const reg = emptyRegistry();
    makeEventTask(reg, {
      type: "event",
      on: "pane.agent_status_changed",
      cooldown_ms: 60_000,
    });
    recordPendingEvents(reg, [
      statusMark("w1:p1", "done", T0),
      statusMark("w1:p1", "done", T0 + 30_000), // 30s < 60s cooldown → skipped
      statusMark("w1:p1", "done", T0 + 90_000), // 90s ≥ 60s → fires
    ]);
    const prep = prepareEventTick(reg, T0 + 120_000);
    expect(prep.fired).toBe(2);
    expect(prep.suppressed).toBe(1);
    const runs = Object.values(reg.runs).sort((a, b) =>
      (a.scheduled_for ?? "").localeCompare(b.scheduled_for ?? ""),
    );
    expect(runs.map((r) => r.status)).toEqual(["running", "skipped", "running"]);
    expect(runs[1]?.error?.code).toBe("cooldown");
    expect(runs[1]?.trigger).toBe("event");
    // Cooldown baseline uses the last EXECUTED fire anchor (T0), so the
    // T0+90s burst is 90s after it — fires. The skipped record does not
    // extend the cooldown.
  });

  test("max_fires caps executed fires; excess bursts are skipped", () => {
    const reg = emptyRegistry();
    makeEventTask(reg, {
      type: "event",
      on: "pane.agent_status_changed",
      max_fires: 1,
    });
    recordPendingEvents(reg, [
      statusMark("w1:p1", "done", T0),
      statusMark("w1:p1", "done", T0 + 10_000),
    ]);
    const prep = prepareEventTick(reg, T0 + 20_000);
    expect(prep.fired).toBe(1);
    expect(prep.suppressed).toBe(1);
    const skipped = Object.values(reg.runs).find((r) => r.status === "skipped");
    expect(skipped?.error?.code).toBe("max_fires");
  });

  test("idempotency: an existing run record for the anchor dedupes", () => {
    const reg = emptyRegistry();
    const task = makeEventTask(reg);
    const anchorIso = new Date(T0 + 5_000).toISOString();
    createRunRecord(reg, task, {
      trigger: "event",
      scheduledFor: anchorIso,
      nowMs: T0 + 5_000,
      status: "success",
    });
    recordPendingEvents(reg, [statusMark("w1:p1", "done", T0 + 5_000)]);
    const prep = prepareEventTick(reg, T0 + 10_000);
    expect(prep.deduplicated).toBe(1);
    expect(prep.fired).toBe(0);
    expect(prep.pending).toHaveLength(0);
    expect(Object.values(reg.runs)).toHaveLength(1);
  });

  test("two event tasks on the same mark both fire independently", () => {
    const reg = emptyRegistry();
    makeEventTask(reg, { type: "event", on: "pane.closed" });
    makeEventTask(reg, {
      type: "event",
      on: "pane.closed",
      filter: { pane_id: "w1:p1" },
    });
    recordPendingEvents(reg, [mark("pane.closed", T0, { pane_id: "w1:p1" })]);
    const prep = prepareEventTick(reg, T0 + MIN);
    expect(prep.fired).toBe(2);
    expect(prep.pending).toHaveLength(2);
    expect(new Set(prep.pending.map((r) => r.task_id)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// observeRunAgentStatus — run status tracking (#146)
// ---------------------------------------------------------------------------

describe("observeRunAgentStatus", () => {
  test("folds observed status into the latest delivered run on the pane", () => {
    const reg = emptyRegistry();
    const task = makeEventTask(reg);
    const older = createRunRecord(reg, task, {
      trigger: "manual",
      scheduledFor: null,
      nowMs: T0,
      status: "running",
    });
    older.destination_snapshot = { kind: "pane", pane_id: "w1:p1" };
    const newer = createRunRecord(reg, task, {
      trigger: "manual",
      scheduledFor: null,
      nowMs: T0 + 1_000,
      status: "running",
    });
    newer.destination_snapshot = { kind: "pane", pane_id: "w1:p1" };
    const other = createRunRecord(reg, task, {
      trigger: "manual",
      scheduledFor: null,
      nowMs: T0 + 2_000,
      status: "running",
    });
    other.destination_snapshot = { kind: "pane", pane_id: "w1:p9" };

    const observed = observeRunAgentStatus(reg, "w1:p1", "done", T0 + 5_000);
    expect(observed?.run_id).toBe(newer.run_id);
    expect(newer.result?.agent_status).toBe("done");
    expect(newer.result?.agent_status_at).toBe(new Date(T0 + 5_000).toISOString());
    // Older run on the same pane is NOT overwritten — latest wins.
    expect(older.result?.agent_status).toBeUndefined();
    expect(other.result?.agent_status).toBeUndefined();
  });

  test("ignores non-delivered/failed runs and unknown panes", () => {
    const reg = emptyRegistry();
    const task = makeEventTask(reg);
    const failed = createRunRecord(reg, task, {
      trigger: "manual",
      scheduledFor: null,
      nowMs: T0,
      status: "running",
    });
    failed.destination_snapshot = { kind: "pane", pane_id: "w1:p1" };
    finalizeRun(reg, failed.run_id, { status: "failed", finishedAtMs: T0 + 1 });
    expect(observeRunAgentStatus(reg, "w1:p1", "done", T0 + 2_000)).toBeNull();
    expect(observeRunAgentStatus(reg, "w1:unknown", "done", T0 + 2_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hook.ts entrypoint — fake hook events (#146 contract tests)
// ---------------------------------------------------------------------------

const PLUGIN = path.join(__dirname, "..", "plugins", "automations");
const HOOK = path.join(PLUGIN, "src", "hook.ts");
const CLI = path.join(PLUGIN, "src", "cli.ts");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "automations-t4-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function baseEnv(extra?: Record<string, string>): Record<string, string> {
  return testEnv(extra);
}

function runHook(extraEnv: Record<string, string>) {
  const result = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    env: baseEnv(extraEnv),
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function statusEventEnv(
  paneId: string,
  status: string,
  socketPath: string,
): Record<string, string> {
  return {
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane_agent_status_changed",
      data: {
        type: "pane_agent_status_changed",
        pane_id: paneId,
        workspace_id: "w1",
        agent_status: status,
        agent: "claude",
      },
    }),
  };
}

interface FakeHerdr {
  socketPath: string;
  prompts: Array<{ target: string; text: string }>;
  close: () => Promise<void>;
}

/** Minimal fake herdr socket for `tick` delivery (session.snapshot + agent.*). */
async function fakeHerdr(): Promise<FakeHerdr> {
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
  const prompts: Array<{ target: string; text: string }> = [];
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        let result: unknown = {};
        if (message.method === "session.snapshot") {
          result = { snapshot: { panes: [], agents: {} } };
        } else if (message.method === "agent.get") {
          result = {
            agent: { pane_id: message.params?.target, agent_status: "done" },
          };
        } else if (message.method === "agent.prompt") {
          prompts.push({
            target: String(message.params?.target),
            text: String(message.params?.text),
          });
          result = { ok: true };
        }
        conn.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(herdrSocketEndpoint(socketPath), () => resolveListen());
  });
  return {
    socketPath,
    prompts,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function parseCliOutput(stdout: string, stderr: string, status: number): CliResult {
  return {
    status,
    stdout,
    stderr,
    json: (() => {
      try {
        return JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        return null;
      }
    })(),
  };
}

function runCli(args: string[], extraEnv?: Record<string, string>): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: baseEnv(extraEnv),
    timeout: 30_000,
  });
  return parseCliOutput(result.stdout, result.stderr, result.status ?? -1);
}

/**
 * Async spawn variants: the fake herdr socket lives in this process's
 * event loop, so a blocking spawnSync would deadlock the snapshot
 * request (same constraint as tests/checkpoints*.test.ts).
 */
function runCliAsync(args: string[], extraEnv?: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: baseEnv(extraEnv),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(parseCliOutput(stdout, stderr, code ?? -1)));
  });
}

function runHookAsync(extraEnv: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: baseEnv(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(parseCliOutput(stdout, stderr, code ?? -1)));
  });
}

describe("hook entrypoint + tick drain (fake hook events)", () => {
  test("hook records a pending mark; tick fires the event run end-to-end", async () => {
    const stateDir = tempDir();
    const fake = await fakeHerdr();
    try {
      // Create an event task through the real CLI against the fake socket.
      const created = runCli(
        [
          "create",
          "--name",
          "on done",
          "--prompt",
          "Agent finished.",
          "--schedule",
          JSON.stringify({
            type: "event",
            on: "pane.agent_status_changed",
            filter: { agent_status: "done" },
          }),
          "--destination",
          JSON.stringify({ kind: "pane", pane_id: "w1:t1:p1" }),
          "--socket",
          fake.socketPath,
        ],
        { HERDR_PLUGIN_STATE_DIR: stateDir },
      );
      expect(created.status).toBe(0);
      const taskId = (created.json?.task as { task_id: string }).task_id;

      // Fake hook delivery: snake_case envelope, done status on p1.
      const hook = await runHookAsync({
        ...statusEventEnv("w1:p1", "done", fake.socketPath),
        HERDR_PLUGIN_STATE_DIR: stateDir,
      });
      expect(hook.status).toBe(0);
      // A second hook for a filtered-out status must NOT fire later.
      const hook2 = await runHookAsync({
        ...statusEventEnv("w1:p1", "working", fake.socketPath),
        HERDR_PLUGIN_STATE_DIR: stateDir,
      });
      expect(hook2.status).toBe(0);

      // `tick` drains the mark through the real delivery path.
      const tick = await runCliAsync(["tick", "--socket", fake.socketPath], {
        HERDR_PLUGIN_STATE_DIR: stateDir,
      });
      expect(tick.status).toBe(0);
      if (tick.status !== 0) {
        throw new Error(`tick failed: ${tick.stderr} ${tick.stdout}`);
      }
      const events = tick.json?.events as Record<string, unknown>;
      expect(events.fired).toBe(1);
      expect(events.consumed).toBe(1);
      // The filtered-out "working" mark stays pending (unmatched).
      expect(events.pending).toBe(1);
      expect(fake.prompts).toHaveLength(1);
      expect(fake.prompts[0]?.target).toBe("w1:t1:p1");
      expect(fake.prompts[0]?.text).toContain("[automations] scheduled task");

      const runs = await runCliAsync(
        ["runs", "--task", taskId, "--stored-only", "--socket", fake.socketPath],
        { HERDR_PLUGIN_STATE_DIR: stateDir },
      );
      const runList = runs.json?.runs as Array<Record<string, unknown>>;
      expect(runList).toHaveLength(1);
      expect(runList[0]?.trigger).toBe("event");
      expect(runList[0]?.status).toBe("success");
      expect(runList[0]?.scheduled_for).not.toBeNull();
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("hook never fires without delivery: no marks → tick is a no-op", async () => {
    const stateDir = tempDir();
    const fake = await fakeHerdr();
    try {
      runCli(
        [
          "create",
          "--name",
          "on closed",
          "--prompt",
          "Pane closed.",
          "--schedule",
          JSON.stringify({ type: "event", on: "pane.closed" }),
          "--destination",
          JSON.stringify({ kind: "pane", pane_id: "w1:t1:p1" }),
          "--socket",
          fake.socketPath,
        ],
        { HERDR_PLUGIN_STATE_DIR: stateDir },
      );
      // Hook delivery for a DIFFERENT event only.
      const hook = await runHookAsync({
        HERDR_SOCKET_PATH: fake.socketPath,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          event: "pane_agent_status_changed",
          data: { type: "pane_agent_status_changed", pane_id: "w1:p1", agent_status: "idle" },
        }),
      });
      expect(hook.status).toBe(0);
      const tick = await runCliAsync(["tick", "--socket", fake.socketPath], {
        HERDR_PLUGIN_STATE_DIR: stateDir,
      });
      expect(tick.status).toBe(0);
      const events = tick.json?.events as Record<string, unknown>;
      expect(events.fired).toBe(0);
      expect(fake.prompts).toHaveLength(0);
      const runs = await runCliAsync(["runs", "--stored-only", "--socket", fake.socketPath], {
        HERDR_PLUGIN_STATE_DIR: stateDir,
      });
      expect(runs.json?.runs).toHaveLength(0);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("hook exits 0 with malformed/missing event payloads", () => {
    const stateDir = tempDir();
    const result = runHook({
      HERDR_SOCKET_PATH: path.join(tempDir(), "dead.sock"),
      HERDR_PLUGIN_STATE_DIR: stateDir,
      // No HERDR_PLUGIN_EVENT_JSON at all.
    });
    expect(result.status).toBe(0);
    const bad = runHook({
      HERDR_SOCKET_PATH: path.join(tempDir(), "dead.sock"),
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_EVENT_JSON: "not-json{",
    });
    expect(bad.status).toBe(0);
  });
});
