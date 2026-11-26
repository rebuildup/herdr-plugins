import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentInfo, PaneInfo, SessionSnapshot } from "../packages/herdr-client/src/snapshot";
import {
  boundedExcerpt,
  buildTransferIdentity,
  CONTRACT,
  checkTransfer,
  createRecord,
  guessExternalTarget,
  HANDOFF_STATUSES,
  HANDOFF_STRATEGIES,
  type HandoffPayload,
  type HandoffRecord,
  MAX_EXCERPT_CHARS,
  parseHandoffRecord,
} from "../plugins/handoff/src/model";
import { missingRefCount, resolvePayloadRefs } from "../plugins/handoff/src/refs";
import { emptyState, loadState, pruneHandoffs, updateState } from "../plugins/handoff/src/state";
import { testEnv } from "./helpers/test-env";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
});

const SESSION_KEY = "testhost /tmp/herdr.sock";

function pane(id: string, extra: Partial<PaneInfo> = {}): PaneInfo {
  return { pane_id: id, workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", ...extra };
}

function agent(seq: number, sessionValue?: string): AgentInfo {
  return {
    agent: "claude",
    agent_status: "done",
    state_change_seq: seq,
    agent_session:
      sessionValue === undefined ? null : { agent: "claude", kind: "session", value: sessionValue },
  };
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session: { name: "default" },
    panes: [pane("w1:p1")],
    agents: { "w1:p1": agent(7, "sess-1") },
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    ...buildTransferIdentity({
      host: "testhost",
      herdrSession: "default",
      sessionKey: SESSION_KEY,
      pane: pane("w1:p1"),
      agent: agent(7, "sess-1"),
    }),
    ...overrides,
  };
}

function record(): HandoffRecord {
  const now = new Date("2026-02-01T00:00:00Z");
  return createRecord({
    transfer: identity(),
    strategy: "portable_context",
    target: { provider_hint: "claude.openrouter" },
    payload: {
      refs: [
        {
          kind: "conversation_session",
          plugin: "rebuildup.conversations",
          session_key: "claude:abc-123",
        },
        { kind: "checkpoint", plugin: "rebuildup.checkpoints", id: "m2x-1a2b3c4d" },
        { kind: "external", target: "uri", value: "https://example.com/spec" },
      ],
      excerpt: { text: "please continue the migration", truncated: false, source: "note" },
      requirements: ["keep the public API stable"],
    },
    now,
  });
}

describe("model: record shape", () => {
  test("createRecord emits contract v1 pending record", () => {
    const r = record();
    expect(r.contract).toBe(CONTRACT);
    expect(r.id).toMatch(/^ho-/);
    expect(r.status).toBe("pending");
    expect(HANDOFF_STATUSES).toContain(r.status);
    expect(HANDOFF_STRATEGIES).toContain(r.strategy);
    expect(r.transfer.pane_id).toBe("w1:p1");
    expect(r.transfer.agent_session?.value).toBe("sess-1");
    expect(r.transfer.state_change_seq).toBe(7);
    expect(r.transfer.provider_kind).toBe("claude");
    expect(r.target?.provider_hint).toBe("claude.openrouter");
  });

  test("buildTransferIdentity prefers pane cwd, falls back to agent cwd", () => {
    const withPaneCwd = buildTransferIdentity({
      host: "h",
      herdrSession: null,
      sessionKey: SESSION_KEY,
      pane: pane("p", { cwd: "/pane-cwd" }),
      agent: { agent_status: "idle", cwd: "/agent-cwd" },
    });
    expect(withPaneCwd.cwd).toBe("/pane-cwd");
    const noCwdPane = pane("p");
    delete noCwdPane.cwd;
    const noPaneCwd = buildTransferIdentity({
      host: "h",
      herdrSession: null,
      sessionKey: SESSION_KEY,
      pane: noCwdPane,
      agent: { agent_status: "idle", cwd: "/agent-cwd" },
    });
    expect(noPaneCwd.cwd).toBe("/agent-cwd");
  });

  test("boundedExcerpt truncates at the contract budget", () => {
    const long = "x".repeat(MAX_EXCERPT_CHARS + 10);
    const ex = boundedExcerpt(long, "note");
    expect(ex.truncated).toBe(true);
    expect(ex.text).toHaveLength(MAX_EXCERPT_CHARS);
    const short = boundedExcerpt("hi", "note");
    expect(short.truncated).toBe(false);
    expect(short.text).toBe("hi");
  });

  test("guessExternalTarget classifies uri/path/issue", () => {
    expect(guessExternalTarget("https://example.com/x")).toBe("uri");
    expect(guessExternalTarget("git@github.com:a/b")).toBe("path");
    expect(guessExternalTarget("#123")).toBe("issue");
    expect(guessExternalTarget("docs/specs/handoff.md")).toBe("path");
  });
});

describe("model: staleness (invariant: never apply to wrong generation)", () => {
  test("matching identity is ok", () => {
    expect(checkTransfer(record(), snapshot(), SESSION_KEY)).toEqual({ state: "ok" });
  });

  test("pane missing is stale/pane_missing", () => {
    const snap = snapshot({ panes: [], agents: {} });
    const check = checkTransfer(record(), snap, SESSION_KEY);
    expect(check).toEqual({ state: "stale", reason: "pane_missing" });
  });

  test("reused pane id with different agent_session is stale", () => {
    // Pane id w1:p1 was reused by a new agent generation.
    const snap = snapshot({ agents: { "w1:p1": agent(9, "sess-2") } });
    const check = checkTransfer(record(), snap, SESSION_KEY);
    expect(check).toEqual({ state: "stale", reason: "agent_session_changed" });
  });

  test("live agent_session null vs recorded value is stale", () => {
    const snap = snapshot({ agents: { "w1:p1": agent(7) } });
    const check = checkTransfer(record(), snap, SESSION_KEY);
    expect(check).toEqual({ state: "stale", reason: "agent_session_changed" });
  });

  test("regressed state_change_seq is stale/generation_regressed", () => {
    const snap = snapshot({ agents: { "w1:p1": agent(3, "sess-1") } });
    const check = checkTransfer(record(), snap, SESSION_KEY);
    expect(check).toEqual({ state: "stale", reason: "generation_regressed" });
  });

  test("advanced seq with same session is still applicable", () => {
    const snap = snapshot({ agents: { "w1:p1": agent(12, "sess-1") } });
    expect(checkTransfer(record(), snap, SESSION_KEY)).toEqual({ state: "ok" });
  });

  test("foreign session snapshot is unchecked, never guessed", () => {
    const check = checkTransfer(record(), snapshot(), "otherhost /other.sock");
    expect(check).toEqual({ state: "unchecked", reason: "other_session" });
  });

  test("unreachable snapshot is unchecked, never guessed", () => {
    expect(checkTransfer(record(), null, SESSION_KEY)).toEqual({
      state: "unchecked",
      reason: "snapshot_unavailable",
    });
  });

  test("record without agent_session falls back to pane+seq", () => {
    const r = record();
    r.transfer.agent_session = null;
    const snap = snapshot({ agents: { "w1:p1": agent(8, "any-session") } });
    expect(checkTransfer(r, snap, SESSION_KEY)).toEqual({ state: "ok" });
  });
});

describe("model: parse/roundtrip", () => {
  test("parseHandoffRecord accepts a created record", () => {
    const r = record();
    const parsed = parseHandoffRecord(JSON.parse(JSON.stringify(r)));
    expect(parsed).toEqual(r);
  });

  test("parseHandoffRecord rejects bad contract/status/strategy", () => {
    const r = record();
    expect(() => parseHandoffRecord({ ...r, contract: "other/v9" })).toThrow();
    expect(() => parseHandoffRecord({ ...r, status: "bogus" })).toThrow();
    expect(() => parseHandoffRecord({ ...r, strategy: "bogus" })).toThrow();
    expect(() => parseHandoffRecord({ ...r, payload: { refs: [{ kind: "nope" }] } })).toThrow();
  });
});

describe("refs: payload resolution", () => {
  const payload: HandoffPayload = {
    refs: [
      {
        kind: "conversation_session",
        plugin: "rebuildup.conversations",
        session_key: "claude:abc-123",
      },
      { kind: "checkpoint", plugin: "rebuildup.checkpoints", id: "cp-1" },
      { kind: "checkpoint", plugin: "rebuildup.checkpoints", id: "cp-gone" },
      { kind: "external", target: "uri", value: "https://example.com" },
    ],
  };

  test("resolved / missing_ref / external are reported per ref", async () => {
    const resolved = await resolvePayloadRefs(payload, {
      conversationKeys: async () => new Set(["claude:abc-123"]),
      checkpointIds: async () => ({ ids: new Set(["cp-1"]), complete: true }),
    });
    expect(resolved.map((r) => r.state)).toEqual([
      "resolved",
      "resolved",
      "missing_ref",
      "external",
    ]);
    expect(missingRefCount(resolved)).toBe(1);
    expect(resolved[2]?.detail).toContain("cp-gone");
  });

  test("owner unavailable is error, never missing_ref", async () => {
    const resolved = await resolvePayloadRefs(payload, {
      conversationKeys: async () => null,
      checkpointIds: async () => null,
    });
    expect(resolved[0]?.state).toBe("error");
    expect(resolved[1]?.state).toBe("error");
    expect(resolved[2]?.state).toBe("error");
    expect(missingRefCount(resolved)).toBe(0);
  });

  test("truncated owner listing yields unchecked, not missing_ref", async () => {
    const resolved = await resolvePayloadRefs(
      { refs: [{ kind: "checkpoint", plugin: "rebuildup.checkpoints", id: "cp-x" }] },
      { checkpointIds: async () => ({ ids: new Set<string>(), complete: false }) },
    );
    expect(resolved[0]?.state).toBe("unchecked");
  });
});

describe("state: persistence", () => {
  test("create → load roundtrip under HERDR_PLUGIN_STATE_DIR", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const r = record();
    await updateState((state) => {
      state.handoffs[r.id] = r;
    });
    const loaded = await loadState();
    expect(loaded.handoffs[r.id]).toEqual(r);
  });

  test("empty state when file absent; malformed records throw", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    expect(await loadState()).toEqual(emptyState());
  });

  test("pruneHandoffs evicts terminal records before live ones", () => {
    const handoffs: Record<string, HandoffRecord> = {};
    const base = record();
    for (let i = 0; i < 5; i += 1) {
      const r = { ...base, id: `ho-old-${i}`, created_at: `2026-01-0${i + 1}T00:00:00Z` };
      handoffs[r.id] = r;
    }
    handoffs["ho-done"] = {
      ...base,
      id: "ho-done",
      status: "done",
      created_at: "2026-02-01T00:00:00Z",
    };
    const removed = pruneHandoffs(handoffs, 5);
    expect(removed).toEqual(["ho-done"]);
    expect(Object.keys(handoffs)).toHaveLength(5);
  });
});

describe("capability document (#224)", () => {
  test("advertises mutation_commands for record/herdr writes only", () => {
    const cli = path.join(import.meta.dir, "../plugins/handoff/src/cli.ts");
    const res = spawnSync(process.execPath, [cli, "capability"], {
      env: testEnv(),
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const doc = JSON.parse(res.stdout) as {
      version: string;
      commands: string[];
      mutation_commands: string[];
    };
    expect(doc.version).toBe("0.7.0");
    expect(doc.mutation_commands).toEqual([
      "create",
      "status",
      "execute",
      "delegate",
      "merge-back",
    ]);
    for (const readOnly of ["list", "resume-info", "remote-probe", "capability"]) {
      expect(doc.mutation_commands).not.toContain(readOnly);
    }
    for (const mutation of doc.mutation_commands) {
      expect(doc.commands).toContain(mutation);
    }
  });
});
