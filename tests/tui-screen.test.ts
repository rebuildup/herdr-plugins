import { describe, expect, test } from "bun:test";
import { ESC, RESET } from "../packages/tui/src/ansi";
import { asciiDegrade, Renderer, styled, text } from "../packages/tui/src/screen";
import { displayWidth } from "../packages/tui/src/unicode";

function makeRenderer(opts: Partial<ConstructorParameters<typeof Renderer>[0]> = {}) {
  const chunks: string[] = [];
  const output = {
    write(s: string) {
      chunks.push(s);
      return true;
    },
  };
  const r = new Renderer({
    output,
    columns: 20,
    rows: 5,
    colors: "none",
    ...opts,
  });
  return { r, chunks, output };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips ANSI for assertions
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z~]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

describe("Renderer diff", () => {
  test("first render writes all rows", () => {
    const { r, chunks } = makeRenderer();
    r.render([text("a"), text("b"), text("c")]);
    const out = chunks.join("");
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("c");
    // cursor addressing used
    expect(out).toContain(`${ESC}[1;1H`);
    expect(out).toContain(`${ESC}[3;1H`);
  });

  test("unchanged frame writes nothing", () => {
    const { r, chunks } = makeRenderer();
    const frame = [text("same"), text("rows")];
    r.render(frame);
    chunks.length = 0;
    r.render(frame);
    // Only RESET may trail; no cursor-addressed row writes
    const out = chunks.join("");
    expect(out).not.toContain(`${ESC}[1;1H`);
    expect(out).not.toContain(`${ESC}[2;1H`);
  });

  test("only changed rows are rewritten", () => {
    const { r, chunks } = makeRenderer();
    r.render([text("one"), text("two"), text("three")]);
    chunks.length = 0;
    r.render([text("one"), text("TWO"), text("three")]);
    const out = chunks.join("");
    expect(out).toContain(`${ESC}[2;1H`);
    expect(out).not.toContain(`${ESC}[1;1H`);
    expect(out).not.toContain(`${ESC}[3;1H`);
  });

  test("row cleared via erase-to-eol when content shrinks", () => {
    const { r, chunks } = makeRenderer();
    r.render([text("long content here")]);
    chunks.length = 0;
    r.render([text("x")]);
    const out = chunks.join("");
    expect(out).toContain("x");
    expect(out).toContain(`${ESC}[K`);
  });

  test("extra rows beyond terminal height ignored; missing rows blank", () => {
    const { r } = makeRenderer({ rows: 3 });
    expect(() => r.render([text("1"), text("2"), text("3"), text("4"), text("5")])).not.toThrow();
  });
});

describe("Renderer degradation", () => {
  test("colors=none strips color SGR but keeps bold", () => {
    const { r, chunks } = makeRenderer({ colors: "none" });
    r.render([styled("hi", { fg: "red", bold: true })]);
    const out = chunks.join("");
    expect(out).not.toContain("31m"); // no red fg
    expect(out).toContain(`${ESC}[1m`); // bold kept (NO_COLOR ≠ no emphasis)
  });

  test("colors=basic emits basic SGR", () => {
    const { r, chunks } = makeRenderer({ colors: "basic" });
    r.render([styled("hi", { fg: "red" })]);
    expect(chunks.join("")).toContain(`${ESC}[31m`);
  });

  test("colors=256 emits 38;5", () => {
    const { r, chunks } = makeRenderer({ colors: "256" });
    r.render([styled("hi", { fg: 196 })]);
    expect(chunks.join("")).toContain(`${ESC}[38;5;196m`);
  });

  test("truecolor value degrades to 256 cube in 256 mode", () => {
    const { r, chunks } = makeRenderer({ colors: "256" });
    r.render([styled("hi", { fg: 0xff0000 })]);
    expect(chunks.join("")).toMatch(/38;5;\d+m/);
  });

  test("syncOutput wraps frame in mode 2026", () => {
    const { r, chunks } = makeRenderer({ syncOutput: true });
    r.render([text("x")]);
    const out = chunks.join("");
    expect(out).toContain(`${ESC}[?2026h`);
    expect(out).toContain(`${ESC}[?2026l`);
    expect(out.indexOf(`${ESC}[?2026h`)).toBeLessThan(out.indexOf(`${ESC}[?2026l`));
  });

  test("syncOutput off by default", () => {
    const { r, chunks } = makeRenderer();
    r.render([text("x")]);
    expect(chunks.join("")).not.toContain("2026");
  });

  test("cursor spec positions hardware cursor", () => {
    const { r, chunks } = makeRenderer();
    r.render([text("x")], { row: 2, col: 5 });
    expect(chunks.join("")).toContain(`${ESC}[2;5H`);
  });
});

describe("Renderer safety + width", () => {
  test("untrusted segment text is sanitized (no CSI injection)", () => {
    const { r, chunks } = makeRenderer();
    r.render([text("safe\x1b[2J\x1b[H injected")]);
    const out = chunks.join("");
    // The payload's escape bytes must not appear verbatim in row content.
    // (cup/el sequences legitimately appear; the injected 2J/H must not.)
    expect(out).not.toContain("\x1b[2J");
    expect(stripAnsi(out)).toContain("safe injected");
  });

  test("OSC injection stripped", () => {
    const { r, chunks } = makeRenderer();
    r.render([text("a\x1b]8;;http://x\x07b")]);
    expect(chunks.join("")).not.toContain("]8;;");
  });

  test("wide chars truncated to column width without splitting", () => {
    const { r, chunks } = makeRenderer({ columns: 5 });
    r.render([text("ab日本cd")]); // cells: a1 b1 日2 本2 c1 d1 = 8 > 5
    const visible = stripAnsi(chunks.join(""));
    // "ab日" = 4 cells fits; 本 would make 6 > 5 → dropped
    expect(visible).toContain("ab日");
    expect(visible).not.toContain("本");
  });

  test("lines longer than width are clipped", () => {
    const { r, chunks } = makeRenderer({ columns: 4 });
    r.render([text("abcdefgh")]);
    const visible = stripAnsi(chunks.join(""));
    expect(visible).toContain("abcd");
    expect(visible).not.toContain("efgh");
  });

  test("ascii degrade replaces box drawing", () => {
    expect(asciiDegrade("─│…←→")).toBe("-|...<>");
  });

  test("resize forces full redraw", () => {
    const { r, chunks } = makeRenderer();
    r.render([text("a"), text("b")]);
    chunks.length = 0;
    r.resize(30, 5); // different size → invalidate
    r.render([text("a"), text("b")]);
    const out = chunks.join("");
    expect(out).toContain(`${ESC}[1;1H`);
    expect(out).toContain(`${ESC}[2;1H`);
  });

  test("invalidate forces redraw without resize", () => {
    const { r, chunks } = makeRenderer();
    const f = [text("same")];
    r.render(f);
    chunks.length = 0;
    r.render(f);
    expect(chunks.join("")).not.toContain(`${ESC}[1;1H`);
    r.invalidate();
    r.render(f);
    expect(chunks.join("")).toContain(`${ESC}[1;1H`);
  });

  test("displayWidth sanity used by truncation", () => {
    expect(displayWidth("abc")).toBe(3);
  });

  test("RESET emitted at frame end", () => {
    const { r, chunks } = makeRenderer();
    r.render([styled("x", { bold: true })]);
    expect(chunks.join("")).toContain(RESET);
  });
});
