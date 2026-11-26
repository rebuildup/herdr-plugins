import { describe, expect, test } from "bun:test";
import type { AgentInfo, PaneInfo } from "../packages/herdr-client/src/snapshot";
import {
  agentSessionRef,
  applyInboxFilters,
  archivePane,
  buildInbox,
  computeOrderRanks,
  type InboxItem,
  linkPane,
  pinPane,
  pruneState,
  resolveEntry,
  resolveState,
  restorePane,
  settlePane,
  snoozePane,
  toPublicLink,
  unarchivePane,
  unlinkPane,
  unpinPane,
} from "../plugins/inbox/src/model";
import type { AgentSessionRef, InboxEntry } from "../plugins/inbox/src/state";

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

function entriesWith(entry?: Partial<InboxEntry>): Record<string, InboxEntry> {
  const entries: Record<string, InboxEntry> = {};
  if (entry) {
    entries.p1 = {
      pane_id: "p1",
      updated_at: NOW.toISOString(),
      ...entry,
    };
  }
  return entries;
}

describe("settle", () => {
  test("settled pane is hidden until state_change_seq advances", () => {
    const entries: Record<string, InboxEntry> = {};
    settlePane(entries, pane("p1"), agent(5, "done"), NOW);
    const agents = { p1: agent(5, "done") };

    const items = buildInbox([pane("p1")], agents, entries, NOW);
    expect(items[0]?.in_inbox).toBe(false);
    expect(items[0]?.organize?.kind).toBe("settled");

    const advanced = { p1: agent(6, "working") };
    const restored = buildInbox([pane("p1")], advanced, entries, LATER);
    expect(restored[0]?.in_inbox).toBe(true);
    expect(restored[0]?.organize).toBeUndefined();
  });

  test("settle records agent_session fingerprint", () => {
    const session = { agent: "claude", value: "sess-1" };
    const entries: Record<string, InboxEntry> = {};
    settlePane(entries, pane("p1"), agent(5, "done", session), NOW);
    const entry = entries.p1;
    expect(entry?.settled?.agent_session?.value).toBe("sess-1");
  });
});

describe("agent identity guard", () => {
  test("different agent_session clears organize marks", () => {
    const entries = entriesWith({
      settled: {
        at: NOW.toISOString(),
        seq: 5,
        agent_session: { agent: "claude", value: "old" },
      },
    });
    const agents = { p1: agent(5, "done", { agent: "claude", value: "new" }) };
    const result = resolveState(entries, agents, NOW);
    expect(result.clearedPaneIds).toContain("p1");
    expect(entries.p1).toBeUndefined();
  });

  test("same agent_session with unchanged seq stays organized", () => {
    const session = { agent: "claude", value: "same" };
    const entries = entriesWith({
      settled: {
        at: NOW.toISOString(),
        seq: 5,
        agent_session: session,
      },
    });
    const agents = { p1: agent(5, "done", session) };
    resolveState(entries, agents, NOW);
    expect(entries.p1?.settled).toBeDefined();
  });

  test("mark without fingerprint wakes when an agent session appears", () => {
    const entries = entriesWith({
      settled: { at: NOW.toISOString(), seq: 5 },
    });
    const agents = { p1: agent(5, "done", { agent: "anything", value: "x" }) };
    resolveState(entries, agents, NOW);
    expect(entries.p1).toBeUndefined();
  });

  test("mark recorded before agent detection wakes on first seq", () => {
    const entries = entriesWith({
      settled: { at: NOW.toISOString(), seq: -1 },
    });
    // No agent yet: stays organized.
    resolveState(entries, {}, NOW);
    expect(entries.p1?.settled).toBeDefined();
    // Agent appears with seq 1: generation advanced from -1.
    resolveState(entries, { p1: agent(1, "idle") }, NOW);
    expect(entries.p1).toBeUndefined();
  });
});

describe("snooze", () => {
  test("snoozed pane is hidden until deadline", () => {
    const entries: Record<string, InboxEntry> = {};
    snoozePane(entries, pane("p1"), agent(3, "working"), LATER, NOW);

    const during = buildInbox([pane("p1")], { p1: agent(3, "working") }, entries, NOW);
    expect(during[0]?.in_inbox).toBe(false);
    expect(during[0]?.organize).toMatchObject({
      kind: "snoozed",
      until: LATER.toISOString(),
    });

    const after = buildInbox(
      [pane("p1")],
      { p1: agent(3, "working") },
      entries,
      new Date("2026-01-10T14:00:00Z"),
    );
    expect(after[0]?.in_inbox).toBe(true);
    expect(after[0]?.organize).toBeUndefined();
  });

  test("seq advance wakes snoozed pane early", () => {
    const entries: Record<string, InboxEntry> = {};
    snoozePane(entries, pane("p1"), agent(3, "working"), LATER, NOW);
    const items = buildInbox([pane("p1")], { p1: agent(4, "done") }, entries, NOW);
    expect(items[0]?.in_inbox).toBe(true);
  });

  test("snooze replaces settle and vice versa", () => {
    const entries: Record<string, InboxEntry> = {};
    settlePane(entries, pane("p1"), agent(1, "done"), NOW);
    snoozePane(entries, pane("p1"), agent(1, "done"), LATER, NOW);
    expect(entries.p1?.settled).toBeUndefined();
    expect(entries.p1?.snoozed).toBeDefined();

    settlePane(entries, pane("p1"), agent(1, "done"), NOW);
    expect(entries.p1?.snoozed).toBeUndefined();
    expect(entries.p1?.settled).toBeDefined();
  });
});

describe("attention invariant", () => {
  test("blocked pane stays in inbox even with organize marks", () => {
    const entries: Record<string, InboxEntry> = {};
    settlePane(entries, pane("p1"), agent(5, "blocked"), NOW);
    const items = buildInbox([pane("p1")], { p1: agent(5, "blocked") }, entries, NOW);
    expect(items[0]?.attention).toBe(true);
    expect(items[0]?.in_inbox).toBe(true);
  });
});

describe("restore", () => {
  test("restore removes the entry entirely", () => {
    const entries: Record<string, InboxEntry> = {};
    settlePane(entries, pane("p1"), agent(5, "done"), NOW);
    expect(restorePane(entries, "p1")).toBe(true);
    expect(entries.p1).toBeUndefined();
    expect(restorePane(entries, "p1")).toBe(false);
  });
});

describe("missing panes", () => {
  test("organize entries for closed panes are retained but not in inbox", () => {
    const entries = entriesWith({
      settled: { at: NOW.toISOString(), seq: 5 },
    });
    const items = buildInbox([], {}, entries, NOW);
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

describe("pruneState", () => {
  test("drops entries for panes absent longer than retention", () => {
    const entries: Record<string, InboxEntry> = {};
    entries.old = {
      pane_id: "old",
      updated_at: "2026-01-01T00:00:00Z",
      settled: { at: "2026-01-01T00:00:00Z", seq: 1 },
    };
    entries.recent = {
      pane_id: "recent",
      updated_at: "2026-01-10T11:00:00Z",
      settled: { at: "2026-01-10T11:00:00Z", seq: 1 },
    };
    const removed = pruneState(entries, new Set(["live"]), NOW);
    expect(removed).toEqual(["old"]);
    expect(entries.old).toBeUndefined();
    expect(entries.recent).toBeDefined();
  });

  test("never prunes live panes; enforces maxEntries cap", () => {
    const entries: Record<string, InboxEntry> = {};
    for (let i = 0; i < 5; i += 1) {
      entries[`p${i}`] = {
        pane_id: `p${i}`,
        updated_at: `2026-01-10T10:0${i}:00Z`,
        settled: { at: "2026-01-10T10:00:00Z", seq: 1 },
      };
    }
    const live = new Set(["p0", "p1", "p2", "p3", "p4"]);
    const removed = pruneState(entries, live, NOW, { maxEntries: 3 });
    expect(removed).toHaveLength(2);
    expect(removed).toEqual(["p0", "p1"]);
    expect(Object.keys(entries)).toHaveLength(3);
  });
});

describe("pin", () => {
  test("pinned pane stays in inbox and sorts first", () => {
    const entries: Record<string, InboxEntry> = {};
    pinPane(entries, pane("p2"), agent(1, "done"), NOW);
    const panes = [pane("p1"), pane("p2")];
    const agents = { p1: agent(1, "done"), p2: agent(1, "done") };
    const items = buildInbox(panes, agents, entries, NOW);
    expect(items[0]?.pane_id).toBe("p2");
    expect(items[0]?.pinned).toBe(true);
    expect(items[0]?.in_inbox).toBe(true);
    expect(items[1]?.pinned).toBe(false);
  });

  test("pin survives settle/archive hide-kinds but not generation advance", () => {
    const entries: Record<string, InboxEntry> = {};
    pinPane(entries, pane("p1"), agent(5, "done"), NOW);
    settlePane(entries, pane("p1"), agent(5, "done"), NOW);
    expect(entries.p1?.pinned).toBeDefined();
    expect(entries.p1?.settled).toBeDefined();

    // seq advance clears the pin mark like every other organize mark.
    const items = buildInbox([pane("p1")], { p1: agent(6, "working") }, entries, LATER);
    expect(items[0]?.pinned).toBe(false);
    expect(items[0]?.organize).toBeUndefined();
  });

  test("pinned + blocked stays visible with attention flag", () => {
    const entries: Record<string, InboxEntry> = {};
    pinPane(entries, pane("p1"), agent(5, "blocked"), NOW);
    settlePane(entries, pane("p1"), agent(5, "blocked"), NOW);
    const items = buildInbox([pane("p1")], { p1: agent(5, "blocked") }, entries, NOW);
    expect(items[0]?.attention).toBe(true);
    expect(items[0]?.in_inbox).toBe(true);
    expect(items[0]?.pinned).toBe(true);
  });

  test("unpin removes mark and drops empty entry", () => {
    const entries: Record<string, InboxEntry> = {};
    pinPane(entries, pane("p1"), agent(1, "done"), NOW);
    expect(unpinPane(entries, "p1", NOW)).toBe(true);
    expect(entries.p1).toBeUndefined();
    expect(unpinPane(entries, "p1", NOW)).toBe(false);
  });
});

describe("archive", () => {
  test("archived pane is hidden with organize.kind archived", () => {
    const entries: Record<string, InboxEntry> = {};
    archivePane(entries, pane("p1"), agent(5, "done"), NOW);
    const items = buildInbox([pane("p1")], { p1: agent(5, "done") }, entries, NOW);
    expect(items[0]?.in_inbox).toBe(false);
    expect(items[0]?.organize?.kind).toBe("archived");
  });

  test("attention forces archived pane back into inbox without clearing the mark", () => {
    const entries: Record<string, InboxEntry> = {};
    archivePane(entries, pane("p1"), agent(5, "done"), NOW);
    const items = buildInbox([pane("p1")], { p1: agent(5, "blocked") }, entries, NOW);
    expect(items[0]?.attention).toBe(true);
    expect(items[0]?.in_inbox).toBe(true);
    expect(items[0]?.organize?.kind).toBe("archived");
    // When attention clears (same seq), the pane is hidden again.
    const after = buildInbox([pane("p1")], { p1: agent(5, "done") }, entries, LATER);
    expect(after[0]?.in_inbox).toBe(false);
  });

  test("archive auto-clears on generation advance like settle", () => {
    const entries: Record<string, InboxEntry> = {};
    archivePane(entries, pane("p1"), agent(5, "done"), NOW);
    const items = buildInbox([pane("p1")], { p1: agent(6, "working") }, entries, LATER);
    expect(items[0]?.in_inbox).toBe(true);
    expect(items[0]?.organize).toBeUndefined();
    // resolveState drops the emptied entry.
    resolveState(entries, { p1: agent(6, "working") }, LATER);
    expect(entries.p1).toBeUndefined();
  });

  test("archive is exclusive with settle/snooze; unarchive is reversible", () => {
    const entries: Record<string, InboxEntry> = {};
    settlePane(entries, pane("p1"), agent(1, "done"), NOW);
    archivePane(entries, pane("p1"), agent(1, "done"), NOW);
    expect(entries.p1?.settled).toBeUndefined();
    expect(entries.p1?.archived).toBeDefined();

    snoozePane(entries, pane("p1"), agent(1, "done"), LATER, NOW);
    expect(entries.p1?.archived).toBeUndefined();
    expect(entries.p1?.snoozed).toBeDefined();

    archivePane(entries, pane("p1"), agent(1, "done"), NOW);
    expect(unarchivePane(entries, "p1", NOW)).toBe(true);
    expect(entries.p1).toBeUndefined();
  });

  test("unarchive keeps pin and order", () => {
    const entries: Record<string, InboxEntry> = {};
    pinPane(entries, pane("p1"), agent(1, "done"), NOW);
    archivePane(entries, pane("p1"), agent(1, "done"), NOW);
    const entry = entries.p1;
    expect(entry).toBeDefined();
    if (entry) entry.order = 3;
    unarchivePane(entries, "p1", NOW);
    expect(entries.p1?.pinned).toBeDefined();
    expect(entries.p1?.order).toBe(3);
    expect(entries.p1?.archived).toBeUndefined();
  });
});

describe("manual order", () => {
  test("order rank sorts before unordered items", () => {
    const entries: Record<string, InboxEntry> = {};
    entries.p2 = { pane_id: "p2", updated_at: NOW.toISOString(), order: 0 };
    const items = buildInbox([pane("p1"), pane("p2")], {}, entries, NOW);
    expect(items.map((i) => i.pane_id)).toEqual(["p2", "p1"]);
    expect(items[0]?.order).toBe(0);
    expect(items[1]?.order).toBeUndefined();
  });

  test("pinned+attention groups still dominate order", () => {
    const entries: Record<string, InboxEntry> = {};
    entries.p1 = { pane_id: "p1", updated_at: NOW.toISOString(), order: 5 };
    pinPane(entries, pane("p2"), agent(1, "done"), NOW);
    const items = buildInbox([pane("p1"), pane("p2")], { p2: agent(1, "done") }, entries, NOW);
    expect(items[0]?.pane_id).toBe("p2");
  });

  test("order-only entries survive resolveState", () => {
    const entries: Record<string, InboxEntry> = {
      p1: { pane_id: "p1", updated_at: NOW.toISOString(), order: 2 },
    };
    resolveState(entries, {}, NOW);
    expect(entries.p1).toBeDefined();
  });
});

describe("computeOrderRanks", () => {
  function item(id: string, extra: Partial<InboxItem> = {}): InboxItem {
    return { pane_id: id, in_inbox: true, attention: false, pinned: false, links: [], ...extra };
  }

  test("before/after/first/last produce dense ranks", () => {
    const siblings = [item("a"), item("b"), item("c")];
    const before = computeOrderRanks(siblings, "c", { kind: "before", paneId: "a" });
    expect(before).not.toHaveProperty("error");
    const beforeMap = before as Map<string, number>;
    expect(beforeMap.get("c")).toBe(0);
    expect(beforeMap.get("a")).toBe(1);

    const after = computeOrderRanks(siblings, "a", { kind: "after", paneId: "c" });
    expect((after as Map<string, number>).get("a")).toBe(3 - 1);

    const first = computeOrderRanks(siblings, "c", { kind: "first" });
    expect((first as Map<string, number>).get("c")).toBe(0);

    const last = computeOrderRanks(siblings, "a", { kind: "last" });
    expect((last as Map<string, number>).get("a")).toBe(2);
  });

  test("rejects unknown moved or reference pane", () => {
    const siblings = [item("a"), item("b")];
    expect(computeOrderRanks(siblings, "z", { kind: "first" })).toHaveProperty("error");
    expect(computeOrderRanks(siblings, "a", { kind: "before", paneId: "z" })).toHaveProperty(
      "error",
    );
  });
});

describe("explicit tracker links", () => {
  const LINK = { kind: "pr" as const, repo: "owner/repo", number: 42, ref: "owner/repo#42" };

  test("linkPane stores a link surfaced on the inbox item", () => {
    const entries: Record<string, InboxEntry> = {};
    linkPane(entries, pane("p1"), agent(3, "working"), LINK, NOW);
    const items = buildInbox([pane("p1")], { p1: agent(3, "working") }, entries, NOW);
    expect(items[0]?.links).toEqual([
      { kind: "pr", repo: "owner/repo", number: 42, ref: "owner/repo#42", at: NOW.toISOString() },
    ]);
    // Public view never leaks fingerprint/seq internals.
    expect(toPublicLink(entries.p1?.links?.[0] as never)).not.toHaveProperty("agent_session");
  });

  test("links survive routine state_change_seq advances (status transitions)", () => {
    const session = { agent: "claude", value: "s1" };
    const entries: Record<string, InboxEntry> = {};
    linkPane(entries, pane("p1"), agent(3, "working", session), LINK, NOW);
    // Same session, seq advanced by a status change: link must persist —
    // unlike organize marks, links are not hide-kinds.
    const items = buildInbox([pane("p1")], { p1: agent(9, "done", session) }, entries, LATER);
    expect(items[0]?.links).toHaveLength(1);
    expect(entries.p1?.links).toHaveLength(1);
  });

  test("agent_session fingerprint change drops the link (no misapplication)", () => {
    const entries: Record<string, InboxEntry> = {};
    linkPane(
      entries,
      pane("p1"),
      agent(3, "working", { agent: "claude", value: "old" }),
      LINK,
      NOW,
    );
    const agents = { p1: agent(3, "working", { agent: "claude", value: "new" }) };
    const items = buildInbox([pane("p1")], agents, entries, LATER);
    expect(items[0]?.links).toEqual([]);
    expect(entries.p1?.links).toBeUndefined();
  });

  test("link recorded without fingerprint clears when an agent session appears", () => {
    const entries: Record<string, InboxEntry> = {};
    // Plain shell pane (no agent): fingerprint is null.
    linkPane(entries, pane("p1"), undefined, LINK, NOW);
    const agents = { p1: agent(1, "working", { agent: "claude", value: "s1" }) };
    buildInbox([pane("p1")], agents, entries, LATER);
    expect(entries.p1?.links).toBeUndefined();
  });

  test("seq regression drops the link (recycled pane/agent identity)", () => {
    const entries: Record<string, InboxEntry> = {};
    linkPane(entries, pane("p1"), agent(8, "working"), LINK, NOW);
    // A fresh agent reporting a lower seq on the same pane id.
    const items = buildInbox([pane("p1")], { p1: agent(2, "working") }, entries, LATER);
    expect(items[0]?.links).toEqual([]);
  });

  test("re-linking the same ref re-stamps the fingerprint (explicit re-validation)", () => {
    const entries: Record<string, InboxEntry> = {};
    linkPane(entries, pane("p1"), agent(3, "working", { agent: "a", value: "old" }), LINK, NOW);
    const later = new Date("2026-01-10T14:00:00Z");
    linkPane(entries, pane("p1"), agent(3, "working", { agent: "a", value: "new" }), LINK, later);
    expect(entries.p1?.links).toHaveLength(1);
    expect(entries.p1?.links?.[0]?.at).toBe(later.toISOString());
    expect(entries.p1?.links?.[0]?.agent_session?.value).toBe("new");
  });

  test("unlinkPane removes only the matching link and drops empty entries", () => {
    const entries: Record<string, InboxEntry> = {};
    linkPane(entries, pane("p1"), agent(1, "done"), LINK, NOW);
    linkPane(
      entries,
      pane("p1"),
      agent(1, "done"),
      { kind: "issue", repo: "owner/repo", number: 7, ref: "owner/repo#7" },
      NOW,
    );
    const removed = unlinkPane(entries, "p1", "pr", "owner/repo", 42, NOW);
    expect(removed?.ref).toBe("owner/repo#42");
    expect(entries.p1?.links).toHaveLength(1);
    expect(unlinkPane(entries, "p1", "issue", "owner/repo", 7, NOW)?.number).toBe(7);
    expect(entries.p1).toBeUndefined();
    expect(unlinkPane(entries, "p1", "pr", "owner/repo", 42, NOW)).toBeUndefined();
  });

  test("links-only entries survive resolveState and retention pruning", () => {
    const entries: Record<string, InboxEntry> = {};
    linkPane(entries, pane("p1"), agent(1, "done"), LINK, NOW);
    resolveState(entries, { p1: agent(1, "done") }, NOW);
    expect(entries.p1).toBeDefined();
    const pruned = pruneState(entries, new Set(["p1"]), NOW);
    expect(pruned).toEqual([]);
    expect(entries.p1?.links).toHaveLength(1);
  });

  test("restore preserves declared links while clearing organize state", () => {
    const entries: Record<string, InboxEntry> = {};
    linkPane(entries, pane("p1"), agent(1, "done"), LINK, NOW);
    settlePane(entries, pane("p1"), agent(1, "done"), NOW);
    restorePane(entries, "p1");
    expect(entries.p1?.settled).toBeUndefined();
    expect(entries.p1?.links).toHaveLength(1);
  });

  test("absent panes keep links and surface them as in_inbox:false items", () => {
    const entries: Record<string, InboxEntry> = {};
    linkPane(entries, pane("gone"), agent(1, "done"), LINK, NOW);
    const items = buildInbox([], {}, entries, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.pane_id).toBe("gone");
    expect(items[0]?.in_inbox).toBe(false);
    expect(items[0]?.links).toHaveLength(1);
  });
});

describe("applyInboxFilters", () => {
  function item(id: string, extra: Partial<InboxItem> = {}): InboxItem {
    return {
      pane_id: id,
      workspace_id: "ws1",
      title: `task ${id}`,
      cwd: "/repo/app",
      in_inbox: true,
      attention: false,
      pinned: false,
      links: [],
      ...extra,
    };
  }

  const items = [
    item("w1:p1", { attention: true }),
    item("w1:p2", { organize: { kind: "settled", since: NOW.toISOString() } }),
    item("w1:p3", { organize: { kind: "archived", since: NOW.toISOString() } }),
    item("w2:p9", { workspace_id: "ws2", title: "deploy pipeline", cwd: "/other" }),
  ];

  test("attention filter keeps only attention items", () => {
    expect(applyInboxFilters(items, { attention: true }).map((i) => i.pane_id)).toEqual(["w1:p1"]);
  });

  test("organize filter matches kinds; none means no hide-kind", () => {
    expect(applyInboxFilters(items, { organize: "settled" }).map((i) => i.pane_id)).toEqual([
      "w1:p2",
    ]);
    expect(applyInboxFilters(items, { organize: "archived" }).map((i) => i.pane_id)).toEqual([
      "w1:p3",
    ]);
    expect(
      applyInboxFilters(items, { organize: "none" })
        .map((i) => i.pane_id)
        .sort(),
    ).toEqual(["w1:p1", "w2:p9"]);
  });

  test("search is case-insensitive over title/cwd/pane_id", () => {
    expect(applyInboxFilters(items, { search: "DEPLOY" }).map((i) => i.pane_id)).toEqual(["w2:p9"]);
    expect(applyInboxFilters(items, { search: "w1:p2" }).map((i) => i.pane_id)).toEqual(["w1:p2"]);
    expect(applyInboxFilters(items, { search: "/repo/app" })).toHaveLength(3);
    expect(applyInboxFilters(items, { search: "nomatch" })).toHaveLength(0);
  });

  test("workspace filter is exact and composes with others", () => {
    expect(applyInboxFilters(items, { workspace: "ws2" }).map((i) => i.pane_id)).toEqual(["w2:p9"]);
    expect(
      applyInboxFilters(items, { workspace: "ws1", organize: "none", attention: true }),
    ).toHaveLength(1);
    expect(applyInboxFilters(items, {})).toHaveLength(4);
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
