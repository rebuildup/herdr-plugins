import { describe, expect, test } from "bun:test";
import {
  type InboxEntry,
  type InboxState,
  sessionEntries,
  sessionKeyFor,
} from "../plugins/inbox/src/state";

function entry(paneId: string): InboxEntry {
  return { pane_id: paneId, updated_at: "2026-01-10T00:00:00Z" };
}

describe("session namespacing", () => {
  test("sessionEntries isolates panes across session keys", () => {
    const state: InboxState = { version: 2, sessions: {} };
    const a = sessionEntries(state, "host /tmp/a/herdr.sock");
    const b = sessionEntries(state, "host /tmp/b/herdr.sock");
    a["w1:p1"] = entry("w1:p1");
    b["w1:p1"] = entry("w1:p1");
    expect(Object.keys(state.sessions)).toHaveLength(2);
    expect(a["w1:p1"]).not.toBe(b["w1:p1"]);
    delete a["w1:p1"];
    expect(b["w1:p1"]).toBeDefined();
  });

  test("sessionKeyFor is stable per socket and differs across sessions", () => {
    const a1 = sessionKeyFor({ socketPath: "/tmp/nonexistent-a/herdr.sock" });
    const a2 = sessionKeyFor({ socketPath: "/tmp/nonexistent-a/herdr.sock" });
    const b = sessionKeyFor({ socketPath: "/tmp/nonexistent-b/herdr.sock" });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toContain("herdr.sock");
  });
});
