/**
 * Diffed frame renderer for `packages/tui`.
 *
 * Frame model: a frame is an array of `rows` lines; each line is an array
 * of styled `Segment`s. The renderer:
 *
 * - sanitizes every segment's text through `sanitizeDisplay` (contract
 *   item 8 enforced in exactly one place — components never need to
 *   pre-escape untrusted strings),
 * - truncates each row to the terminal width with Unicode-width-correct
 *   grapheme handling (unicode.ts),
 * - diffs against the previous frame and rewrites only changed rows using
 *   absolute cursor addressing + erase-to-EOL,
 * - wraps the update in synchronized-output markers (mode 2026) when the
 *   terminal supports them (detection in terminal.ts; unsupported terminals
 *   ignore the private mode harmlessly),
 * - optionally uses the alternate screen and always hides the hardware
 *   cursor during draw (components render their own cursor glyph),
 * - degrades color per `ColorMode` (none/basic/256/truecolor).
 */

import {
  type ColorMode,
  cup,
  disableBracketedPaste,
  el,
  enableBracketedPaste,
  enterAltScreen,
  hideCursor,
  leaveAltScreen,
  RESET,
  type Style,
  showCursor,
  styleText,
  syncOutputBegin,
  syncOutputEnd,
} from "./ansi";
import { sanitizeDisplay } from "./safety";
import { displayWidth, truncateToWidth } from "./unicode";

export interface Segment {
  text: string;
  style?: Style;
}

/** One rendered row: ordered styled segments. */
export type Line = Segment[];

/** Convenience: a single unstyled line. */
export function text(s: string): Line {
  return s.length === 0 ? [] : [{ text: s }];
}

/** Convenience: a single styled segment line. */
export function styled(s: string, style: Style): Line {
  return s.length === 0 ? [] : [{ text: s, style }];
}

/** Concatenate segments into one line. */
export function joinSegments(parts: Array<string | Segment>): Line {
  const out: Line = [];
  for (const p of parts) {
    if (typeof p === "string") {
      if (p.length > 0) out.push({ text: p });
    } else if (p.text.length > 0) {
      out.push(p);
    }
  }
  return out;
}

export type CursorSpec = "hide" | { row: number; col: number } | null;

/**
 * A full-area screen in the app's screen stack. `render` produces the
 * frame for the view area; `handleKey` returns true when the event was
 * consumed (unconsumed keys fall through to the app's reserved keys).
 * `keymap` feeds the `?`/`h` help overlay — keep it in sync with
 * `handleKey` (contract §6).
 */
export interface ScreenView {
  render(width: number, height: number): Line[];
  handleKey?(ev: import("./input").KeyEvent): boolean | undefined;
  onResize?(width: number, height: number): void;
  keymap?(): import("./components").KeyBinding[];
}

export interface RendererOptions {
  /** Byte sink. Must accept string writes. Default process.stdout. */
  output?: { write(chunk: string): unknown };
  columns: number;
  rows: number;
  colors?: ColorMode;
  /** Emit mode-2026 synchronized-output markers. Default false. */
  syncOutput?: boolean;
  /** ASCII degradation: strip box-drawing/typographic glyphs to ASCII. */
  ascii?: boolean;
}

/**
 * Replace common typographic glyphs with ASCII for degraded terminals.
 * Applied to segment text before width measurement.
 */
/** Box-drawing characters that map to "|" in ASCII mode. */
const ASCII_VERTICALS = new Set([
  ..."│┃┆┇┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋",
]);

export function asciiDegrade(s: string): string {
  return s
    .replace(/[─-╿]/g, (c) => (ASCII_VERTICALS.has(c) ? "|" : "-"))
    .replace(/[•‣⁃∙]/g, "*")
    .replace(/…/g, "...")
    .replace(/[←-⇿➔➡⬅⬆⬇]/g, (c) => {
      if (c === "←") return "<";
      if (c === "→") return ">";
      if (c === "↑") return "^";
      if (c === "↓") return "v";
      return c;
    })
    .replace(/[✓✔]/g, "x")
    .replace(/[✗✘]/g, "x")
    .replace(/⚠/g, "!")
    .replace(/·/g, ".");
}

export class Renderer {
  private readonly output: { write(chunk: string): unknown };
  private columns: number;
  private rows: number;
  private readonly colors: ColorMode;
  private readonly syncOutput: boolean;
  private readonly ascii: boolean;
  /** Previous frame rows as encoded ANSI strings (length === rows). */
  private prev: string[] = [];
  private cursorHidden = true;

  constructor(opts: RendererOptions) {
    this.output = opts.output ?? process.stdout;
    this.columns = Math.max(1, opts.columns);
    this.rows = Math.max(1, opts.rows);
    this.colors = opts.colors ?? "none";
    this.syncOutput = opts.syncOutput ?? false;
    this.ascii = opts.ascii ?? false;
  }

  get size(): { columns: number; rows: number } {
    return { columns: this.columns, rows: this.rows };
  }

  /** Terminal resized: recompute and force a full redraw next frame. */
  resize(columns: number, rows: number): void {
    const c = Math.max(1, columns);
    const r = Math.max(1, rows);
    if (c === this.columns && r === this.rows) return;
    this.columns = c;
    this.rows = r;
    this.prev = [];
  }

  /** Force every row to be rewritten on the next render(). */
  invalidate(): void {
    this.prev = [];
  }

  /** Ensure the hardware cursor is hidden (called once at screen start). */
  hideCursor(): void {
    if (!this.cursorHidden) {
      this.output.write(hideCursor());
      this.cursorHidden = true;
    }
  }

  showCursor(): void {
    if (this.cursorHidden) {
      this.output.write(showCursor());
      this.cursorHidden = false;
    }
  }

  /**
   * Encode one `Line` to an ANSI string bounded to `columns` cells.
   * Sanitization happens here — the single enforcement point.
   */
  private encodeLine(line: Line): string {
    const width = this.columns;
    let out = "";
    let w = 0;
    for (const seg of line) {
      if (w >= width) break;
      let text = sanitizeDisplay(seg.text);
      if (this.ascii) text = asciiDegrade(text);
      if (text.length === 0) continue;
      // Truncate this segment's text to remaining cells.
      const remaining = width - w;
      if (displayWidth(text) > remaining) {
        text = truncateToWidth(text, remaining);
        if (text.length === 0) break;
      }
      out += styleText(text, seg.style, this.colors);
      w += displayWidth(text);
    }
    return out;
  }

  /**
   * Draw a frame. `lines` may be shorter or longer than `rows`; missing
   * rows render blank, extra rows are ignored (components own scrolling).
   * `cursor` positions the hardware cursor after the draw: a 1-based
   * `{row,col}`, `"hide"` (default), or `null` to leave it at the last
   * written row.
   */
  render(lines: Line[], cursor: CursorSpec = "hide"): void {
    const frame: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const line = lines[r];
      frame.push(line ? this.encodeLine(line) : "");
    }

    // Diff against previous frame.
    const changed: number[] = [];
    for (let r = 0; r < this.rows; r++) {
      if (frame[r] !== this.prev[r]) changed.push(r);
    }
    this.prev = frame;

    let out = "";
    if (changed.length > 0) {
      if (this.syncOutput) out += syncOutputBegin();
      if (!this.cursorHidden) {
        out += hideCursor();
        this.cursorHidden = true;
      }
      for (const r of changed) {
        out += `${cup(r + 1, 1)}${frame[r] ?? ""}${el()}`;
      }
      if (this.syncOutput) out += syncOutputEnd();
      // ensure clean SGR state at end of frame
      out += RESET;
    }

    // Cursor placement
    if (cursor && cursor !== "hide") {
      out += cup(cursor.row, cursor.col);
      this.cursorHidden = false;
    } else if (changed.length === 0) {
      // nothing drawn; cursor stays wherever it was
    }

    if (out.length > 0) this.output.write(out);
  }
}

// --- Screen lifecycle ---------------------------------------------------------

export interface ScreenOptions extends Omit<RendererOptions, "columns" | "rows"> {
  columns?: number;
  rows?: number;
  /** Use the alternate screen. Default true for full-screen plugin panes;
   *  pass false for inline/status surfaces that should remain in scrollback. */
  alternateScreen?: boolean;
  /** Enable bracketed paste reporting. Default true. */
  bracketedPaste?: boolean;
}

/**
 * A `Renderer` plus terminal lifecycle: enters alt-screen/bracketed-paste
 * on create, restores everything on close. One Screen per TUI process.
 */
export class Screen {
  readonly renderer: Renderer;
  private readonly output: { write(chunk: string): unknown };
  private readonly alternateScreen: boolean;
  private readonly bracketedPaste: boolean;
  private closed = false;

  private constructor(opts: ScreenOptions) {
    this.output = opts.output ?? process.stdout;
    this.alternateScreen = opts.alternateScreen ?? true;
    this.bracketedPaste = opts.bracketedPaste ?? true;
    this.renderer = new Renderer({
      ...opts,
      columns: opts.columns ?? 80,
      rows: opts.rows ?? 24,
    });
  }

  static create(opts: ScreenOptions = {}): Screen {
    const screen = new Screen(opts);
    let init = "";
    if (screen.alternateScreen) init += enterAltScreen();
    if (screen.bracketedPaste) init += enableBracketedPaste();
    init += hideCursor();
    init += "\x1b[2J"; // clear screen (harmless in alt buffer; also helps inline mode start clean)
    screen.output.write(init);
    return screen;
  }

  get columns(): number {
    return this.renderer.size.columns;
  }

  get rows(): number {
    return this.renderer.size.rows;
  }

  resize(columns: number, rows: number): void {
    this.renderer.resize(columns, rows);
  }

  render(lines: Line[], cursor: CursorSpec = "hide"): void {
    this.renderer.render(lines, cursor);
  }

  /**
   * Tear down: leave alt screen (if used), disable bracketed paste, restore
   * cursor. `farewell` lines are printed to the main screen *after*
   * leaving the alternate screen so they persist in scrollback.
   */
  close(farewell?: string[]): void {
    if (this.closed) return;
    this.closed = true;
    const cols = this.columns;
    let out = "";
    if (this.bracketedPaste) out += disableBracketedPaste();
    if (this.alternateScreen) {
      out += leaveAltScreen();
      out += showCursor();
      if (farewell && farewell.length > 0) {
        for (const f of farewell) {
          const clean = sanitizeDisplay(f);
          out += `${truncateToWidth(clean, cols)}\n`;
        }
      }
    } else {
      out += showCursor();
      if (farewell && farewell.length > 0) {
        for (const f of farewell) out += `${truncateToWidth(sanitizeDisplay(f), cols)}\n`;
      }
    }
    out += RESET;
    try {
      this.output.write(out);
    } catch {
      // stdout gone — nothing more we can do
    }
  }
}
