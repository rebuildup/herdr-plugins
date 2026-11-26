import { describe, expect, test } from "bun:test";
import {
  centerWidth,
  displayWidth,
  ellipsize,
  graphemes,
  padEndWidth,
  padStartWidth,
  truncateToWidth,
  wrapText,
} from "../packages/tui/src/unicode";

describe("displayWidth", () => {
  test("ASCII", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("")).toBe(0);
  });

  test("CJK wide chars count 2", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("a日b")).toBe(4);
  });

  test("fullwidth forms count 2", () => {
    expect(displayWidth("ＡＢＣ")).toBe(6);
  });

  test("emoji count 2", () => {
    expect(displayWidth("🚀")).toBe(2);
    expect(displayWidth("a🚀b")).toBe(4);
  });

  test("combining marks add 0", () => {
    // e + combining acute = one cell
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("é")).toBe(1);
  });

  test("ZWJ emoji sequence counts as one wide cluster", () => {
    expect(displayWidth("👨‍👩‍👧")).toBe(2);
  });

  test("flags (regional indicators) count 2", () => {
    expect(displayWidth("🇯🇵")).toBe(2);
  });
});

describe("graphemes", () => {
  test("splits clusters not code points", () => {
    const g = graphemes("a👨‍👩‍👧b");
    expect(g).toEqual(["a", "👨‍👩‍👧", "b"]);
  });
});

describe("truncateToWidth", () => {
  test("no-op when it fits", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
  });

  test("truncates ASCII", () => {
    expect(truncateToWidth("hello world", 5)).toBe("hello");
  });

  test("never splits a wide char at the boundary", () => {
    // "a日" = 3 cells; width 2 must drop 日 entirely
    expect(truncateToWidth("a日b", 2)).toBe("a");
    expect(truncateToWidth("a日b", 3)).toBe("a日");
  });

  test("does not split grapheme clusters", () => {
    expect(truncateToWidth("x👨‍👩‍👧y", 2)).toBe("x");
  });

  test("maxWidth <= 0", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
    expect(truncateToWidth("abc", -1)).toBe("");
  });
});

describe("ellipsize / pad / center", () => {
  test("ellipsize adds mark only when truncated", () => {
    expect(ellipsize("short", 10)).toBe("short");
    expect(ellipsize("a very long string indeed", 10)).toBe("a very lo…");
    expect(ellipsize("a very long string indeed", 10, true)).toBe("a very...");
  });

  test("padEndWidth / padStartWidth", () => {
    expect(padEndWidth("ab", 5)).toBe("ab   ");
    expect(padStartWidth("ab", 5)).toBe("   ab");
    expect(displayWidth(padEndWidth("日本", 5))).toBe(5);
    expect(padEndWidth("toolong", 3)).toBe("toolong");
  });

  test("centerWidth", () => {
    expect(centerWidth("ab", 6)).toBe("  ab  ");
    expect(displayWidth(centerWidth("日本", 7))).toBe(7);
  });
});

describe("wrapText", () => {
  test("wraps on word boundaries", () => {
    const out = wrapText("the quick brown fox", 10);
    expect(out).toEqual(["the quick", "brown fox"]);
  });

  test("hard-splits unbreakable runs", () => {
    const out = wrapText("abcdefghij", 4);
    expect(out).toEqual(["abcd", "efgh", "ij"]);
  });

  test("preserves explicit newlines", () => {
    const out = wrapText("a\nb", 10);
    expect(out).toEqual(["a", "b"]);
  });

  test("respects wide chars when wrapping", () => {
    const out = wrapText("aa 日 bb", 4);
    // "aa " =3, adding 日(2) → 5 >4, so 日 goes to next line
    expect(out.every((l) => displayWidth(l) <= 4)).toBe(true);
  });
});
