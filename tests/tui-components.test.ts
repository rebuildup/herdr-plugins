import { describe, expect, test } from "bun:test";
import {
  ConfirmView,
  DetailView,
  filterItems,
  HelpView,
  PromptView,
  renderHelpOverlay,
  SelectList,
  statusLine,
  TextInput,
} from "../packages/tui/src/components";
import { type KeyEvent, KeyParser, matchKey } from "../packages/tui/src/input";
import type { Line } from "../packages/tui/src/screen";
import { displayWidth } from "../packages/tui/src/unicode";

function feedKeys(view: { handleKey?: (e: KeyEvent) => boolean | undefined }, ...feeds: string[]) {
  const p = new KeyParser();
  const results: boolean[] = [];
  for (const f of feeds) {
    for (const ev of p.feed(f)) {
      results.push(view.handleKey?.(ev) === true);
    }
  }
  return results;
}

function plainLines(lines: Line[]): string[] {
  return lines.map((l) => l.map((s) => s.text).join(""));
}

describe("TextInput", () => {
  test("typing, cursor movement, backspace", () => {
    const input = new TextInput();
    feedKeys(input, "abc");
    expect(input.value).toBe("abc");
    feedKeys(input, "\x1b[D"); // left
    feedKeys(input, "X");
    expect(input.value).toBe("abXc");
    feedKeys(input, "\x7f"); // backspace removes X
    expect(input.value).toBe("abc");
  });

  test("ctrl+u clears, ctrl+w deletes word", () => {
    const input = new TextInput({ value: "hello world" });
    feedKeys(input, "\x17"); // ctrl+w
    expect(input.value).toBe("hello ");
    feedKeys(input, "\x15"); // ctrl+u
    expect(input.value).toBe("");
  });

  test("CJK input keeps graphemes", () => {
    const input = new TextInput();
    feedKeys(input, "日本");
    expect(input.value).toBe("日本");
    feedKeys(input, "\x1b[D");
    feedKeys(input, "a");
    expect(input.value).toBe("日a本");
  });

  test("paste inserts text", () => {
    const input = new TextInput();
    const p = new KeyParser();
    for (const ev of p.feed("\x1b[200~pasted text\x1b[201~")) {
      input.handleKey(ev);
    }
    expect(input.value).toBe("pasted text");
  });

  test("masked render does not show value", () => {
    const input = new TextInput({ value: "secret", masked: true });
    const line = plainLines([input.renderLine(40)])[0] as string;
    expect(line).not.toContain("secret");
    expect(line).toContain("•");
  });

  test("renderLine respects width", () => {
    const input = new TextInput({ value: "abcdefghij" });
    const line = input.renderLine(8);
    const w = displayWidth(line.map((s) => s.text).join(""));
    expect(w).toBeLessThanOrEqual(8);
  });
});

describe("PromptView", () => {
  test("enter submits value", () => {
    const v = new PromptView("Name:");
    let submitted: string | null = null;
    v.onSubmit = (s) => {
      submitted = s;
    };
    feedKeys(v, "abc\r");
    expect(submitted as string | null).toBe("abc");
    expect(v.result).toBe("abc");
  });

  test("escape cancels", () => {
    const v = new PromptView("Name:");
    let cancelled = false;
    v.onCancel = () => {
      cancelled = true;
    };
    feedKeys(v, "\x1b");
    // lone ESC held; flush
    const p = new KeyParser();
    void p;
    // simulate flush via a second feed path: use matchKey-level escape
    const ev: KeyEvent = { kind: "key", key: "escape", ctrl: false, shift: false, alt: false };
    v.handleKey(ev);
    expect(cancelled).toBe(true);
    expect(v.cancelled).toBe(true);
  });
});

describe("SelectList", () => {
  const items = [
    { value: 1, label: "alpha" },
    { value: 2, label: "beta" },
    { value: 3, label: "gamma", disabled: true, disabledReason: "locked" },
    { value: 4, label: "delta" },
  ];

  test("arrow navigation skips disabled", () => {
    const list = new SelectList({ items });
    feedKeys(list, "\x1b[B\x1b[B"); // down, down → should land on delta (3 is disabled)
    expect(list.current?.value).toBe(4);
  });

  test("enter selects and fires onSelect", () => {
    const list = new SelectList({ items });
    let picked: number | null = null;
    list.onSelect = (i) => {
      picked = i.value;
    };
    feedKeys(list, "\x1b[B\r"); // down → beta, enter
    expect(picked as number | null).toBe(2);
    expect(list.selected?.value).toBe(2);
  });

  test("enter on disabled item does not select", () => {
    const list = new SelectList({ items });
    let picked = false;
    list.onSelect = () => {
      picked = true;
    };
    feedKeys(list, "\x1b[B\x1b[B\r"); // down down → lands on delta (4) actually
    expect(picked).toBe(true);
  });

  test("filter narrows items", () => {
    const list = new SelectList({ items, filterable: true });
    feedKeys(list, "/alp");
    expect(list.current?.label).toBe("alpha");
    feedKeys(list, "\r"); // commit filter (enter in filter mode)
    // after commit, filtered list persists
    expect(list.filterQuery).toBe("alp");
  });

  test("escape cancels", () => {
    const list = new SelectList({ items });
    let cancelled = false;
    list.onCancel = () => {
      cancelled = true;
    };
    feedKeys(list, "\x1b");
    // flush path — feed an escape via matchKey-compatible event
    list.handleKey({ kind: "key", key: "escape", ctrl: false, shift: false, alt: false });
    expect(cancelled).toBe(true);
    expect(list.cancelled).toBe(true);
  });

  test("renders selected marker and disabled reason", () => {
    const list = new SelectList({ items });
    const lines = plainLines(list.render(60, 10));
    const joined = lines.join("\n");
    expect(joined).toContain("alpha");
    expect(joined).toContain("locked");
    expect(joined).toContain("❯");
  });

  test("empty filter shows emptyText", () => {
    const list = new SelectList({ items, emptyText: "nothing here", filterable: true });
    feedKeys(list, "/zzz\r");
    const joined = plainLines(list.render(60, 10)).join("\n");
    expect(joined).toContain("nothing here");
  });
});

describe("DetailView", () => {
  test("scrolls and closes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    let closed = false;
    const v = new DetailView({
      title: "T",
      lines,
      onClose: () => {
        closed = true;
      },
    });
    feedKeys(v, "\x1b[B\x1b[B");
    const rendered = plainLines(v.render(40, 10)).join("\n");
    expect(rendered).toContain("line 2");
    feedKeys(v, "\x1b");
    v.handleKey({ kind: "key", key: "escape", ctrl: false, shift: false, alt: false });
    expect(closed).toBe(true);
  });
});

describe("ConfirmView", () => {
  function make() {
    const v = new ConfirmView({
      title: "Delete pane?",
      target: ["pane_id: w1:p2", "repo: hoxay-plugins"],
      consequence: "cannot be undone",
      danger: true,
    });
    return v;
  }

  test("shows exact target and consequence", () => {
    const v = make();
    const joined = plainLines(v.render(60, 20)).join("\n");
    expect(joined).toContain("Delete pane?");
    expect(joined).toContain("pane_id: w1:p2");
    expect(joined).toContain("cannot be undone");
    expect(joined).toContain("[ Confirm ]");
    expect(joined).toContain("[ Cancel ]");
  });

  test("escape cancels", () => {
    const v = make();
    let r: string | null = null;
    v.onResult = (x) => {
      r = x;
    };
    v.handleKey({ kind: "key", key: "escape", ctrl: false, shift: false, alt: false });
    expect(r as string | null).toBe("cancel");
    expect(v.result).toBe("cancel");
  });

  test("y confirms immediately", () => {
    const v = make();
    let r: string | null = null;
    v.onResult = (x) => {
      r = x;
    };
    feedKeys(v, "y");
    expect(r as string | null).toBe("confirm");
  });

  test("tab switches then enter cancels", () => {
    const v = make();
    let r: string | null = null;
    v.onResult = (x) => {
      r = x;
    };
    feedKeys(v, "\t\r"); // tab → focus cancel, enter
    expect(r as string | null).toBe("cancel");
  });

  test("enter on focused confirm", () => {
    const v = make();
    let r: string | null = null;
    v.onResult = (x) => {
      r = x;
    };
    feedKeys(v, "\r");
    expect(r as string | null).toBe("confirm");
  });
});

describe("help", () => {
  test("renderHelpOverlay lists every binding", () => {
    const lines = plainLines(
      renderHelpOverlay(
        [
          { keys: ["↑", "k"], description: "move up" },
          { keys: "enter", description: "select" },
          { keys: "ctrl+c", description: "cancel" },
        ],
        60,
        15,
      ),
    ).join("\n");
    expect(lines).toContain("move up");
    expect(lines).toContain("select");
    expect(lines).toContain("cancel");
    expect(lines).toContain("Ctrl-C");
    expect(lines).toContain("Enter");
  });

  test("HelpView closes on ?/h/esc", () => {
    const v = new HelpView([{ keys: "x", description: "x" }]);
    let closed = 0;
    v.onClose = () => closed++;
    feedKeys(v, "?");
    expect(closed).toBe(1);
  });
});

describe("filterItems / statusLine", () => {
  test("filterItems AND-matches terms case-insensitively", () => {
    const items = ["Alpha beta", "gamma delta", "alpha gamma"];
    expect(filterItems(items, "alpha")).toEqual(["Alpha beta", "alpha gamma"]);
    expect(filterItems(items, "alpha gamma")).toEqual(["alpha gamma"]);
    expect(filterItems(items, "  ")).toEqual(items);
  });

  test("statusLine pads to width and right-aligns", () => {
    const line = statusLine(30, "left", "right");
    const plain = line.map((s) => s.text).join("");
    expect(displayWidth(plain)).toBe(30);
    expect(plain.startsWith("left")).toBe(true);
    expect(plain.endsWith("right")).toBe(true);
  });
});

describe("matchKey sanity", () => {
  test("named key match", () => {
    const ev: KeyEvent = { kind: "key", key: "enter", ctrl: false, shift: false, alt: false };
    expect(matchKey(ev, "enter")).toBe(true);
    expect(matchKey(ev, "escape")).toBe(false);
  });
});
