import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TuiApp } from "../packages/tui/src/index";
import type { KeyEvent } from "../packages/tui/src/input";
import type { ConversationEvent } from "../plugins/conversations/src/model";
import {
  EventListView,
  type EventPage,
  eventDetailLines,
  historyPage,
  paneOpenArgs,
  searchPage,
  sessionEntries,
} from "../plugins/conversations/src/tui";
import { testEnv } from "./helpers/test-env";

const TUI = path.join(__dirname, "..", "plugins", "conversations", "src", "tui.ts");

function key(k: string): KeyEvent {
  return { kind: "key", key: k, ctrl: false, shift: false, alt: false };
}

function event(partial: Partial<ConversationEvent>): ConversationEvent {
  return {
    event_id: "e1",
    type: "assistant_message",
    timestamp: "2025-01-02T03:04:05Z",
    identity: {
      host: "h",
      herdr_session: "s",
      workspace_id: null,
      tab_id: null,
      pane_id: null,
      agent: null,
      agent_session: null,
      state_change_seq: null,
    },
    turn_index: 1,
    ...partial,
  } as ConversationEvent;
}

function fakeApp(): TuiApp {
  return {
    push: () => {},
    pop: () => undefined,
    close: async () => {},
    setStatus: () => {},
  } as unknown as TuiApp;
}

describe("paneOpenArgs", () => {
  test("opens the main entrypoint as a tab via plugin.pane.open CLI", () => {
    const args = paneOpenArgs();
    expect(args.slice(0, 4)).toEqual(["plugin", "pane", "open", "--plugin"]);
    expect(args).toContain("rebuildup.conversations");
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("main");
    expect(args[args.indexOf("--placement") + 1]).toBe("tab");
  });
});

describe("sessionEntries", () => {
  test("maps sessions payload defensively", () => {
    const entries = sessionEntries({
      sessions: [
        {
          key: "claude:abc",
          provider: "claude",
          session_id: "abc",
          status: "ok",
          stale: true,
          stale_reason: "agent_session_changed",
          event_count: 42,
          turn_count: 7,
          last_event_at: "2025-01-02T00:00:00Z",
          cwd: "/repo",
          transcript_present: true,
        },
        { bogus: true },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("claude:abc");
    expect(entries[0]?.stale).toBe(true);
    expect(entries[0]?.eventCount).toBe(42);
  });

  test("empty/missing sessions → empty list", () => {
    expect(sessionEntries({})).toEqual([]);
    expect(sessionEntries({ sessions: "nope" })).toEqual([]);
  });
});

describe("historyPage / searchPage", () => {
  test("history maps events + page cursor", () => {
    const page = historyPage({
      events: [event({ event_id: "e9", type: "tool_call", tool_name: "Bash" })],
      page: { next_cursor: "200", has_more: true, malformed_lines: 2 },
      session: { key: "claude:abc" },
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.sessionKey).toBe("claude:abc");
    expect(page.rows[0]?.event.tool_name).toBe("Bash");
    expect(page.nextCursor).toBe("200");
    expect(page.hasMore).toBe(true);
    expect(page.notes.join(" ")).toContain("malformed");
  });

  test("search maps results and only keeps cursor when has_more", () => {
    const page = searchPage({
      results: [
        { session_key: "codex:x", event_id: "e1", event: event({ event_id: "e1" }) },
        { session_key: "codex:x", event: null },
      ],
      page: { next_cursor: "CURSOR", has_more: false },
    });
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });
});

describe("eventDetailLines", () => {
  test("includes type/turn/usage/tool fields", () => {
    const lines = eventDetailLines({
      sessionKey: "claude:abc",
      event: event({
        type: "tool_call",
        tool_use_id: "tu1",
        tool_name: "Read",
        tool_input: { file_path: "/x" },
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      }),
    });
    const joined = lines.join("\n");
    expect(joined).toContain("type:        tool_call");
    expect(joined).toContain("tool_name:   Read");
    expect(joined).toContain("in=1 out=2");
    expect(joined).toContain("file_path");
  });
});

describe("EventListView", () => {
  test("loads first page, renders rows, pages forward via n", async () => {
    const pages: EventPage[] = [
      {
        rows: [{ sessionKey: "s1", event: event({ event_id: "a", text: "hello" }) }],
        nextCursor: "100",
        hasMore: true,
        notes: [],
      },
      {
        rows: [{ sessionKey: "s1", event: event({ event_id: "b", text: "world" }) }],
        nextCursor: null,
        hasMore: false,
        notes: [],
      },
    ];
    const cursors: (string | null)[] = [];
    const view = new EventListView(fakeApp(), {
      title: "test",
      load: async (cursor) => {
        cursors.push(cursor);
        return { ok: true, page: pages[cursors.length - 1] as EventPage };
      },
    });
    await Bun.sleep(20);
    const frame = view.render(100, 20).map((l) => l.map((s) => s.text).join(""));
    expect(frame.join("\n")).toContain("hello");
    expect(view.handleKey(key("n"))).toBe(true);
    await Bun.sleep(20);
    const frame2 = view.render(100, 20).map((l) => l.map((s) => s.text).join(""));
    expect(frame2.join("\n")).toContain("world");
    expect(cursors).toEqual([null, "100"]);
  });

  test("error state renders honestly and r retries", async () => {
    let calls = 0;
    const view = new EventListView(fakeApp(), {
      title: "test",
      load: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false as const, error: "boom" }
          : { ok: true as const, page: { rows: [], nextCursor: null, hasMore: false, notes: [] } };
      },
    });
    await Bun.sleep(20);
    const frame = view.render(100, 20).map((l) => l.map((s) => s.text).join(""));
    expect(frame.join("\n")).toContain("error: boom");
    view.handleKey(key("r"));
    await Bun.sleep(20);
    expect(calls).toBe(2);
  });
});

describe("non-TTY entrypoint", () => {
  test("prints CLI fallback notice and exits 0 without a TTY", () => {
    const result = spawnSync(process.execPath, [TUI, "main"], {
      encoding: "utf8",
      env: testEnv(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("requires an interactive terminal");
    expect(result.stdout).toContain("src/cli.ts");
  });
});
