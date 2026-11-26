/**
 * Shared TUI components for `packages/tui` (contract `tui-v1` §6).
 *
 * A component is a `ScreenView`: it renders styled `Line`s for a given
 * width/height and optionally consumes `KeyEvent`s. Components are
 * plugin-agnostic — plugin-specific views live in `plugins/<name>` and
 * compose these.
 *
 * Safety: components never need to pre-escape untrusted text — the
 * renderer sanitizes every segment (safety.ts `sanitizeDisplay`).
 */

import type { Style } from "./ansi";
import { displayKey, type KeyEvent, keyText, matchKey } from "./input";
import type { Line, ScreenView } from "./screen";
import { text } from "./screen";
import {
  centerWidth,
  displayWidth,
  ellipsize,
  graphemes,
  padEndWidth,
  padStartWidth,
  truncateToWidth,
  wrapText,
} from "./unicode";

// --- Shared types ---------------------------------------------------------------

/** One row of the in-TUI help overlay / keymap table (contract §6). */
export interface KeyBinding {
  /** Key spec(s): "enter", "ctrl+c", "up", "?", ... or a list. */
  keys: string | string[];
  /** What the key does, in user language. */
  description: string;
}

// --- Small line helpers -----------------------------------------------------------

/** Horizontal rule across `width` cells. */
export function hr(width: number, ch = "─"): Line {
  return text(ch.repeat(Math.max(0, width)));
}

/** Dimmed secondary text line. */
export function dim(s: string): Line {
  return [{ text: s, style: { dim: true } }];
}

/** Truncate a plain string to `width` cells (sanitized by renderer later). */
export function clip(s: string, width: number): string {
  return truncateToWidth(s, Math.max(0, width));
}

// --- filter / search ---------------------------------------------------------------

/**
 * Case-insensitive substring filter over `items`. `getText` extracts the
 * searchable text (default: String(item)). Whitespace-separated query terms
 * must all match (AND). Returns items in original order.
 */
export function filterItems<T>(
  items: readonly T[],
  query: string,
  getText?: (item: T) => string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  const terms = q.split(/\s+/).filter((t) => t.length > 0);
  const textOf = getText ?? ((item: T) => String(item));
  return items.filter((item) => {
    const hay = textOf(item).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// --- Status / notice line -----------------------------------------------------------

/**
 * Build the reserved bottom status line: left text, optional right-aligned
 * hint text, dimmed. Padded to `width` cells.
 */
export function statusLine(
  width: number,
  left: string,
  right?: string,
  opts: { style?: Style } = {},
): Line {
  const style = opts.style ?? { dim: true };
  if (!right) {
    return [{ text: padEndWidth(clip(left, width), width), style }];
  }
  const r = clip(right, Math.max(0, width - 2));
  const l = clip(left, Math.max(0, width - displayWidth(r) - 1));
  const gap = Math.max(1, width - displayWidth(l) - displayWidth(r));
  return [{ text: l, style }, { text: " ".repeat(gap) }, { text: r, style }];
}

// --- Help overlay -------------------------------------------------------------------

/**
 * Render the `?`/`h` help overlay content from the SAME keybinding table
 * the UI dispatches on (contract §6 — no drift). A centered box listing
 * `keys — description` rows. Rendered as a full frame (rows outside the
 * box are blank) so compositing stays trivial.
 */
export function renderHelpOverlay(
  bindings: readonly KeyBinding[],
  width: number,
  height: number,
): Line[] {
  const rows: Array<{ keys: string[]; desc: string }> = [];
  for (const b of bindings) {
    const keys = Array.isArray(b.keys) ? b.keys : [b.keys];
    if (keys.length === 0 || b.description === "") continue;
    rows.push({ keys, desc: b.description });
  }
  const keyColW = Math.min(
    24,
    Math.max(6, ...rows.map((r) => displayWidth(r.keys.map(displayKey).join(", ")))),
  );
  const innerW = Math.min(Math.max(24, width - 4), keyColW + 4 + 28);
  const boxW = Math.min(width, innerW + 4);
  const boxH = Math.min(height, rows.length + 6);
  const top = Math.max(0, Math.floor((height - boxH) / 2));
  const left = Math.max(0, Math.floor((width - boxW) / 2));

  const lines: Line[] = [];
  const blank = (): Line => [];
  for (let r = 0; r < top; r++) lines.push(blank());

  const border: Style = { dim: true };
  const borderLine = (): Line => [
    { text: " ".repeat(left) },
    { text: `┌${"─".repeat(Math.max(0, boxW - 2))}┐`, style: border },
  ];
  const hLine = (): Line => [
    { text: " ".repeat(left) },
    { text: "│", style: border },
    { text: " ".repeat(Math.max(0, boxW - 6)) },
    { text: "│", style: border },
  ];

  lines.push(borderLine());
  lines.push([
    { text: " ".repeat(left) },
    { text: "│", style: border },
    { text: " " },
    { text: centerWidth("Keys", boxW - 6), style: { bold: true } },
    { text: " " },
    { text: "│", style: border },
  ]);
  lines.push(hLine());

  const visible = Math.max(0, boxH - 6);
  const shown = rows.slice(0, visible);
  for (const row of shown) {
    const keyStr = row.keys.map(displayKey).join(", ");
    const descW = Math.max(0, boxW - 8 - keyColW);
    lines.push([
      { text: " ".repeat(left) },
      { text: "│", style: border },
      { text: " " },
      { text: padEndWidth(clip(keyStr, keyColW), keyColW), style: { bold: true } },
      { text: "  " },
      { text: padEndWidth(clip(row.desc, descW), descW), style: { dim: true } },
      { text: " " },
      { text: "│", style: border },
    ]);
  }
  if (rows.length > shown.length) {
    lines.push([
      { text: " ".repeat(left) },
      { text: "│", style: border },
      { text: `  … ${rows.length - shown.length} more`, style: { dim: true } },
      { text: "│", style: border },
    ]);
  }
  lines.push(hLine());
  lines.push([
    { text: " ".repeat(left) },
    { text: "│", style: border },
    {
      text: padEndWidth(clip("Esc / ? — close", boxW - 4), boxW - 4),
      style: { dim: true },
    },
    { text: "│", style: border },
  ]);
  lines.push(borderLine());
  while (lines.length < height) lines.push(blank());
  return lines.slice(0, height);
}

/** ScreenView wrapper for the help overlay. */
export class HelpView implements ScreenView {
  private readonly bindings: readonly KeyBinding[];
  onClose?: () => void;

  constructor(bindings: readonly KeyBinding[]) {
    this.bindings = bindings;
  }

  handleKey(ev: KeyEvent): boolean {
    if (matchKey(ev, "escape") || matchKey(ev, "q") || matchKey(ev, "?") || matchKey(ev, "h")) {
      this.onClose?.();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    return renderHelpOverlay(this.bindings, width, height);
  }

  keymap(): KeyBinding[] {
    return [{ keys: ["?", "h", "esc"], description: "close help" }];
  }
}

// --- Text input ---------------------------------------------------------------------

export interface TextInputOptions {
  value?: string;
  placeholder?: string;
  /** Mask rendered text (contract item 6 prefers not rendering secrets at
   *  all — masking is a fallback for short-lived confirmations). */
  masked?: boolean;
  maxLength?: number;
}

/**
 * Single-line text editor state machine. Use `renderLine` inside your own
 * view, or `PromptView` / `app.prompt()` for a ready-made screen.
 */
export class TextInput {
  private clusters: string[];
  private cursor: number; // grapheme index
  private readonly placeholder: string;
  private readonly masked: boolean;
  private readonly maxLength: number;

  constructor(opts: TextInputOptions = {}) {
    this.clusters = graphemes(opts.value ?? "");
    this.cursor = this.clusters.length;
    this.placeholder = opts.placeholder ?? "";
    this.masked = opts.masked ?? false;
    this.maxLength = opts.maxLength ?? 4096;
  }

  get value(): string {
    return this.clusters.join("");
  }

  setValue(v: string): void {
    this.clusters = graphemes(v).slice(0, this.maxLength);
    this.cursor = this.clusters.length;
  }

  clear(): void {
    this.clusters = [];
    this.cursor = 0;
  }

  /** Feed one key event. Returns true when consumed. */
  handleKey(ev: KeyEvent): boolean {
    if (ev.kind === "paste") {
      this.insertText(ev.text.replace(/[\r\n]+/g, " "));
      return true;
    }
    if (ev.kind !== "key") return false;
    if (ev.ctrl) {
      if (matchKey(ev, "ctrl+u")) {
        this.clusters = [];
        this.cursor = 0;
        return true;
      }
      if (matchKey(ev, "ctrl+w")) {
        this.deleteWordBack();
        return true;
      }
      if (matchKey(ev, "ctrl+a")) {
        this.cursor = 0;
        return true;
      }
      if (matchKey(ev, "ctrl+e")) {
        this.cursor = this.clusters.length;
        return true;
      }
      if (matchKey(ev, "ctrl+k")) {
        this.clusters = this.clusters.slice(0, this.cursor);
        return true;
      }
      return false;
    }
    if (ev.alt) return false;
    const t = keyText(ev);
    if (t !== undefined) {
      this.insertText(t);
      return true;
    }
    switch (ev.key) {
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case "right":
        this.cursor = Math.min(this.clusters.length, this.cursor + 1);
        return true;
      case "home":
        this.cursor = 0;
        return true;
      case "end":
        this.cursor = this.clusters.length;
        return true;
      case "backspace":
        if (this.cursor > 0) {
          this.clusters.splice(this.cursor - 1, 1);
          this.cursor -= 1;
        }
        return true;
      case "delete":
        if (this.cursor < this.clusters.length) this.clusters.splice(this.cursor, 1);
        return true;
      default:
        return false;
    }
  }

  private insertText(s: string): void {
    for (const c of graphemes(s)) {
      if (this.clusters.length >= this.maxLength) break;
      this.clusters.splice(this.cursor, 0, c);
      this.cursor += 1;
    }
  }

  private deleteWordBack(): void {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.clusters[i - 1] ?? "")) i -= 1;
    while (i > 0 && !/\s/.test(this.clusters[i - 1] ?? "")) i -= 1;
    this.clusters.splice(i, this.cursor - i);
    this.cursor = i;
  }

  /** Render the input as up to `height` lines of `width` cells with a block
   *  cursor after the text at the caret. */
  renderLine(width: number, prompt = "> "): Line {
    const w = Math.max(4, width);
    const avail = Math.max(1, w - displayWidth(prompt) - 1);

    if (this.clusters.length === 0) {
      if (this.placeholder !== "") {
        return [
          { text: prompt },
          { text: clip(this.placeholder, avail), style: { dim: true } },
          { text: " ", style: { inverse: true } },
        ];
      }
      return [{ text: prompt }, { text: " ", style: { inverse: true } }];
    }

    const shown = this.masked ? this.clusters.map(() => "•") : this.clusters;
    const curChar = this.cursor < shown.length ? (shown[this.cursor] as string) : " ";
    const before = shown.slice(0, this.cursor).join("");
    const after = shown.slice(this.cursor + 1).join("");

    // Budget: prompt + head + cursor + tail ≤ width. Prefer keeping the
    // tail visible by trimming the head when the line overflows.
    const headBudget = Math.max(0, avail - displayWidth(curChar));
    let head = clip(before, headBudget);
    let tail = clip(after, Math.max(0, avail - displayWidth(head) - displayWidth(curChar)));
    if (displayWidth(head) + displayWidth(curChar) + displayWidth(tail) > avail) {
      tail = clip(after, Math.max(0, avail - displayWidth(curChar)));
      head = "";
    }
    const parts: Line = [{ text: prompt }];
    if (head.length > 0) parts.push({ text: head });
    parts.push({ text: curChar === "" ? " " : curChar, style: { inverse: true } });
    if (tail.length > 0) parts.push({ text: tail });
    return parts;
  }
}

/** ScreenView for a single-line prompt. */
export class PromptView implements ScreenView {
  readonly input: TextInput;
  private readonly promptText: string;
  result: string | null = null;
  cancelled = false;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;

  constructor(promptText: string, opts: TextInputOptions = {}) {
    this.promptText = promptText;
    this.input = new TextInput(opts);
  }

  handleKey(ev: KeyEvent): boolean {
    if (matchKey(ev, "enter")) {
      this.result = this.input.value;
      this.onSubmit?.(this.result);
      return true;
    }
    if (matchKey(ev, "escape") || matchKey(ev, "ctrl+c")) {
      this.cancelled = true;
      this.onCancel?.();
      return true;
    }
    return this.input.handleKey(ev);
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    lines.push([{ text: clip(this.promptText, width), style: { bold: true } }]);
    lines.push(this.input.renderLine(Math.max(1, width - 2)));
    lines.push(dim("Enter — submit · Esc — cancel"));
    while (lines.length < height) lines.push([]);
    return lines.slice(0, height);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: "enter", description: "submit" },
      { keys: ["esc", "ctrl+c"], description: "cancel" },
    ];
  }
}

// --- Select list ---------------------------------------------------------------------

export interface SelectItem<T> {
  value: T;
  label: string;
  detail?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface SelectListOptions<T> {
  items: readonly SelectItem<T>[];
  /** Enable `/`-style incremental filter. Default true when >8 items. */
  filterable?: boolean;
  emptyText?: string;
  /** Visible rows in the list pane. 0 = auto. */
  visibleRows?: number;
}

/**
 * Keyboard-driven select list with optional incremental filter, scrolling,
 * disabled items (rendered with reason, per contract item 4), and an
 * optional detail pane on wide terminals.
 */
export class SelectList<T> implements ScreenView {
  private items: SelectItem<T>[];
  private readonly filterable: boolean;
  private readonly emptyText: string;
  private readonly visibleRowsOpt: number;
  private cursor = 0;
  private scrollTop = 0;
  private committedFilter = "";
  private filterActive = false;
  private filterDraft = "";
  selected: SelectItem<T> | null = null;
  cancelled = false;
  onSelect?: (item: SelectItem<T>) => void;
  onCancel?: () => void;
  onFilterChange?: (visible: SelectItem<T>[]) => void;

  constructor(opts: SelectListOptions<T>) {
    this.items = [...opts.items];
    this.filterable = opts.filterable ?? opts.items.length > 8;
    this.emptyText = opts.emptyText ?? "(empty)";
    this.visibleRowsOpt = opts.visibleRows ?? 0;
  }

  setItems(items: readonly SelectItem<T>[]): void {
    this.items = [...items];
    this.clampCursor();
    this.onFilterChange?.(this.filtered());
  }

  /** The currently highlighted item (before selection). */
  get current(): SelectItem<T> | null {
    return this.filtered()[this.cursor] ?? null;
  }

  get filterQuery(): string {
    return this.filterActive ? this.filterDraft : this.committedFilter;
  }

  private filtered(): SelectItem<T>[] {
    const q = this.filterActive ? this.filterDraft : this.committedFilter;
    if (q === "") return this.items;
    return filterItems(this.items, q, (i) => `${i.label} ${i.detail ?? ""}`);
  }

  private clampCursor(): void {
    const n = this.filtered().length;
    if (this.cursor >= n) this.cursor = Math.max(0, n - 1);
    if (this.scrollTop > Math.max(0, n - 1)) this.scrollTop = Math.max(0, n - 1);
  }

  private move(delta: number): void {
    const list = this.filtered();
    if (list.length === 0) return;
    let i = this.cursor;
    for (let step = 0; step < list.length; step++) {
      i = (i + delta + list.length) % list.length;
      const item = list[i];
      if (item && !item.disabled) break;
    }
    this.cursor = i;
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind === "paste") return false;

    if (this.filterActive) {
      const t = keyText(ev);
      if (t !== undefined) {
        this.filterDraft += t;
        this.cursor = 0;
        this.scrollTop = 0;
        this.clampCursor();
        this.onFilterChange?.(this.filtered());
        return true;
      }
      if (ev.kind === "key" && ev.key === "backspace") {
        this.filterDraft = graphemes(this.filterDraft).slice(0, -1).join("");
        this.cursor = 0;
        this.scrollTop = 0;
        this.clampCursor();
        this.onFilterChange?.(this.filtered());
        return true;
      }
      if (matchKey(ev, "enter")) {
        this.committedFilter = this.filterDraft;
        this.filterActive = false;
        this.clampCursor();
        this.onFilterChange?.(this.filtered());
        return true;
      }
      if (matchKey(ev, "escape")) {
        this.filterActive = false;
        this.filterDraft = "";
        this.onFilterChange?.(this.filtered());
        return true;
      }
      return true; // swallow everything else while filtering
    }

    if (matchKey(ev, "up") || matchKey(ev, "k")) {
      this.move(-1);
      return true;
    }
    if (matchKey(ev, "down") || matchKey(ev, "j")) {
      this.move(1);
      return true;
    }
    if (matchKey(ev, "pageup")) {
      for (let i = 0; i < 10; i++) this.move(-1);
      return true;
    }
    if (matchKey(ev, "pagedown")) {
      for (let i = 0; i < 10; i++) this.move(1);
      return true;
    }
    if (matchKey(ev, "home")) {
      this.cursor = 0;
      return true;
    }
    if (matchKey(ev, "end")) {
      this.cursor = Math.max(0, this.filtered().length - 1);
      return true;
    }
    if (this.filterable && matchKey(ev, "/")) {
      this.filterActive = true;
      this.filterDraft = this.committedFilter;
      return true;
    }
    if (matchKey(ev, "enter")) {
      const item = this.filtered()[this.cursor];
      if (item && !item.disabled) {
        this.selected = item;
        this.onSelect?.(item);
      }
      return true;
    }
    if (matchKey(ev, "escape") || matchKey(ev, "q")) {
      this.cancelled = true;
      this.onCancel?.();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const list = this.filtered();
    const sel = list[this.cursor];
    const useDetail = width >= 60 && Boolean(sel?.detail);
    const listW = useDetail ? Math.floor(width * 0.55) : width;
    const detailW = width - listW - 1;
    const chrome =
      (this.filterActive || this.committedFilter !== "" ? 1 : 0) + (list.length > 0 ? 1 : 0);
    const visible =
      this.visibleRowsOpt > 0 ? this.visibleRowsOpt : Math.max(1, height - chrome - 1);

    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + visible) this.scrollTop = this.cursor - visible + 1;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, list.length - visible)));

    const rows: Line[] = [];
    if (this.filterActive || this.committedFilter !== "") {
      const q = this.filterActive ? this.filterDraft : this.committedFilter;
      const parts: Line = [
        { text: "/", style: { bold: true } },
        { text: clip(q, Math.max(0, listW - 2)), style: this.filterActive ? {} : { dim: true } },
      ];
      if (this.filterActive) parts.push({ text: "▌", style: { inverse: true } });
      rows.push(parts);
    }
    if (list.length === 0) {
      rows.push([{ text: `  ${this.emptyText}`, style: { dim: true } }]);
    } else {
      const windowItems = list.slice(this.scrollTop, this.scrollTop + visible);
      for (let i = 0; i < windowItems.length; i++) {
        const item = windowItems[i] as SelectItem<T>;
        const idx = this.scrollTop + i;
        const isSel = idx === this.cursor;
        const rowStyle: Style = item.disabled
          ? { dim: true }
          : isSel
            ? { bold: true, fg: "cyan" }
            : {};
        const labelW = Math.max(0, listW - 4);
        const label = ellipsize(item.label, labelW);
        const row: Line = [
          { text: `${isSel ? "❯" : " "} `, style: rowStyle },
          { text: padEndWidth(label, labelW), style: rowStyle },
        ];
        if (item.disabled && item.disabledReason) {
          row.push({
            text: ` ${ellipsize(item.disabledReason, Math.max(0, listW - displayWidth(label) - 14))}`,
            style: { dim: true },
          });
        }
        rows.push(row);
      }
      if (list.length > visible) {
        rows.push([
          { text: padStartWidth(`${this.cursor + 1}/${list.length}`, listW), style: { dim: true } },
        ]);
      }
    }

    // Pad list rows to full list width, then optionally append detail pane.
    const out: Line[] = [];
    const detailLines =
      useDetail && sel?.detail ? wrapText(sel.detail, Math.max(8, detailW - 2)) : [];
    const detailTitle = useDetail && sel ? clip(sel.label, detailW) : "";
    for (let r = 0; r < Math.min(height, rows.length); r++) {
      const base = rows[r] ?? [];
      const baseW = base.reduce((a, s) => a + displayWidth(s.text), 0);
      const padded: Line = [...base, { text: " ".repeat(Math.max(0, listW - baseW)) }];
      if (!useDetail) {
        out.push(padded);
        continue;
      }
      const sep = [...padded, { text: "│", style: { dim: true } }, { text: " " }];
      let dText = "";
      let dStyle: Style = { dim: true };
      if (r === 0 && this.filterActive) {
        // header row: keep detail empty
      } else {
        const detailRowIdx = r - (this.filterActive || this.committedFilter !== "" ? 1 : 0);
        if (detailRowIdx === 0) {
          dText = detailTitle;
          dStyle = { bold: true };
        } else if (detailRowIdx > 0 && detailRowIdx - 1 < detailLines.length) {
          dText = detailLines[detailRowIdx - 1] as string;
        }
      }
      out.push([...sep, { text: clip(dText, detailW - 1), style: dStyle }]);
    }
    while (out.length < height) out.push([]);
    return out.slice(0, height);
  }

  keymap(): KeyBinding[] {
    const b: KeyBinding[] = [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "enter", description: "select" },
      { keys: ["pgup", "pgdn"], description: "page" },
      { keys: ["home", "end"], description: "first/last" },
    ];
    if (this.filterable) b.push({ keys: "/", description: "filter" });
    b.push({ keys: ["esc", "q"], description: "back" });
    return b;
  }
}

// --- Detail view -----------------------------------------------------------------------

export interface DetailViewOptions {
  title?: string;
  /** Content lines (each word-wrapped to the render width). */
  lines: readonly string[];
  onClose?: () => void;
}

/** Scrollable read-only detail view. */
export class DetailView implements ScreenView {
  private readonly title: string;
  private readonly source: readonly string[];
  private scroll = 0;
  onClose: (() => void) | undefined;

  constructor(opts: DetailViewOptions) {
    this.title = opts.title ?? "";
    this.source = opts.lines;
    this.onClose = opts.onClose;
  }

  handleKey(ev: KeyEvent): boolean {
    if (matchKey(ev, "up") || matchKey(ev, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
      return true;
    }
    if (matchKey(ev, "down") || matchKey(ev, "j")) {
      this.scroll += 1;
      return true;
    }
    if (matchKey(ev, "pageup")) {
      this.scroll = Math.max(0, this.scroll - 10);
      return true;
    }
    if (matchKey(ev, "pagedown") || matchKey(ev, "space")) {
      this.scroll += 10;
      return true;
    }
    if (matchKey(ev, "home")) {
      this.scroll = 0;
      return true;
    }
    if (matchKey(ev, "end")) {
      this.scroll = Number.MAX_SAFE_INTEGER;
      return true;
    }
    if (matchKey(ev, "escape") || matchKey(ev, "q")) {
      this.onClose?.();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const hasTitle = this.title !== "";
    const bodyH = Math.max(1, height - (hasTitle ? 3 : 1));
    const wrapped: string[] = [];
    for (const l of this.source) wrapped.push(...wrapText(l, Math.max(1, width - 2)));
    const maxScroll = Math.max(0, wrapped.length - bodyH);
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = wrapped.slice(this.scroll, this.scroll + bodyH);
    const lines: Line[] = [];
    if (hasTitle) {
      lines.push([{ text: clip(this.title, width), style: { bold: true } }]);
      lines.push(hr(width));
    }
    for (const v of view) lines.push(text(clip(v, width)));
    while (lines.length < height - 1) lines.push([]);
    const pos =
      wrapped.length > 0 ? `${Math.min(this.scroll + 1, wrapped.length)}/${wrapped.length}` : "0/0";
    lines.push([{ text: padStartWidth(pos, width), style: { dim: true } }]);
    return lines.slice(0, height);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: ["home", "end"], description: "top/bottom" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- Confirm dialog -----------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  /** Exact target lines (pane id, repo, branch, ...). Shown verbatim. */
  target?: readonly string[];
  /** Consequence statement ("this cannot be undone"). */
  consequence?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button/consequence as destructive. */
  danger?: boolean;
}

/**
 * Irreversible-op confirmation (contract item 5): shows the exact target
 * and consequence; Esc/`n`/`q` cancels; Enter/`y` confirms; Tab/arrows
 * switch buttons. No mutation fires from a single stray keystroke.
 */
export class ConfirmView implements ScreenView {
  private readonly o: ConfirmOptions & { confirmLabel: string; cancelLabel: string };
  private focusConfirm = true;
  result: "confirm" | "cancel" | null = null;
  onResult?: (r: "confirm" | "cancel") => void;

  constructor(opts: ConfirmOptions) {
    this.o = { confirmLabel: "Confirm", cancelLabel: "Cancel", ...opts };
  }

  handleKey(ev: KeyEvent): boolean {
    if (matchKey(ev, "escape") || matchKey(ev, "n") || matchKey(ev, "q")) {
      this.finish("cancel");
      return true;
    }
    if (matchKey(ev, "y")) {
      this.finish("confirm");
      return true;
    }
    if (
      matchKey(ev, "tab") ||
      matchKey(ev, "left") ||
      matchKey(ev, "right") ||
      matchKey(ev, "h") ||
      matchKey(ev, "l")
    ) {
      this.focusConfirm = !this.focusConfirm;
      return true;
    }
    if (matchKey(ev, "enter") || matchKey(ev, "space")) {
      this.finish(this.focusConfirm ? "confirm" : "cancel");
      return true;
    }
    return false;
  }

  private finish(r: "confirm" | "cancel"): void {
    if (this.result !== null) return;
    this.result = r;
    this.onResult?.(r);
  }

  render(width: number, height: number): Line[] {
    const o = this.o;
    const targetLines = (o.target ?? []).flatMap((t) => wrapText(t, Math.max(10, width - 8)));
    const consLines = o.consequence ? wrapText(o.consequence, Math.max(10, width - 8)) : [];
    const widest = Math.max(
      displayWidth(o.title),
      ...targetLines.map(displayWidth),
      ...consLines.map(displayWidth),
      24,
    );
    const boxW = Math.min(width, widest + 8);
    const boxH = Math.min(height, 6 + targetLines.length + consLines.length);
    const top = Math.max(0, Math.floor((height - boxH) / 2));
    const left = Math.max(0, Math.floor((width - boxW) / 2));
    const innerW = boxW - 4;

    const lines: Line[] = [];
    for (let r = 0; r < top; r++) lines.push([]);
    const border: Style = { dim: true };
    const row = (content: Line): Line => {
      const cw = content.reduce((a, s) => a + displayWidth(s.text), 0);
      return [
        { text: " ".repeat(left) },
        { text: "│", style: border },
        { text: " " },
        ...content,
        { text: " ".repeat(Math.max(0, innerW - cw)) },
        { text: " " },
        { text: "│", style: border },
      ];
    };

    lines.push(row([{ text: centerWidth(o.title, innerW), style: { bold: true } }]));
    lines.push(row([{ text: "─".repeat(innerW), style: border }]));
    for (const t of targetLines) lines.push(row([{ text: clip(t, innerW) }]));
    if (consLines.length > 0) {
      lines.push(row([]));
      for (const c of consLines) {
        const consStyle: Style = { bold: true };
        if (o.danger) consStyle.fg = "red";
        lines.push(row([{ text: clip(c, innerW), style: consStyle }]));
      }
    }
    lines.push(row([]));

    const cLabel = `[ ${o.confirmLabel} ]`;
    const xLabel = `[ ${o.cancelLabel} ]`;
    const btns = displayWidth(cLabel) + 2 + displayWidth(xLabel);
    const btnStart = Math.max(0, Math.floor((innerW - btns) / 2));
    const cStyle: Style = this.focusConfirm
      ? o.danger
        ? { bold: true, inverse: true, fg: "red" }
        : { bold: true, inverse: true }
      : o.danger
        ? { fg: "red" }
        : {};
    const xStyle: Style = !this.focusConfirm ? { bold: true, inverse: true } : { dim: true };
    lines.push(
      row([
        { text: " ".repeat(btnStart) },
        { text: cLabel, style: cStyle },
        { text: "  " },
        { text: xLabel, style: xStyle },
      ]),
    );
    lines.push(row([{ text: "Esc — cancel · Enter — confirm", style: { dim: true } }]));
    while (lines.length < height) lines.push([]);
    return lines.slice(0, height);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["tab", "←", "→"], description: "switch button" },
      { keys: "enter", description: "activate" },
      { keys: ["y", "n"], description: "confirm / cancel" },
      { keys: ["esc", "q"], description: "cancel" },
    ];
  }
}
