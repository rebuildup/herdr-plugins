import { describe, expect, test } from "bun:test";
import { formatTaskSnapshot, TaskRunner } from "../packages/tui/src/task";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TaskRunner", () => {
  test("successful task returns value", async () => {
    const runner = new TaskRunner();
    const res = await runner.run({ label: "t" }, async () => 42);
    expect(res.status).toBe("ok");
    expect(res.value).toBe(42);
    expect(res.partial).toBe(false);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(runner.busy).toBe(false);
  });

  test("reports progress snapshots", async () => {
    const runner = new TaskRunner();
    const snaps: string[] = [];
    const r2 = new TaskRunner({ onChange: (s) => s && snaps.push(formatTaskSnapshot(s)) });
    void runner;
    await r2.run({ label: "fetch", total: 3 }, async (_sig, report) => {
      report({ done: 1, message: "a" });
      report({ done: 2, message: "b" });
      return "ok";
    });
    expect(snaps.some((s) => s.includes("fetch"))).toBe(true);
    expect(snaps.some((s) => s.includes("2/3"))).toBe(true);
  });

  test("cancel aborts and reports cancelled", async () => {
    const runner = new TaskRunner();
    const promise = runner.run({ label: "long" }, async (signal) => {
      await sleep(5000);
      if (signal.aborted) throw new Error("aborted");
      return "never";
    });
    await sleep(20);
    expect(runner.busy).toBe(true);
    expect(runner.cancel()).toBe(true);
    const res = await promise;
    expect(res.status).toBe("cancelled");
    expect(runner.busy).toBe(false);
  });

  test("cancel mid-progress marks partial", async () => {
    const runner = new TaskRunner();
    const promise = runner.run({ label: "collect" }, async (signal, report) => {
      report({ done: 2, total: 5 });
      await sleep(5000);
      if (signal.aborted) throw new Error("aborted");
      return [];
    });
    await sleep(20);
    runner.cancel();
    const res = await promise;
    expect(res.status).toBe("cancelled");
    expect(res.partial).toBe(true);
  });

  test("explicit partial flag propagates on success", async () => {
    const runner = new TaskRunner();
    const res = await runner.run({ label: "best-effort" }, async (_s, report) => {
      report({ partial: true });
      return [1, 2];
    });
    expect(res.status).toBe("ok");
    expect(res.partial).toBe(true);
  });

  test("timeout reports timeout status", async () => {
    const runner = new TaskRunner();
    const res = await runner.run({ label: "slow", timeoutMs: 30 }, async (signal) => {
      await sleep(5000);
      if (signal.aborted) throw new Error("aborted");
      return "never";
    });
    expect(res.status).toBe("timeout");
    expect(res.error).toContain("timed out");
  });

  test("error status carries message, not stack", async () => {
    const runner = new TaskRunner();
    const res = await runner.run({ label: "fail" }, async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe("error");
    expect(res.error).toBe("boom");
  });

  test("second concurrent run rejected honestly", async () => {
    const runner = new TaskRunner();
    const p1 = runner.run({ label: "a" }, async (signal) => {
      await sleep(200);
      if (signal.aborted) throw new Error("x");
      return 1;
    });
    await sleep(10);
    const res2 = await runner.run({ label: "b" }, async () => 2);
    expect(res2.status).toBe("error");
    expect(res2.error).toContain("already running");
    await p1;
  });

  test("non-cancellable task refuses cancel", async () => {
    const runner = new TaskRunner();
    const promise = runner.run({ label: "must-finish", cancellable: false }, async () => {
      await sleep(30);
      return "done";
    });
    await sleep(5);
    expect(runner.cancel()).toBe(false);
    const res = await promise;
    expect(res.status).toBe("ok");
  });
});
