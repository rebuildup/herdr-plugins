import { describe, expect, test } from "bun:test";
import {
  BoundedBuffer,
  boundText,
  createThrottle,
  openExternal,
  sanitizeDisplay,
} from "../packages/tui/src/safety";

describe("sanitizeDisplay — CSI injection", () => {
  test("strips CSI color/erase sequences", () => {
    expect(sanitizeDisplay("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeDisplay("\x1b[2J\x1b[H")).toBe("");
  });

  test("strips CSI with params and intermediates", () => {
    expect(sanitizeDisplay("a\x1b[1;2Hc")).toBe("ac");
    expect(sanitizeDisplay("x\x1b[?25lY")).toBe("xY");
  });

  test("strips C1 CSI", () => {
    expect(sanitizeDisplay("a\u009b31mb")).toBe("ab");
  });

  test("strips OSC sequences (BEL and ST terminated), keeps inner text", () => {
    // The literal text between the two OSC sequences is real content and
    // must survive; only the escape sequences are removed.
    expect(sanitizeDisplay("a\x1b]8;;http://evil\x07link\x1b]8;;\x07b")).toBe("alinkb");
    expect(sanitizeDisplay("a\x1b]0;title\x1b\\b")).toBe("ab");
  });

  test("strips DCS/SOS/PM/APC", () => {
    expect(sanitizeDisplay("a\x1bP1;2|payload\x1b\\b")).toBe("ab");
    expect(sanitizeDisplay("a\x1b^pm\x1b\\b")).toBe("ab");
    expect(sanitizeDisplay("a\x1b_osc8\x1b\\b")).toBe("ab");
  });

  test("strips lone ESC and leftover controls", () => {
    expect(sanitizeDisplay("a\x1bb")).toBe("ab");
    expect(sanitizeDisplay("a\x07b\x00c")).toBe("a�b�c");
  });

  test("control chars become U+FFFD", () => {
    expect(sanitizeDisplay("x\x01y\x1fz")).toBe("x�y�z");
    expect(sanitizeDisplay("del\x7fete")).toBe("del�ete");
  });

  test("newlines and CR become spaces", () => {
    expect(sanitizeDisplay("a\nb\rc")).toBe("a b c");
  });

  test("tab expands to spaces", () => {
    expect(sanitizeDisplay("a\tb")).toBe("a   b");
    expect(sanitizeDisplay("abcd\te")).toBe("abcd    e");
  });

  test("unicode preserved including wide/emoji", () => {
    expect(sanitizeDisplay("日本語🚀 é")).toBe("日本語🚀 é");
  });

  test("bidi/format controls removed", () => {
    expect(sanitizeDisplay("a‮b")).toBe("ab"); // RLO
    expect(sanitizeDisplay("a⁦b⁩c")).toBe("abc"); // LRI/PDI
    expect(sanitizeDisplay("a‏b")).toBe("ab"); // RLM
  });

  test("variation selectors preserved (emoji presentation)", () => {
    expect(sanitizeDisplay("❤️")).toBe("❤️"); // heart + FE0F
  });

  test("idempotent", () => {
    const once = sanitizeDisplay("a\x1b[31mb\x07c");
    expect(sanitizeDisplay(once)).toBe(once);
  });
});

describe("BoundedBuffer", () => {
  test("keeps at most maxLines", () => {
    const b = new BoundedBuffer({ maxLines: 3, maxChars: 10000 });
    for (let i = 0; i < 10; i++) b.push(`line${i}`);
    expect(b.size).toBe(3);
    expect(b.all()).toEqual(["line7", "line8", "line9"]);
    expect(b.dropped).toBe(7);
  });

  test("keeps at most maxChars", () => {
    const b = new BoundedBuffer({ maxLines: 1000, maxChars: 20 });
    b.push("aaaaaaaaaa"); // 10 + 1
    b.push("bbbbbbbbbb"); // 10 + 1 → total 22 > 20 → drop first
    expect(b.all()).toEqual(["bbbbbbbbbb"]);
  });

  test("sanitizes pushed lines", () => {
    const b = new BoundedBuffer({ maxLines: 10 });
    b.push("safe\x1b[31mtext");
    expect(b.all()).toEqual(["safetext"]);
  });

  test("tail and clear", () => {
    const b = new BoundedBuffer({ maxLines: 100 });
    b.pushMany(["a", "b", "c"]);
    expect(b.tail(2)).toEqual(["b", "c"]);
    b.clear();
    expect(b.size).toBe(0);
  });
});

describe("boundText", () => {
  test("truncates with ellipsis", () => {
    expect(boundText("short", 10)).toBe("short");
    expect(boundText("a".repeat(20), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("createThrottle", () => {
  test("leading call runs immediately", () => {
    let n = 0;
    const t = createThrottle(() => n++, { intervalMs: 50 });
    t.call();
    expect(n).toBe(1);
  });

  test("rapid calls coalesce into one trailing call", async () => {
    let n = 0;
    const t = createThrottle(() => n++, { intervalMs: 20 });
    t.call();
    t.call();
    t.call();
    await new Promise((r) => setTimeout(r, 60));
    expect(n).toBe(2); // initial + one coalesced
  });

  test("flush forces pending call", async () => {
    let n = 0;
    const t = createThrottle(() => n++, { intervalMs: 50 });
    t.call();
    t.call();
    t.flush();
    expect(n).toBe(2);
    await new Promise((r) => setTimeout(r, 70));
    expect(n).toBe(2); // nothing extra after flush
  });
});

describe("openExternal", () => {
  test("rejects non-absolute, non-URL targets", async () => {
    const r1 = await openExternal("relative/path.txt");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("invalid-target");
    const r2 = await openExternal("javascript:alert(1)");
    expect(r2.ok).toBe(false);
    const r3 = await openExternal("file:///etc/passwd");
    expect(r3.ok).toBe(false); // file:// not in allowlist
    const r4 = await openExternal("  ");
    expect(r4.ok).toBe(false);
  });

  test("accepts https URL shape (spawn may fail in sandbox — reason checked)", async () => {
    // We only assert it does NOT return invalid-target; the spawn outcome
    // depends on the environment (no xdg-open in CI).
    const r = await openExternal("https://example.com", { timeoutMs: 2000 });
    if (!r.ok) expect(["spawn-failed", "timeout"]).toContain(r.reason);
  });
});
