import { describe, expect, test } from "bun:test";
import { type KeyEvent, KeyParser } from "../packages/tui/src/input";
import type { InboxItem } from "../plugins/inbox/src/model";
import { InboxView, plainList } from "../plugins/inbox/src/tui";
import {
  cliErrorMessage,
  type ListPayload,
  nextScope,
  orderMoveTarget,
  parseLinkSpec,
  parseListOutput,
  scopeLabel,
  staleCheck,
  validateSnoozeSpec,
  visibleItems,
} from "../plugins/inbox/src/tui-model";

function mkItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    pane_id: "w1:p1",
    workspace_id: "w1",
    title: "agent one",
    cwd: "/repo",
    agent_status: "done",
    state_change_seq: 3,
    agent_session: { agent: "claude", kind: "session", value: "abc" },
    pinned: false,
    attention: false,
    in_inbox: true,
    links: [],
    ...overrides,
  };
}

function feed(view: InboxView, ...feeds: string[]): boolean[] {
  const parser = new KeyParser();
  const results: boolean[] = [];
  for (const f of feeds) {
    for (const ev of parser.feed(f)) {
      results.push(view.handleKey(ev as KeyEvent) === true);
    }
  }
  return results;
}

describe("parseListOutput", () => {
  test("parses a valid list payload", () => {
    const stdout = JSON.stringify({
      contract: "herdr-plugins.inbox/v1",
      items: [mkItem()],
      counts: { total: 1, inbox: 1 },
    });
    const result = parseListOutput(stdout);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.items).toHaveLength(1);
      expect(result.payload.items?.[0]?.pane_id).toBe("w1:p1");
    }
  });

  test("rejects non-JSON and missing items", () => {
    expect(parseListOutput("not json").ok).toBe(false);
    expect(parseListOutput("{}").ok).toBe(false);
    expect(parseListOutput("null").ok).toBe(false);
  });

  test("surfaces structured cli errors", () => {
    const result = parseListOutput(
      JSON.stringify({ ok: false, error: { code: "error", message: "boom" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("boom");
  });
});

describe("cliErrorMessage", () => {
  test("prefers the JSON error document on stderr", () => {
    const stderr = JSON.stringify({
      ok: false,
      error: { code: "error", message: "pane not found" },
    });
    expect(cliErrorMessage(1, "", stderr)).toBe("pane not found");
  });

  test("falls back to raw text then exit status", () => {
    expect(cliErrorMessage(1, "", "plain failure\n")).toBe("plain failure");
    expect(cliErrorMessage(3, "", "")).toBe("cli exited with status 3");
  });
});

describe("visibleItems / scopes", () => {
  const items = [
    mkItem({ pane_id: "w1:p1", title: "alpha fix" }),
    mkItem({
      pane_id: "w1:p2",
      title: "beta",
      attention: true,
      agent_status: "blocked",
      in_inbox: true,
    }),
    mkItem({
      pane_id: "w1:p3",
      title: "gamma chore",
      organize: { kind: "settled", since: "2026-01-01T00:00:00Z" },
      in_inbox: false,
    }),
    mkItem({
      pane_id: "w1:p4",
      title: "delta pr",
      links: [{ kind: "pr", repo: "o/r", number: 5, ref: "o/r#5", at: "x" }],
    }),
  ];

  test("inbox scope hides organized items", () => {
    expect(visibleItems(items, "inbox", "").map((i) => i.pane_id)).toEqual([
      "w1:p1",
      "w1:p2",
      "w1:p4",
    ]);
  });

  test("hidden and attention scopes", () => {
    expect(visibleItems(items, "hidden", "").map((i) => i.pane_id)).toEqual(["w1:p3"]);
    expect(visibleItems(items, "attention", "").map((i) => i.pane_id)).toEqual(["w1:p2"]);
    expect(visibleItems(items, "all", "")).toHaveLength(4);
  });

  test("text query is case-insensitive AND over terms", () => {
    expect(visibleItems(items, "all", "ALPHA").map((i) => i.pane_id)).toEqual(["w1:p1"]);
    expect(visibleItems(items, "all", "o/r#5").map((i) => i.pane_id)).toEqual(["w1:p4"]);
    expect(visibleItems(items, "all", "alpha missing")).toHaveLength(0);
  });

  test("scope cycle covers all scopes", () => {
    expect(nextScope("inbox")).toBe("all");
    expect(nextScope("attention")).toBe("inbox");
    expect(scopeLabel("hidden")).toBe("organized/hidden");
  });
});

describe("staleCheck", () => {
  const base = mkItem();

  test("ok when generation signals match", () => {
    expect(staleCheck(base, mkItem()).kind).toBe("ok");
  });

  test("gone when the pane left the session", () => {
    const v = staleCheck(base, undefined);
    expect(v.kind).toBe("gone");
  });

  test("stale on state_change_seq advance", () => {
    const v = staleCheck(base, mkItem({ state_change_seq: 4 }));
    expect(v.kind).toBe("stale");
    if (v.kind === "stale") expect(v.reason).toContain("state_change_seq");
  });

  test("stale on agent-session fingerprint change", () => {
    const v = staleCheck(
      base,
      mkItem({ agent_session: { agent: "codex", kind: "session", value: "zzz" } }),
    );
    expect(v.kind).toBe("stale");
  });

  test("missing selection is gone", () => {
    expect(staleCheck(undefined, base).kind).toBe("gone");
  });
});

describe("parseLinkSpec", () => {
  test("pr and issue specs", () => {
    expect(parseLinkSpec("pr rebuildup/herdr-plugins#237")).toEqual({
      ok: true,
      kind: "pr",
      flag: "--pr",
      ref: "rebuildup/herdr-plugins#237",
    });
    expect(parseLinkSpec("issue owner/repo#12")).toMatchObject({
      ok: true,
      kind: "issue",
      flag: "--issue",
    });
  });

  test("rejects malformed input", () => {
    expect(parseLinkSpec("hello").ok).toBe(false);
    expect(parseLinkSpec("pr not-a-ref").ok).toBe(false);
    expect(parseLinkSpec("pr owner/repo#0").ok).toBe(false);
  });
});

describe("validateSnoozeSpec", () => {
  test("accepts durations and ISO", () => {
    expect(validateSnoozeSpec("+30m")).toEqual({ ok: true, spec: "+30m" });
    expect(validateSnoozeSpec("2h")).toEqual({ ok: true, spec: "2h" });
    expect(validateSnoozeSpec("2026-01-10T18:00:00Z").ok).toBe(true);
  });

  test("rejects garbage", () => {
    expect(validateSnoozeSpec("").ok).toBe(false);
    expect(validateSnoozeSpec("soon").ok).toBe(false);
    expect(validateSnoozeSpec("2026-13-99T99:99:99Z").ok).toBe(false);
  });
});

describe("orderMoveTarget", () => {
  const group = [
    mkItem({ pane_id: "w1:p1", pinned: true, order: 0 }),
    mkItem({ pane_id: "w1:p2", pinned: true, order: 1 }),
    mkItem({ pane_id: "w1:p3", pinned: true, order: 2 }),
    mkItem({ pane_id: "w1:p4" }), // different group (unpinned)
  ];

  test("moves within the same pinned group only", () => {
    expect(orderMoveTarget(group, "w1:p2", "up")).toEqual({
      ok: true,
      flag: "--before",
      refPaneId: "w1:p1",
    });
    expect(orderMoveTarget(group, "w1:p2", "down")).toEqual({
      ok: true,
      flag: "--after",
      refPaneId: "w1:p3",
    });
  });

  test("group boundaries and non-inbox items error honestly", () => {
    expect(orderMoveTarget(group, "w1:p1", "up").ok).toBe(false);
    expect(orderMoveTarget(group, "w1:p3", "down").ok).toBe(false);
    expect(orderMoveTarget([mkItem({ pane_id: "w1:p9", in_inbox: false })], "w1:p9", "up").ok).toBe(
      false,
    );
  });
});

describe("InboxView", () => {
  function readyView(items: InboxItem[]) {
    const view = new InboxView();
    view.setItems(items, "2026-01-10T00:00:00Z", "test-session");
    return view;
  }

  test("navigation moves the cursor and clamps", () => {
    const view = readyView([mkItem({ pane_id: "w1:p1" }), mkItem({ pane_id: "w1:p2" })]);
    feed(view, "j");
    expect(view.cursor).toBe(1);
    feed(view, "k");
    expect(view.cursor).toBe(0);
    feed(view, "\x1b[B"); // down arrow
    expect(view.cursor).toBe(1);
  });

  test("filter mode edits a draft and commits on enter", () => {
    const view = readyView([
      mkItem({ pane_id: "w1:p1", title: "alpha" }),
      mkItem({ pane_id: "w1:p2", title: "beta" }),
    ]);
    feed(view, "/", "bet", "\r");
    expect(view.query).toBe("bet");
    expect(view.filterMode).toBe(false);
    expect(view.current()?.pane_id).toBe("w1:p2");
  });

  test("scope cycle and verb callbacks", () => {
    const view = readyView([mkItem({ pane_id: "w1:p1" })]);
    const verbs: string[] = [];
    view.onVerb = (key) => verbs.push(key);
    feed(view, "f");
    expect(view.scope).toBe("all");
    feed(view, "s");
    expect(verbs).toEqual(["s"]);
    feed(view, "c");
    expect(verbs).toEqual(["s", "c"]);
  });

  test("reserved keys are NOT consumed (app handles help/quit)", () => {
    const view = readyView([mkItem()]);
    for (const k of ["q", "?", "h", "\x1b"]) {
      const parser = new KeyParser();
      const events = parser.feed(k);
      for (const ev of events) {
        expect(view.handleKey(ev as KeyEvent)).toBe(false);
      }
    }
  });

  test("render shows items, badges, and honest empty state", () => {
    const view = readyView([
      mkItem({
        pane_id: "w1:p1",
        title: "alpha",
        pinned: true,
        links: [{ kind: "pr", repo: "o/r", number: 1, ref: "o/r#1", at: "x" }],
      }),
    ]);
    const lines = view.render(100, 24).map((l) => l.map((s) => s.text).join(""));
    const joined = lines.join("\n");
    expect(joined).toContain("w1:p1");
    expect(joined).toContain("alpha");
    expect(joined).toContain("pin");
    expect(joined).toContain("links:1");

    const empty = new InboxView();
    empty.setItems([], null, "s");
    const emptyText = empty
      .render(100, 24)
      .map((l) => l.map((s) => s.text).join(""))
      .join("\n");
    expect(emptyText).toContain("(empty)");
    expect(emptyText).toContain("no agent panes");
  });

  test("error state renders the message and CLI fallback", () => {
    const view = new InboxView();
    view.setError("socket unreachable");
    const text = view
      .render(100, 24)
      .map((l) => l.map((s) => s.text).join(""))
      .join("\n");
    expect(text).toContain("socket unreachable");
    expect(text).toContain("src/cli.ts list");
  });
});

describe("plainList", () => {
  test("renders counts and item lines without ANSI", () => {
    const payload: ListPayload = {
      session: { name: "verify237", socket: null },
      counts: { total: 2, inbox: 2, attention: 1, organized: 0, pinned: 1, archived: 0, linked: 1 },
      items: [
        mkItem({ pane_id: "w1:p1", title: "alpha", pinned: true }),
        mkItem({
          pane_id: "w1:p2",
          title: "beta",
          attention: true,
          agent_status: "blocked",
          in_inbox: false,
          organize: { kind: "settled", since: "x" },
          links: [{ kind: "issue", repo: "o/r", number: 3, ref: "o/r#3", at: "x" }],
        }),
      ],
    };
    const lines = plainList(payload);
    const joined = lines.join("\n");
    expect(joined).toContain("verify237");
    expect(joined).toContain("w1:p1");
    expect(joined).toContain("(hidden)");
    expect(joined).toContain("o/r#3");
    expect(joined).toContain("requires a TTY");
  });
});
