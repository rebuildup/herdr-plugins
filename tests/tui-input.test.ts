import { describe, expect, test } from "bun:test";
import {
  displayKey,
  isPrintableKey,
  KeyParser,
  keyText,
  matchKey,
  parseKeySpec,
} from "../packages/tui/src/input";

function keys(...feeds: string[]) {
  const p = new KeyParser();
  const out = [];
  for (const f of feeds) out.push(...p.feed(f));
  return out;
}

describe("KeyParser printable input", () => {
  test("plain ASCII chars", () => {
    const ev = keys("abc");
    expect(ev.map((e) => (e.kind === "key" ? e.key : e.kind))).toEqual(["a", "b", "c"]);
    expect(isPrintableKey(ev[0] as never)).toBe(true);
    expect(keyText(ev[0] as never)).toBe("a");
  });

  test("space is a named printable key", () => {
    const ev = keys(" ");
    expect(ev).toHaveLength(1);
    const e = ev[0];
    expect(e?.kind).toBe("key");
    if (e?.kind === "key") {
      expect(e.key).toBe("space");
      expect(e.char).toBe(" ");
    }
    expect(keyText(e as never)).toBe(" ");
  });

  test("CJK and emoji arrive as single grapheme events", () => {
    const ev = keys("日本語🚀");
    const got = ev.filter((e) => e.kind === "key").map((e) => (e as { key: string }).key);
    expect(got).toEqual(["日", "本", "語", "🚀"]);
  });

  test("UTF-8 split across byte feeds reassembles", () => {
    const p = new KeyParser();
    const bytes = new TextEncoder().encode("あ"); // 3 bytes
    const ev1 = p.feedBytes(bytes.slice(0, 1));
    const ev2 = p.feedBytes(bytes.slice(1, 2));
    const ev3 = p.feedBytes(bytes.slice(2));
    expect(ev1).toHaveLength(0);
    expect(ev2).toHaveLength(0);
    expect(ev3).toHaveLength(1);
    const e = ev3[0];
    expect(e?.kind).toBe("key");
    if (e?.kind === "key") expect(e.key).toBe("あ");
  });

  test("ZWJ emoji family is one grapheme", () => {
    const ev = keys("👨‍👩‍👧");
    const got = ev.filter((e) => e.kind === "key").map((e) => (e as { key: string }).key);
    expect(got).toEqual(["👨‍👩‍👧"]);
  });
});

describe("KeyParser named keys", () => {
  test("enter / tab / backspace", () => {
    const ev = keys("\r\t\x7f");
    expect(ev.map((e) => (e.kind === "key" ? e.key : e.kind))).toEqual([
      "enter",
      "tab",
      "backspace",
    ]);
  });

  test("ctrl+letter", () => {
    const ev = keys("\x03"); // Ctrl-C
    expect(ev).toHaveLength(1);
    const e = ev[0];
    if (e?.kind === "key") {
      expect(e.key).toBe("c");
      expect(e.ctrl).toBe(true);
    }
    expect(matchKey(e as never, "ctrl+c")).toBe(true);
  });

  test("CSI arrows", () => {
    const ev = keys("\x1b[A\x1b[B\x1b[C\x1b[D");
    expect(ev.map((e) => (e.kind === "key" ? e.key : e.kind))).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
  });

  test("CSI with modifiers (ctrl+left)", () => {
    const ev = keys("\x1b[1;5D");
    const e = ev[0];
    if (e?.kind === "key") {
      expect(e.key).toBe("left");
      expect(e.ctrl).toBe(true);
    }
  });

  test("home/end/pageup/pagedown/delete via ~", () => {
    const ev = keys("\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[3~");
    expect(ev.map((e) => (e.kind === "key" ? e.key : e.kind))).toEqual([
      "home",
      "end",
      "pageup",
      "pagedown",
      "delete",
    ]);
  });

  test("SS3 arrows (application mode)", () => {
    const ev = keys("\x1bOA\x1bOB");
    expect(ev.map((e) => (e.kind === "key" ? e.key : e.kind))).toEqual(["up", "down"]);
  });

  test("shift+tab", () => {
    const ev = keys("\x1b[Z");
    const e = ev[0];
    if (e?.kind === "key") {
      expect(e.key).toBe("tab");
      expect(e.shift).toBe(true);
    }
  });

  test("lone ESC flushes as escape", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b")).toHaveLength(0); // held for alt detection
    const ev = p.flush();
    expect(ev).toHaveLength(1);
    const e = ev[0];
    if (e?.kind === "key") expect(e.key).toBe("escape");
  });

  test("ESC + char is alt+key", () => {
    const ev = keys("\x1bx");
    const e = ev[0];
    if (e?.kind === "key") {
      expect(e.key).toBe("x");
      expect(e.alt).toBe(true);
    }
  });

  test("escape then char in separate feeds (after flush)", () => {
    const p = new KeyParser();
    p.feed("\x1b");
    const esc = p.flush();
    const rest = p.feed("x");
    expect(esc[0]?.kind === "key" && (esc[0] as { key: string }).key).toBe("escape");
    expect(rest[0]?.kind === "key" && (rest[0] as { key: string }).key).toBe("x");
  });
});

describe("KeyParser bracketed paste", () => {
  test("paste markers produce a paste event, not keys", () => {
    const ev = keys("\x1b[200~hello\nworld\x1b[201~");
    expect(ev).toHaveLength(1);
    const e = ev[0];
    expect(e?.kind).toBe("paste");
    if (e?.kind === "paste") expect(e.text).toBe("hello\nworld");
  });

  test("paste split across feeds", () => {
    const p = new KeyParser();
    const a = p.feed("\x1b[200~hel");
    const b = p.feed("lo\x1b[20");
    const c = p.feed("1~wor\x1b[201~ld");
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(0);
    // The split "\x1b[20"+"1~" still terminates the paste; trailing text
    // and the stray second marker resolve as ordinary input.
    const paste = c.find((e) => e.kind === "paste");
    expect(paste?.kind).toBe("paste");
    if (paste?.kind === "paste") expect(paste.text).toBe("hello");
    const keysAfter = c.filter((e) => e.kind === "key").map((e) => (e as { key: string }).key);
    expect(keysAfter).toEqual(["w", "o", "r", "l", "d"]);
  });

  test("unterminated paste flushes with received content", () => {
    const p = new KeyParser();
    p.feed("\x1b[200~partial");
    const ev = p.flush();
    const paste = ev.find((e) => e.kind === "paste");
    expect(paste?.kind).toBe("paste");
    if (paste?.kind === "paste") expect(paste.text).toBe("partial");
  });
});

describe("KeyParser terminal replies", () => {
  test("OSC sequence is swallowed", () => {
    const ev = keys("\x1b]0;title\x07a");
    const got = ev.filter((e) => e.kind === "key").map((e) => (e as { key: string }).key);
    expect(got).toEqual(["a"]);
  });

  test("cursor-position report CSI ... R is swallowed", () => {
    const ev = keys("\x1b[24;80Ra");
    const got = ev.filter((e) => e.kind === "key").map((e) => (e as { key: string }).key);
    expect(got).toEqual(["a"]);
  });
});

describe("key spec matching", () => {
  test("parseKeySpec", () => {
    expect(parseKeySpec("ctrl+c")).toEqual({ key: "c", ctrl: true, shift: false, alt: false });
    expect(parseKeySpec("shift+tab")).toEqual({ key: "tab", ctrl: false, shift: true, alt: false });
    expect(parseKeySpec("?")).toEqual({ key: "?", ctrl: false, shift: false, alt: false });
    expect(parseKeySpec("alt+left")).toEqual({ key: "left", ctrl: false, shift: false, alt: true });
    expect(parseKeySpec("")).toBeNull();
  });

  test("matchKey requires modifiers to agree", () => {
    const ev = keys("\x03")[0] as never;
    expect(matchKey(ev, "ctrl+c")).toBe(true);
    expect(matchKey(ev, "c")).toBe(false);
    const plain = keys("c")[0] as never;
    expect(matchKey(plain, "c")).toBe(true);
    expect(matchKey(plain, "ctrl+c")).toBe(false);
  });

  test("displayKey", () => {
    expect(displayKey("ctrl+c")).toBe("Ctrl-C");
    expect(displayKey("enter")).toBe("Enter");
    expect(displayKey("up")).toBe("↑");
    expect(displayKey("?")).toBe("?");
  });
});
