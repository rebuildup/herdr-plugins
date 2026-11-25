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
import { executeHandoff, type HandoffTransport } from "../plugins/handoff/src/execute";
import { delegateHandoff, mergeBackHandoff } from "../plugins/handoff/src/lineage";
import {
  buildTransferIdentity,
  createRecord,
  type HandoffRecord,
  LINEAGE_KINDS,
  parseHandoffRecord,
} from "../plugins/handoff/src/model";
import { resolvePayloadRefs } from "../plugins/handoff/src/refs";
import { loadState, updateState } from "../plugins/handoff/src/state";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-lineage-test-"));
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

function agentGet(
  paneId: string,
  seq: number,
  session: string | null,
  status = "working",
): AgentGetResult {
  return {
    agent: "claude",
    agent_status: status,
    state_change_seq: seq,
    pane_id: paneId,
    agent_session: session === null ? null : { agent: "claude", kind: "session", value: session },
  };
}

/** Snapshot: source pane w1:p1 (delegator) + child pane w2:p1 after exec. */
function snapshotWith(children: Record<string, AgentGetResult> = {}): SessionSnapshot {
  return {
    session: { name: "default" },
    workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1" },
      { tab_id: "w2:t1", workspace_id: "w2" },
    ],
    panes: [pane("w1:p1"), pane("w2:p1", { workspace_id: "w2", tab_id: "w2:t1" })],
    agents: {
      "w1:p1": agentGet("w1:p1", 7, "parent-sess"),
      ...children,
    },
  };
}

function makeRecord(overrides: {
  paneId?: string;
  pane?: PaneInfo;
  agent?: AgentGetResult;
  relationship?: HandoffRecord["relationship"];
  executedTarget?: {
    pane_id: string;
    workspace_id: string | null;
    tab_id: string | null;
    created: boolean;
  };
  remote?: boolean;
}): HandoffRecord {
  const paneId = overrides.paneId ?? "w1:p1";
  const p = overrides.pane ?? pane(paneId);
  const record = createRecord({
    transfer: buildTransferIdentity({
      host: "testhost",
      herdrSession: "default",
      sessionKey: SESSION_KEY,
      pane: p,
      agent: overrides.agent ?? agentGet(paneId, 7, "parent-sess"),
    }),
    strategy: "portable_context",
    payload: { refs: [], excerpt: { text: "do the thing", truncated: false, source: "note" } },
    ...(overrides.relationship !== undefined ? { relationship: overrides.relationship } : {}),
  });
  if (overrides.executedTarget !== undefined || overrides.remote === true) {
    record.execution = {
      decided_at: "2026-01-01T00:00:00.000Z",
      strategy_used: "portable_context",
      provider_kind: "claude",
      decision: "test",
      resume_args: null,
      target: overrides.executedTarget ?? null,
      agent: null,
      prompt: null,
      error: null,
      cleaned_up: false,
      observed: null,
      ...(overrides.remote === true
        ? {
            remote: {
              machine_id: "m1",
              label: "lab",
              target: "lab",
              session: "default",
              enabled: true,
              probed_at: "2026-01-01T00:00:00.000Z",
              server_version: null,
              protocol: null,
            },
          }
        : {}),
    };
  }
  return record;
}

class FakeTransport implements HandoffTransport {
  snapshotValue: SessionSnapshot = snapshotWith();
  workspaceCreates = 0;
  starts: AgentStartOptions[] = [];
  prompts: { target: string; text: string }[] = [];
  waits: { target: string; timeoutMs: number | null }[] = [];
  worktreeCalls: unknown[] = [];
  agentGetDefault: AgentGetResult = agentGet("w2:p1", 5, "child-sess", "done");
  includeWorktree = true;
  nextPaneId = 0;

  async snapshot(): Promise<SessionSnapshot> {
    return this.snapshotValue;
  }
  async workspaceCreate(): Promise<WorkspaceCreatedResult> {
    this.workspaceCreates += 1;
    const paneId = `w-new:p${this.nextPaneId++}`;
    return {
      type: "workspace_created",
      workspace: { workspace_id: "w-new" },
      tab: { tab_id: "w-new:t1", workspace_id: "w-new" },
      root_pane: pane(paneId, { workspace_id: "w-new", tab_id: "w-new:t1" }),
    };
  }
  async tabCreate(params: { workspace_id?: string }): Promise<TabCreatedResult> {
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
    return { started: true };
  }
  async agentGet(): Promise<AgentGetResult> {
    return this.agentGetDefault;
  }
  async agentPrompt(target: string, text: string): Promise<unknown> {
    this.prompts.push({ target, text });
    return { ok: true };
  }
  async agentWait(target: string, params: { timeoutMs?: number }): Promise<unknown> {
    this.waits.push({ target, timeoutMs: params.timeoutMs ?? null });
    return { reached: "done" };
  }
  async paneClose(): Promise<unknown> {
    return { closed: true };
  }
  async worktreeCreate(params: unknown) {
    if (!this.includeWorktree) {
      throw new Error("should not be called");
    }
    this.worktreeCalls.push(params);
    const paneId = `w-wt:p${this.nextPaneId++}`;
    return {
      type: "worktree_created" as const,
      workspace: { workspace_id: "w-wt" },
      tab: { tab_id: "w-wt:t1", workspace_id: "w-wt" },
      root_pane: pane(paneId, { workspace_id: "w-wt", tab_id: "w-wt:t1", cwd: "/repo-wt" }),
      worktree: {
        path: "/repo-wt",
        branch: "handoff/test",
        is_linked_worktree: true,
        open_workspace_id: "w-wt",
      },
    };
  }
}

async function seed(...records: HandoffRecord[]): Promise<void> {
  await updateState((s) => {
    for (const r of records) s.handoffs[r.id] = r;
  });
}

// --- tests -----------------------------------------------------------------------

describe("lineage model", () => {
  test("relationship round-trips through parse; children are derived", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const parent = makeRecord({});
    const child = makeRecord({
      paneId: "w2:p1",
      pane: pane("w2:p1", { workspace_id: "w2", tab_id: "w2:t1" }),
      relationship: { kind: "subagent_spawn", parent_id: parent.id },
    });
    await seed(parent, child);
    const state = await loadState();
    const parsed = parseHandoffRecord(state.handoffs[child.id]);
    expect(parsed.relationship).toEqual({ kind: "subagent_spawn", parent_id: parent.id });
    const children = Object.values(state.handoffs).filter(
      (r) => r.relationship?.parent_id === parent.id,
    );
    expect(children.map((c) => c.id)).toEqual([child.id]);
  });

  test("LINEAGE_KINDS covers the T3 relationship set", () => {
    expect(LINEAGE_KINDS).toEqual([
      "fork",
      "provider_handoff",
      "merge_back",
      "subagent_spawn",
      "subagent_result",
    ]);
  });

  test("parse rejects unknown relationship kind", () => {
    const parent = makeRecord({});
    const raw = JSON.parse(JSON.stringify(parent)) as Record<string, unknown>;
    raw.relationship = { kind: "bogus", parent_id: "x" };
    expect(() => parseHandoffRecord(raw)).toThrow(/relationship\.kind/);
  });
});

describe("delegate (subagent_spawn)", () => {
  test("creates child record linked to parent and executes it", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const parent = makeRecord({});
    await seed(parent);
    const transport = new FakeTransport();

    const result = await delegateHandoff(
      {
        parentId: parent.id,
        payload: {
          refs: [],
          excerpt: { text: "review the diff", truncated: false, source: "note" },
        },
        relationshipNote: "explore refactor",
      },
      { transport, sessionKey: SESSION_KEY },
    );

    expect(result.record.relationship).toEqual({
      kind: "subagent_spawn",
      parent_id: parent.id,
      note: "explore refactor",
    });
    // Child transfer identity = the delegating pane (parent's source pane).
    expect(result.record.transfer.pane_id).toBe("w1:p1");
    // Execution ran the normal pipeline: new surface + agent.start.
    expect(result.execution?.outcome).toBe("delivered");
    expect(transport.starts.length).toBe(1);
    expect(transport.starts[0]?.paneId).not.toBe("w1:p1");
    // Persisted.
    const state = await loadState();
    expect(state.handoffs[result.record.id]?.relationship?.parent_id).toBe(parent.id);
  });

  test("--no-execute equivalent records intent only", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const parent = makeRecord({});
    await seed(parent);
    const transport = new FakeTransport();
    const result = await delegateHandoff(
      { parentId: parent.id, payload: { refs: [] }, execute: false },
      { transport, sessionKey: SESSION_KEY },
    );
    expect(result.execution).toBeUndefined();
    expect(result.record.status).toBe("pending");
    expect(transport.starts.length).toBe(0);
  });

  test("dryRun builds the record without persisting or executing", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const parent = makeRecord({});
    await seed(parent);
    const transport = new FakeTransport();
    const result = await delegateHandoff(
      { parentId: parent.id, payload: { refs: [] }, dryRun: true },
      { transport, sessionKey: SESSION_KEY },
    );
    expect(result.dry_run).toBe(true);
    const state = await loadState();
    expect(state.handoffs[result.record.id]).toBeUndefined();
    expect(transport.starts.length).toBe(0);
  });

  test("refuses missing parent, other session, remote parent, gone delegator", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const parent = makeRecord({});
    await seed(parent);
    const transport = new FakeTransport();

    await expect(
      delegateHandoff(
        { parentId: "ho-nope", payload: { refs: [] } },
        { transport, sessionKey: SESSION_KEY },
      ),
    ).rejects.toMatchObject({ kind: "handoff_not_found" });

    await expect(
      delegateHandoff(
        { parentId: parent.id, payload: { refs: [] } },
        { transport, sessionKey: "otherhost /tmp/other.sock" },
      ),
    ).rejects.toMatchObject({ kind: "other_session" });

    const remote = makeRecord({ remote: true });
    await seed(remote);
    await expect(
      delegateHandoff(
        { parentId: remote.id, payload: { refs: [] } },
        { transport, sessionKey: SESSION_KEY },
      ),
    ).rejects.toMatchObject({ kind: "unsupported_lineage" });

    transport.snapshotValue = { ...snapshotWith(), panes: [pane("w9:p9")] };
    await expect(
      delegateHandoff(
        { parentId: parent.id, payload: { refs: [] } },
        { transport, sessionKey: SESSION_KEY },
      ),
    ).rejects.toMatchObject({ kind: "delegator_missing" });
  });

  test("delegates from the executed target pane when present", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const parent = makeRecord({
      executedTarget: { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", created: true },
    });
    await seed(parent);
    const transport = new FakeTransport();
    transport.snapshotValue = snapshotWith({
      "w2:p1": agentGet("w2:p1", 3, "parent-sess"),
    });
    const result = await delegateHandoff(
      { parentId: parent.id, payload: { refs: [] } },
      { transport, sessionKey: SESSION_KEY },
    );
    expect(result.record.transfer.pane_id).toBe("w2:p1");
    expect(result.record.transfer.workspace_id).toBe("w2");
  });
});

describe("merge-back (subagent_result)", () => {
  /** Parent record (delegator, agent on w1:p1) + executed child on w2:p1. */
  async function seedPair() {
    const parent = makeRecord({});
    const child = makeRecord({
      paneId: "w2:p1",
      pane: pane("w2:p1", { workspace_id: "w2", tab_id: "w2:t1" }),
      agent: agentGet("w2:p1", 9, "child-sess"),
      relationship: { kind: "subagent_spawn", parent_id: parent.id },
      executedTarget: { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", created: true },
    });
    await seed(parent, child);
    return { parent, child };
  }

  test("delivers result via agent.prompt to parent pane — never agent.start", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const { parent, child } = await seedPair();
    const transport = new FakeTransport();
    transport.agentGetDefault = agentGet("w1:p1", 8, "parent-sess", "working");

    const result = await mergeBackHandoff(
      {
        childId: child.id,
        payload: {
          refs: [],
          excerpt: { text: "child finished: +3 tests", truncated: false, source: "note" },
        },
      },
      { transport, sessionKey: SESSION_KEY },
    );

    expect(result.outcome).toBe("delivered");
    expect(result.record.relationship).toEqual({ kind: "subagent_result", parent_id: child.id });
    // Delivery = prompt to w1:p1; zero agent.start calls.
    expect(transport.prompts.length).toBe(1);
    expect(transport.prompts[0]?.target).toBe("w1:p1");
    expect(transport.prompts[0]?.text).toContain(child.id);
    expect(transport.prompts[0]?.text).toContain("handoff_record");
    expect(transport.starts.length).toBe(0);
    // Result record's transfer = the child pane.
    expect(result.record.transfer.pane_id).toBe("w2:p1");
    // status shows lineage on both ends.
    const state = await loadState();
    expect(state.handoffs[result.record.id]?.status).toBe("delivered");
    void parent;
  });

  test("waitMs observation can reach done", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const { child } = await seedPair();
    const transport = new FakeTransport();
    // parent pane reports done after prompt
    transport.agentGetDefault = agentGet("w1:p1", 12, "parent-sess", "done");
    const result = await mergeBackHandoff(
      { childId: child.id, payload: { refs: [] }, waitMs: 5_000 },
      { transport, sessionKey: SESSION_KEY },
    );
    expect(result.outcome).toBe("done");
    expect(transport.waits.length).toBe(1);
  });

  test("refuses: unexecuted child, missing parent link, parent without agent", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const { child } = await seedPair();
    const transport = new FakeTransport();

    // Unexecuted child.
    const unexecuted = makeRecord({
      paneId: "w2:p1",
      relationship: { kind: "subagent_spawn", parent_id: "ho-x" },
    });
    await seed(unexecuted);
    await expect(
      mergeBackHandoff(
        { childId: unexecuted.id, payload: { refs: [] } },
        { transport, sessionKey: SESSION_KEY },
      ),
    ).rejects.toMatchObject({ kind: "handoff_not_found" }); // parent ho-x missing first

    // Child without relationship.
    const orphan = makeRecord({
      paneId: "w2:p1",
      executedTarget: { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", created: true },
    });
    await seed(orphan);
    await expect(
      mergeBackHandoff(
        { childId: orphan.id, payload: { refs: [] } },
        { transport, sessionKey: SESSION_KEY },
      ),
    ).rejects.toMatchObject({ kind: "no_parent" });

    // Parent pane without a running agent.
    transport.snapshotValue = {
      ...snapshotWith(),
      agents: { "w1:p1": { agent_status: "idle" } },
    };
    await expect(
      mergeBackHandoff(
        { childId: child.id, payload: { refs: [] } },
        { transport, sessionKey: SESSION_KEY },
      ),
    ).rejects.toMatchObject({ kind: "parent_agent_missing" });
    void child;
  });

  test("fork child reports via merge_back kind", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const source = makeRecord({});
    const fork = makeRecord({
      paneId: "w2:p1",
      pane: pane("w2:p1", { workspace_id: "w2", tab_id: "w2:t1" }),
      relationship: { kind: "fork", parent_id: source.id },
      executedTarget: { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", created: true },
    });
    await seed(source, fork);
    const transport = new FakeTransport();
    const result = await mergeBackHandoff(
      { childId: fork.id, payload: { refs: [] } },
      { transport, sessionKey: SESSION_KEY },
    );
    expect(result.record.relationship?.kind).toBe("merge_back");
    expect(result.outcome).toBe("delivered");
  });

  test("no-execute records the result intent only", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const { child } = await seedPair();
    const transport = new FakeTransport();
    const result = await mergeBackHandoff(
      { childId: child.id, payload: { refs: [] }, execute: false },
      { transport, sessionKey: SESSION_KEY },
    );
    expect(result.outcome).toBe("recorded");
    expect(transport.prompts.length).toBe(0);
    const state = await loadState();
    expect(state.handoffs[result.record.id]?.status).toBe("pending");
  });
});

describe("worktree execution target", () => {
  test("execute --worktree creates via worktree.create and records execution.worktree", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const record = makeRecord({});
    await seed(record);
    const transport = new FakeTransport();

    const result = await executeHandoff(
      record.id,
      { worktree: true, worktreeBranch: "handoff/x" },
      { transport, sessionKey: SESSION_KEY },
    );

    expect(result.outcome).toBe("delivered");
    expect(transport.worktreeCalls.length).toBe(1);
    expect(transport.workspaceCreates).toBe(0);
    const wt = result.record.execution?.worktree;
    expect(wt?.path).toBe("/repo-wt");
    expect(wt?.branch).toBe("handoff/test");
    expect(wt?.is_linked_worktree).toBe(true);
    expect(wt?.workspace_id).toBe("w-wt");
    expect(result.record.execution?.target?.created).toBe(true);
  });

  test("transport without worktreeCreate refuses pre-mutation", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const record = makeRecord({});
    await seed(record);
    const transport = new FakeTransport();
    // Remove worktreeCreate to simulate an older transport (prototype
    // method — shadow it with undefined on the instance).
    (transport as { worktreeCreate?: unknown }).worktreeCreate = undefined;

    await expect(
      executeHandoff(record.id, { worktree: true }, { transport, sessionKey: SESSION_KEY }),
    ).rejects.toMatchObject({ kind: "worktree_unsupported" });
    const state = await loadState();
    expect(state.handoffs[record.id]?.status).toBe("pending");
  });
});

describe("handoff_record payload refs", () => {
  test("resolves against own state: resolved / missing_ref", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const parent = makeRecord({});
    const child = makeRecord({ relationship: { kind: "subagent_spawn", parent_id: parent.id } });
    await seed(parent, child);

    const resolved = await resolvePayloadRefs(
      { refs: [{ kind: "handoff_record", plugin: "rebuildup.handoff", id: parent.id }] },
      { handoffIds: async () => new Set([parent.id]) },
    );
    expect(resolved[0]?.state).toBe("resolved");

    const missing = await resolvePayloadRefs(
      { refs: [{ kind: "handoff_record", plugin: "rebuildup.handoff", id: "ho-gone" }] },
      { handoffIds: async () => new Set([parent.id]) },
    );
    expect(missing[0]?.state).toBe("missing_ref");

    // Default dep reads real state.
    const real = await resolvePayloadRefs({
      refs: [{ kind: "handoff_record", plugin: "rebuildup.handoff", id: child.id }],
    });
    expect(real[0]?.state).toBe("resolved");
  });
});
