import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentGetResult,
  AgentStartOptions,
  PaneInfo,
  SessionSnapshot,
  TabCreatedResult,
  WorkspaceCreatedResult,
} from "../packages/herdr-client/src/index";
import {
  buildHandoffPrompt,
  checkTarget,
  decideStrategy,
  executeHandoff,
  HandoffExecError,
  type HandoffTransport,
  isDoneObservation,
  MAX_PROMPT_CHARS,
  reconcileDelivered,
  resolveProviderKind,
  resolveTargetPlan,
} from "../plugins/handoff/src/execute";
import {
  buildTransferIdentity,
  createRecord,
  type HandoffRecord,
  parseHandoffRecord,
} from "../plugins/handoff/src/model";
import { buildResumeArgs, listResumeProviders, resumeInfo } from "../plugins/handoff/src/resume";
import { loadState, updateState } from "../plugins/handoff/src/state";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-exec-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
});

const SESSION_KEY = "testhost /tmp/herdr.sock";

// --- fixtures -----------------------------------------------------------------

function pane(id: string, extra: Partial<PaneInfo> = {}): PaneInfo {
  return { pane_id: id, workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", ...extra };
}

function agentInfo(seq: number, sessionValue: string | null, status = "working"): AgentGetResult {
  return {
    agent: "claude",
    agent_status: status,
    state_change_seq: seq,
    pane_id: "target:p1",
    agent_session:
      sessionValue === null ? null : { agent: "claude", kind: "session", value: sessionValue },
  };
}

function sourceSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session: { name: "default" },
    workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
    panes: [pane("w1:p1")],
    agents: {
      "w1:p1": {
        agent: "claude",
        agent_status: "working",
        state_change_seq: 7,
        agent_session: { agent: "claude", kind: "session", value: "sess-1" },
      },
    },
    ...overrides,
  };
}

function makeRecord(overrides: {
  strategy?: "native_resume" | "portable_context" | "checkpoint_ref" | "manual";
  providerKind?: string | null;
  agentSession?: string | null;
  target?: HandoffRecord["target"];
}): HandoffRecord {
  const agentSession = overrides.agentSession === undefined ? "sess-1" : overrides.agentSession;
  return createRecord({
    transfer: {
      ...buildTransferIdentity({
        host: "testhost",
        herdrSession: "default",
        sessionKey: SESSION_KEY,
        pane: pane("w1:p1"),
        agent: {
          agent: "claude",
          agent_status: "working",
          state_change_seq: 7,
          agent_session:
            agentSession === null
              ? null
              : { agent: "claude", kind: "session", value: agentSession },
        },
      }),
      provider_kind: overrides.providerKind === undefined ? "claude" : overrides.providerKind,
    },
    strategy: overrides.strategy ?? "portable_context",
    target: overrides.target ?? undefined,
    payload: {
      refs: [
        {
          kind: "conversation_session",
          plugin: "rebuildup.conversations",
          session_key: "claude:sess-1",
        },
      ],
      excerpt: { text: "continue the migration", truncated: false, source: "note" },
      requirements: ["keep API stable"],
    },
  });
}

async function seed(record: HandoffRecord): Promise<void> {
  await updateState((s) => {
    s.handoffs[record.id] = record;
  });
}

// --- fake transport -------------------------------------------------------------

interface FakeFailures {
  workspaceCreate?: Error;
  tabCreate?: Error;
  agentStart?: Error;
  agentGet?: Error;
  agentPrompt?: Error;
  agentWait?: Error;
  paneClose?: Error;
}

class FakeTransport implements HandoffTransport {
  snapshotValue: SessionSnapshot = sourceSnapshot();
  failures: FakeFailures = {};
  workspaceCreates = 0;
  tabCreates = 0;
  paneCloses: string[] = [];
  starts: AgentStartOptions[] = [];
  prompts: { target: string; text: string }[] = [];
  waits: { target: string; timeoutMs: number | null }[] = [];
  /** Sequential agentGet responses; falls back to agentGetDefault. */
  getQueue: AgentGetResult[] = [];
  agentGetDefault: AgentGetResult = agentInfo(5, "target-sess", "working");
  nextPaneId = 0;

  async snapshot(): Promise<SessionSnapshot> {
    return this.snapshotValue;
  }
  async workspaceCreate(): Promise<WorkspaceCreatedResult> {
    this.workspaceCreates += 1;
    if (this.failures.workspaceCreate) throw this.failures.workspaceCreate;
    const paneId = `w-new:p${this.nextPaneId++}`;
    return {
      type: "workspace_created",
      workspace: { workspace_id: "w-new" },
      tab: { tab_id: "w-new:t1", workspace_id: "w-new" },
      root_pane: pane(paneId, { workspace_id: "w-new", tab_id: "w-new:t1" }),
    };
  }
  async tabCreate(params: { workspace_id?: string }): Promise<TabCreatedResult> {
    this.tabCreates += 1;
    if (this.failures.tabCreate) throw this.failures.tabCreate;
    const paneId = `w-tab:p${this.nextPaneId++}`;
    const wsId = params.workspace_id ?? "w-unknown";
    const tabId = `${wsId}:t-new`;
    return {
      type: "tab_created",
      tab: { tab_id: tabId, workspace_id: wsId },
      root_pane: pane(paneId, { workspace_id: wsId, tab_id: tabId }),
    };
  }
  async agentStart(params: AgentStartOptions): Promise<unknown> {
    this.starts.push(params);
    if (this.failures.agentStart) throw this.failures.agentStart;
    return { started: true };
  }
  async agentGet(target: string): Promise<AgentGetResult> {
    if (this.failures.agentGet) throw this.failures.agentGet;
    void target;
    const next = this.getQueue.shift();
    return next ?? this.agentGetDefault;
  }
  async agentPrompt(target: string, text: string): Promise<unknown> {
    this.prompts.push({ target, text });
    if (this.failures.agentPrompt) throw this.failures.agentPrompt;
    return { ok: true };
  }
  async agentWait(target: string, params: { timeoutMs?: number }): Promise<unknown> {
    this.waits.push({ target, timeoutMs: params.timeoutMs ?? null });
    if (this.failures.agentWait) throw this.failures.agentWait;
    return { reached: "done" };
  }
  async paneClose(paneId: string): Promise<unknown> {
    this.paneCloses.push(paneId);
    if (this.failures.paneClose) throw this.failures.paneClose;
    return { closed: true };
  }
}

function deps(transport: FakeTransport) {
  return { transport, sessionKey: SESSION_KEY };
}

// --- tests -----------------------------------------------------------------------

describe("resume capability table", () => {
  test("claude/codex supported, unknown kinds honest", () => {
    expect(resumeInfo("claude").native_resume).toBe("supported");
    expect(resumeInfo("codex").native_resume).toBe("supported");
    expect(resumeInfo("gemini").native_resume).toBe("unknown");
    expect(resumeInfo(null).native_resume).toBe("unknown");
    expect(listResumeProviders().length).toBeGreaterThanOrEqual(2);
  });

  test("buildResumeArgs substitutes session id", () => {
    expect(buildResumeArgs(["--resume", "{session_id}"], "abc")).toEqual(["--resume", "abc"]);
    expect(buildResumeArgs(["resume", "{session_id}"], "xyz")).toEqual(["resume", "xyz"]);
  });
});

describe("strategy decision", () => {
  test("native_resume uses resume args when provider+session id available", () => {
    const r = makeRecord({
      strategy: "native_resume",
      providerKind: "claude",
      agentSession: "sess-1",
    });
    const d = decideStrategy(r);
    expect(d.used).toBe("native_resume");
    expect(d.resume_args).toEqual(["--resume", "sess-1"]);
  });

  test("native_resume falls back to portable_context for unknown provider", () => {
    const r = makeRecord({ strategy: "native_resume", providerKind: "gemini" });
    const d = decideStrategy(r);
    expect(d.used).toBe("portable_context");
    expect(d.resume_args).toBeNull();
    expect(d.reason).toContain("gemini");
  });

  test("native_resume falls back when no agent_session.value recorded", () => {
    const r = makeRecord({ strategy: "native_resume", providerKind: "claude", agentSession: null });
    const d = decideStrategy(r);
    expect(d.used).toBe("portable_context");
    expect(d.reason).toContain("agent_session");
  });

  test("checkpoint_ref/manual are refused, not silently reinterpreted", () => {
    for (const strategy of ["checkpoint_ref", "manual"] as const) {
      const r = makeRecord({ strategy });
      expect(() => decideStrategy(r)).toThrow(HandoffExecError);
      try {
        decideStrategy(r);
      } catch (err) {
        expect((err as HandoffExecError).kind).toBe("unsupported_strategy");
      }
    }
  });

  test("provider hint stem resolves to agent kind", () => {
    const r = makeRecord({ providerKind: null, target: { provider_hint: "claude.openrouter" } });
    expect(resolveProviderKind(r)).toBe("claude");
    expect(resolveProviderKind(r, "codex")).toBe("codex");
  });
});

describe("prompt construction", () => {
  test("prompt carries refs, requirements, excerpt and strategy", () => {
    const r = makeRecord({});
    const d = decideStrategy(r);
    const text = buildHandoffPrompt(r, d);
    expect(text).toContain(`[herdr handoff ${r.id}]`);
    expect(text).toContain("portable_context");
    expect(text).toContain("claude:sess-1");
    expect(text).toContain("keep API stable");
    expect(text).toContain("continue the migration");
    expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});

describe("execute: portable_context happy path", () => {
  test("creates workspace, starts agent, injects prompt, marks delivered", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({ strategy: "portable_context" });
    await seed(r);

    const result = await executeHandoff(r.id, {}, deps(transport));

    expect(result.outcome).toBe("delivered");
    expect(transport.workspaceCreates).toBe(1);
    expect(transport.tabCreates).toBe(0);
    expect(transport.starts).toHaveLength(1);
    expect(transport.starts[0]?.kind).toBe("claude");
    expect(transport.starts[0]?.args).toBeUndefined();
    expect(transport.prompts).toHaveLength(1);
    expect(transport.prompts[0]?.text).toContain(r.id);

    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.status).toBe("delivered");
    expect(stored.execution?.strategy_used).toBe("portable_context");
    expect(stored.execution?.target?.created).toBe(true);
    expect(stored.execution?.target?.pane_id).toBe("w-new:p0");
    expect(stored.execution?.agent?.kind).toBe("claude");
    expect(stored.execution?.agent?.agent_session?.value).toBe("target-sess");
    expect(stored.execution?.prompt?.chars).toBe(transport.prompts[0]?.text.length);
    expect(stored.execution?.error).toBeNull();
  });

  test("native_resume passes resume args to agent.start", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({ strategy: "native_resume", providerKind: "claude" });
    await seed(r);

    const result = await executeHandoff(r.id, {}, deps(transport));

    expect(result.outcome).toBe("delivered");
    expect(transport.starts[0]?.args).toEqual(["--resume", "sess-1"]);
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.execution?.strategy_used).toBe("native_resume");
    expect(stored.execution?.resume_args).toEqual(["--resume", "sess-1"]);
  });

  test("--model maps through the provider model flag", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({ strategy: "portable_context" });
    await seed(r);

    await executeHandoff(r.id, { model: "claude-opus-4" }, deps(transport));
    expect(transport.starts[0]?.args).toEqual(["--model", "claude-opus-4"]);
  });
});

describe("execute: target selection", () => {
  test("--target-pane reuses a free pane without creating a surface", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.snapshotValue = sourceSnapshot({
      panes: [pane("w1:p1"), pane("w2:p9", { workspace_id: "w2", tab_id: "w2:t1" })],
    });
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(r.id, { targetPane: "w2:p9" }, deps(transport));

    expect(result.outcome).toBe("delivered");
    expect(transport.workspaceCreates).toBe(0);
    expect(transport.tabCreates).toBe(0);
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.execution?.target).toEqual({
      pane_id: "w2:p9",
      workspace_id: "w2",
      tab_id: "w2:t1",
      created: false,
    });
    expect(transport.prompts[0]?.target).toBe("w2:p9");
  });

  test("busy target pane is refused before any mutation", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.snapshotValue = sourceSnapshot({
      panes: [pane("w1:p1"), pane("w1:p2")],
      agents: {
        "w1:p1": {
          agent: "claude",
          agent_status: "working",
          state_change_seq: 7,
          agent_session: { agent: "claude", kind: "session", value: "sess-1" },
        },
        "w1:p2": { agent: "codex", agent_status: "idle", state_change_seq: 3 },
      },
    });
    const r = makeRecord({});
    await seed(r);

    await expect(executeHandoff(r.id, { targetPane: "w1:p2" }, deps(transport))).rejects.toThrow(
      HandoffExecError,
    );
    expect(transport.starts).toHaveLength(0);
    expect(transport.prompts).toHaveLength(0);
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.status).toBe("pending");
  });

  test("--target-workspace creates a tab in that workspace", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(r.id, { targetWorkspace: "w2" }, deps(transport));

    expect(result.outcome).toBe("delivered");
    expect(transport.tabCreates).toBe(1);
    expect(transport.workspaceCreates).toBe(0);
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.execution?.target?.workspace_id).toBe("w2");
    expect(stored.execution?.target?.created).toBe(true);
  });

  test("record.target hints are honored when no flag is given", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.snapshotValue = sourceSnapshot({
      panes: [pane("w1:p1"), pane("w2:p9", { workspace_id: "w2", tab_id: "w2:t1" })],
    });
    const r = makeRecord({ target: { workspace_id: "w2" } });
    await seed(r);

    await executeHandoff(r.id, {}, deps(transport));
    expect(transport.tabCreates).toBe(1);
  });
});

describe("execute: refusal paths leave the record untouched", () => {
  test("stale source (pane missing) refuses before mutation", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.snapshotValue = sourceSnapshot({ panes: [], agents: {} });
    const r = makeRecord({});
    await seed(r);

    await expect(executeHandoff(r.id, {}, deps(transport))).rejects.toMatchObject({
      kind: "stale_source",
    });
    expect(transport.workspaceCreates).toBe(0);
    expect((await loadState()).handoffs[r.id]?.status).toBe("pending");
  });

  test("foreign session snapshot refuses (other_session)", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({});
    await seed(r);

    await expect(
      executeHandoff(r.id, {}, { transport, sessionKey: "otherhost /other.sock" }),
    ).rejects.toMatchObject({ kind: "stale_source" });
    expect(transport.workspaceCreates).toBe(0);
  });

  test("non-pending/ready record cannot re-execute", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({});
    r.status = "done";
    await seed(r);

    await expect(executeHandoff(r.id, {}, deps(transport))).rejects.toMatchObject({
      kind: "invalid_state",
    });
  });

  test("missing provider kind is refused before mutation", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({ providerKind: null });
    await seed(r);

    await expect(executeHandoff(r.id, {}, deps(transport))).rejects.toMatchObject({
      kind: "provider_unknown",
    });
    expect(transport.workspaceCreates).toBe(0);
  });

  test("unreachable snapshot is an honest error, record untouched", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.snapshot = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = makeRecord({});
    await seed(r);

    await expect(executeHandoff(r.id, {}, deps(transport))).rejects.toMatchObject({
      kind: "session_unreachable",
    });
    expect((await loadState()).handoffs[r.id]?.status).toBe("pending");
  });
});

describe("execute: failure paths persist status=failed honestly", () => {
  test("agent.start failure → failed, pane kept by default", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.failures.agentStart = new Error("kind not detected: claude");
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(r.id, {}, deps(transport));

    expect(result.outcome).toBe("failed");
    expect(result.error?.step).toBe("agent_start");
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.status).toBe("failed");
    expect(stored.execution?.error?.step).toBe("agent_start");
    expect(stored.execution?.target?.created).toBe(true);
    expect(stored.execution?.cleaned_up).toBe(false);
    expect(transport.paneCloses).toHaveLength(0);
  });

  test("--cleanup-on-failure closes only plugin-created panes", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.failures.agentStart = new Error("boom");
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(r.id, { cleanupOnFailure: true }, deps(transport));

    expect(result.outcome).toBe("failed");
    expect(transport.paneCloses).toEqual(["w-new:p0"]);
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.execution?.cleaned_up).toBe(true);
  });

  test("prompt rejection (agent_blocked) → failed at prompt step", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.failures.agentPrompt = Object.assign(new Error("agent_blocked"), {
      code: "agent_blocked",
    });
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(r.id, {}, deps(transport));

    expect(result.outcome).toBe("failed");
    expect(result.error?.step).toBe("prompt");
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.status).toBe("failed");
    expect(stored.execution?.prompt).toBeNull();
  });

  test("reused --target-pane is never closed on failure", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.snapshotValue = sourceSnapshot({
      panes: [pane("w1:p1"), pane("w2:p9", { workspace_id: "w2", tab_id: "w2:t1" })],
    });
    transport.failures.agentStart = new Error("boom");
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(
      r.id,
      { targetPane: "w2:p9", cleanupOnFailure: true },
      deps(transport),
    );

    expect(result.outcome).toBe("failed");
    expect(transport.paneCloses).toHaveLength(0);
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.execution?.target?.created).toBe(false);
    expect(stored.execution?.cleaned_up).toBe(false);
  });
});

describe("execute: done observation", () => {
  test("--wait-ms + agent_status done → outcome done", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.getQueue = [agentInfo(5, "target-sess", "working")]; // pre-prompt baseline
    transport.agentGetDefault = agentInfo(9, "target-sess", "done"); // post-wait observe
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(r.id, { waitMs: 5_000 }, deps(transport));

    expect(result.outcome).toBe("done");
    expect(transport.waits).toHaveLength(1);
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.status).toBe("done");
    expect(stored.execution?.observed?.agent_status).toBe("done");
  });

  test("idle without seq advance stays delivered; idle+seq advance → done", () => {
    expect(isDoneObservation("done", 3, 5)).toBe(true);
    expect(isDoneObservation("idle", 9, 5)).toBe(true);
    expect(isDoneObservation("idle", 5, 5)).toBe(false);
    expect(isDoneObservation("idle", null, 5)).toBe(false);
    expect(isDoneObservation("blocked", 9, 5)).toBe(false);
    expect(isDoneObservation("working", 9, 5)).toBe(false);
    expect(isDoneObservation(null, 9, 5)).toBe(false);
  });

  test("wait timeout stays delivered honestly", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    transport.failures.agentWait = new Error("timeout: agent.wait timed out");
    transport.agentGetDefault = agentInfo(6, "target-sess", "working");
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(r.id, { waitMs: 1_000 }, deps(transport));

    expect(result.outcome).toBe("delivered");
    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    expect(stored.status).toBe("delivered");
    expect(stored.execution?.observed?.agent_status).toBe("working");
  });
});

describe("supersede + reconcile", () => {
  test("executing one handoff supersedes sibling live records for the same source", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const a = makeRecord({});
    const b = makeRecord({});
    await seed(a);
    await seed(b);

    await executeHandoff(a.id, {}, deps(transport));

    const state = await loadState();
    expect(state.handoffs[a.id]?.status).toBe("delivered");
    expect(state.handoffs[b.id]?.status).toBe("superseded");
  });

  test("reconcileDelivered flips delivered→done on observed agent_status", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({});
    await seed(r);
    await executeHandoff(r.id, {}, deps(transport));

    const snapshot = sourceSnapshot({
      panes: [pane("w1:p1"), pane("w-new:p0", { workspace_id: "w-new", tab_id: "w-new:t1" })],
      agents: {
        "w1:p1": {
          agent: "claude",
          agent_status: "working",
          state_change_seq: 7,
          agent_session: { agent: "claude", kind: "session", value: "sess-1" },
        },
        "w-new:p0": {
          agent: "claude",
          agent_status: "done",
          state_change_seq: 12,
          agent_session: { agent: "claude", kind: "session", value: "target-sess" },
        },
      },
    });

    const updated = await reconcileDelivered(r.id, { snapshot, sessionKey: SESSION_KEY });
    expect(updated?.status).toBe("done");
    expect(updated?.execution?.observed?.agent_status).toBe("done");
    expect((await loadState()).handoffs[r.id]?.status).toBe("done");
  });

  test("reconcileDelivered leaves blocked/working targets delivered", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({});
    await seed(r);
    await executeHandoff(r.id, {}, deps(transport));

    const snapshot = sourceSnapshot({
      panes: [pane("w1:p1"), pane("w-new:p0", { workspace_id: "w-new", tab_id: "w-new:t1" })],
      agents: {
        "w1:p1": {
          agent: "claude",
          agent_status: "working",
          state_change_seq: 7,
          agent_session: { agent: "claude", kind: "session", value: "sess-1" },
        },
        "w-new:p0": { agent: "claude", agent_status: "blocked", state_change_seq: 9 },
      },
    });

    const updated = await reconcileDelivered(r.id, { snapshot, sessionKey: SESSION_KEY });
    expect(updated?.status).toBe("delivered");
    expect(updated?.execution?.observed?.agent_status).toBe("blocked");
  });

  test("checkTarget reports pane_missing without guessing", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({});
    await seed(r);
    await executeHandoff(r.id, {}, deps(transport));

    const stored = (await loadState()).handoffs[r.id] as HandoffRecord;
    const check = checkTarget(stored, sourceSnapshot(), SESSION_KEY);
    expect(check.state).toBe("pane_missing");
    expect(check.pane_present).toBe(false);
  });
});

describe("dry-run + record roundtrip", () => {
  test("dry_run mutates nothing and returns plan+prompt", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({});
    await seed(r);

    const result = await executeHandoff(r.id, { dryRun: true }, deps(transport));

    expect(result.outcome).toBe("dry_run");
    expect(result.plan?.kind).toBe("workspace");
    expect(result.prompt_text).toContain(r.id);
    expect(transport.workspaceCreates).toBe(0);
    expect(transport.starts).toHaveLength(0);
    expect((await loadState()).handoffs[r.id]?.status).toBe("pending");
  });

  test("resolveTargetPlan honors explicit flags over record.target", () => {
    const r = makeRecord({ target: { pane_id: "w1:p1" } });
    const snap = sourceSnapshot({
      panes: [pane("w1:p1"), pane("w2:p9", { workspace_id: "w2", tab_id: "w2:t1" })],
    });
    const plan = resolveTargetPlan(r, snap, { targetWorkspace: "w2" });
    expect(plan).toEqual({ kind: "tab", workspace_id: "w2" });
    expect(() => resolveTargetPlan(r, snap, { targetPane: "w2:p9", newWorkspace: true })).toThrow(
      HandoffExecError,
    );
  });

  test("execution field survives state roundtrip via parseHandoffRecord", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const transport = new FakeTransport();
    const r = makeRecord({});
    await seed(r);
    await executeHandoff(r.id, {}, deps(transport));

    const loaded = await loadState();
    const parsed = parseHandoffRecord(JSON.parse(JSON.stringify(loaded.handoffs[r.id])));
    expect(parsed.status).toBe("delivered");
    expect(parsed.execution?.target?.pane_id).toBe("w-new:p0");
    expect(parsed.execution?.prompt?.delivered_at).toBeTruthy();
  });
});
