import { describe, expect, test } from "bun:test";
import type { AgentInfo, PaneInfo } from "../packages/herdr-client/src/snapshot";
import {
  agentSessionRef,
  buildInbox,
  resolveEntry,
  resolveState,
  restorePane,
  settlePane,
  snoozePane,
} from "../plugins/inbox/src/model";
import { type AgentSessionRef, emptyState, type InboxState } from "../plugins/inbox/src/state";

const NOW = new Date("2026-01-10T12:00:00Z");
const LATER = new Date("2026-01-10T13:00:00Z");

function pane(id: string, extra: Partial<PaneInfo> = {}): PaneInfo {
  return { pane_id: id, workspace_id: "ws1", tab_id: "tab1", ...extra };
}

function agent(seq: number, status = "done", session?: AgentSessionRef): AgentInfo {
  const info: AgentInfo = { agent_status: status, state_change_seq: seq };
  if (session !== undefined && session.agent !== undefined && session.value !== undefined) {
    info.agent_session = {
      agent: session.agent,
      kind: session.kind ?? "session",
      value: session.value,
    };
  } else {
    info.agent_session = null;
  }
  return info;
}

function stateWith(entry?: Partial<InboxState["entries"][string]>): InboxState {
  const state = emptyState();
  if (entry) {
    state.entries.p1 = {
      pane_id: "p1",
      updated_at: NOW.toISOString(),
      ...entry,
    };
  }
  return state;
}

describe("settle", () => {
  test("settled pane is hidden until state_change_seq advances", () => {
    const state = emptyState();
    settlePane(state, pane("p1"), agent(5, "done"), NOW);
    const agents = { p1: agent(5, "done") };

    const items = buildInbox([pane("p1")], agents, state, NOW);
    expect(items[0]?.in_inbox).toBe(false);
    expect(items[0]?.organize?.kind).toBe("settled");

    const advanced = { p1: agent(6, "working") };
    const restored = buildInbox([pane("p1")], advanced, state, LATER);
    expect(restored[0]?.in_inbox).toBe(true);
    expect(restored[0]?.organize).toBeUndefined();
  });

  test("settle records agent_session fingerprint", () => {
    const session = { agent: "claude", value: "sess-1" };
    const state = emptyState();
    settlePane(state, pane("p1"), agent(5, "done", session), NOW);
    const entry = state.entries.p1;
    expect(entry?.settled?.agent_session?.value).toBe("sess-1");
  });
});

describe("agent identity guard", () => {
  test("different agent_session clears organize marks", () => {
    const state = stateWith({
      settled: {
        at: NOW.toISOString(),
        seq: 5,
        agent_session: { agent: "claude", value: "old" },
      },
    });
    const agents = { p1: agent(5, "done", { agent: "claude", value: "new" }) };
    const result = resolveState(state, agents, NOW);
    expect(result.clearedPaneIds).toContain("p1");
    expect(state.entries.p1).toBeUndefined();
  });

  test("same agent_session with unchanged seq stays organized", () => {
    const session = { agent: "claude", value: "same" };
    const state = stateWith({
      settled: {
        at: NOW.toISOString(),
        seq: 5,
        agent_session: session,
      },
    });
    const agents = { p1: agent(5, "done", session) };
    resolveState(state, agents, NOW);
    expect(state.entries.p1?.settled).toBeDefined();
  });

  test("mark without fingerprint falls back to seq comparison", () => {
    const state = stateWith({
      settled: { at: NOW.toISOString(), seq: 5 },
    });
    const agents = { p1: agent(5, "done", { agent: "anything", value: "x" }) };
    resolveState(state, agents, NOW);
    expect(state.entries.p1?.settled).toBeDefined();
  });
});

describe("snooze", () => {
  test("snoozed pane is hidden until deadline", () => {
    const state = emptyState();
    snoozePane(state, pane("p1"), agent(3, "working"), LATER, NOW);

    const during = buildInbox([pane("p1")], { p1: agent(3, "working") }, state, NOW);
    expect(during[0]?.in_inbox).toBe(false);
    expect(during[0]?.organize).toMatchObject({
      kind: "snoozed",
      until: LATER.toISOString(),
    });

    const after = buildInbox(
      [pane("p1")],
      { p1: agent(3, "working") },
      state,
      new Date("2026-01-10T14:00:00Z"),
    );
    expect(after[0]?.in_inbox).toBe(true);
    expect(after[0]?.organize).toBeUndefined();
  });

  test("seq advance wakes snoozed pane early", () => {
    const state = emptyState();
    snoozePane(state, pane("p1"), agent(3, "working"), LATER, NOW);
    const items = buildInbox([pane("p1")], { p1: agent(4, "done") }, state, NOW);
    expect(items[0]?.in_inbox).toBe(true);
  });

  test("snooze replaces settle and vice versa", () => {
    const state = emptyState();
    settlePane(state, pane("p1"), agent(1, "done"), NOW);
    snoozePane(state, pane("p1"), agent(1, "done"), LATER, NOW);
    expect(state.entries.p1?.settled).toBeUndefined();
    expect(state.entries.p1?.snoozed).toBeDefined();

    settlePane(state, pane("p1"), agent(1, "done"), NOW);
    expect(state.entries.p1?.snoozed).toBeUndefined();
    expect(state.entries.p1?.settled).toBeDefined();
  });
});

describe("attention invariant", () => {
  test("blocked pane stays in inbox even with organize marks", () => {
    const state = emptyState();
    settlePane(state, pane("p1"), agent(5, "blocked"), NOW);
    const items = buildInbox([pane("p1")], { p1: agent(5, "blocked") }, state, NOW);
    expect(items[0]?.attention).toBe(true);
    expect(items[0]?.in_inbox).toBe(true);
  });
});

describe("restore", () => {
  test("restore removes the entry entirely", () => {
    const state = emptyState();
    settlePane(state, pane("p1"), agent(5, "done"), NOW);
    expect(restorePane(state, "p1")).toBe(true);
    expect(state.entries.p1).toBeUndefined();
    expect(restorePane(state, "p1")).toBe(false);
  });
});

describe("missing panes", () => {
  test("organize entries for closed panes are retained but not in inbox", () => {
    const state = stateWith({
      settled: { at: NOW.toISOString(), seq: 5 },
    });
    const items = buildInbox([], {}, state, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.in_inbox).toBe(false);
    expect(items[0]?.organize?.kind).toBe("settled");
  });
});

describe("resolveEntry", () => {
  test("clears both marks independently", () => {
    const entry = {
      pane_id: "p1",
      updated_at: NOW.toISOString(),
      settled: { at: NOW.toISOString(), seq: 2 },
      snoozed: { at: NOW.toISOString(), until: LATER.toISOString(), seq: 9 },
    };
    // seq 3 > settled.seq(2) clears settle; seq 3 < snoozed.seq(9) keeps snooze.
    const result = resolveEntry(entry, agent(3, "working"), NOW);
    expect(entry.settled).toBeUndefined();
    expect(entry.snoozed).toBeDefined();
    expect(result.organize?.kind).toBe("snoozed");
    expect(result.cleared).toBe(true);
  });
});

describe("agentSessionRef", () => {
  test("extracts stable fingerprint fields", () => {
    const ref = agentSessionRef({
      agent_status: "done",
      agent_session: { agent: "claude", kind: "session", value: "v1", extra: 1 },
    });
    expect(ref).toEqual({ agent: "claude", kind: "session", value: "v1" });
    expect(agentSessionRef({ agent_status: "done", agent_session: null })).toBeNull();
    expect(agentSessionRef(undefined)).toBeNull();
  });
});
