/**
 * ANSI/OSC escape sequences and SGR styling for `packages/tui`.
 *
 * Zero-dependency by design (ADR-0032): every sequence is emitted
 * literally. Style helpers are pure functions returning escape strings;
 * degradation (NO_COLOR / TERM=dumb / 8-color) is applied by the renderer
 * in `screen.ts`, not here, so styling code stays terminal-agnostic.
 *
 * Color model for `Style.fg`/`Style.bg`:
 * - `string`   — one of the 16 basic color names (BASIC_COLORS)
 * - `number`   — 0-255: xterm-256 palette index; >255 (0xRRGGBB): truecolor
 * Degradation order per frame: truecolor > 256 > basic > none.
 */

export const ESC = "\x1b";

// --- Cursor / screen control ------------------------------------------------

/** Move cursor to 1-based (row, col). */
export function cup(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}

/** Erase from cursor to end of line. */
export function el(): string {
  return `${ESC}[K`;
}

export function hideCursor(): string {
  return `${ESC}[?25l`;
}

export function showCursor(): string {
  return `${ESC}[?25h`;
}

/** Enter the alternate screen (1049: alt buffer + clear + save cursor). */
export function enterAltScreen(): string {
  return `${ESC}[?1049h`;
}

export function leaveAltScreen(): string {
  return `${ESC}[?1049l`;
}

/** Enable bracketed paste (mode 2004). Terminals then wrap pasted text in
 *  ESC[200~ ... ESC[201~ so the input parser can keep it out of the key
 *  stream. */
export function enableBracketedPaste(): string {
  return `${ESC}[?2004h`;
}

export function disableBracketedPaste(): string {
  return `${ESC}[?2004l`;
}

/** Synchronized output (mode 2026): terminals that support it buffer the
 *  enclosed frame and present it atomically, eliminating flicker. Terminals
 *  that do not know the mode ignore the private-set sequences harmlessly. */
export function syncOutputBegin(): string {
  return `${ESC}[?2026h`;
}

export function syncOutputEnd(): string {
  return `${ESC}[?2026l`;
}

// --- SGR styling -------------------------------------------------------------

export type ColorMode = "none" | "basic" | "256" | "truecolor";

export interface Style {
  fg?: number | string;
  bg?: number | string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

export const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ITALIC = `${ESC}[3m`;
const UNDERLINE = `${ESC}[4m`;
const INVERSE = `${ESC}[7m`;
const STRIKE = `${ESC}[9m`;

/** Named ANSI colors 0-15 (the portable subset shared by basic and 256). */
export const BASIC_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;

export type BasicColorName = (typeof BASIC_COLORS)[number];

const BASIC_INDEX: Record<BasicColorName, number> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  "bright-black": 8,
  "bright-red": 9,
  "bright-green": 10,
  "bright-yellow": 11,
  "bright-blue": 12,
  "bright-magenta": 13,
  "bright-cyan": 14,
  "bright-white": 15,
};

/**
 * Map an arbitrary color value to an SGR sequence for `mode`, or null when
 * the mode cannot represent it.
 */
function colorCode(color: number | string, isBg: boolean, mode: ColorMode): string | null {
  if (mode === "none") return null;
  if (typeof color === "string") {
    const idx = BASIC_INDEX[color as BasicColorName];
    if (idx === undefined) return null;
    if (idx < 8) return `${ESC}[${isBg ? 40 + idx : 30 + idx}m`;
    // bright: 90-97 fg / 100-107 bg
    return `${ESC}[${isBg ? 100 + (idx - 8) : 90 + (idx - 8)}m`;
  }
  const n = Math.trunc(color);
  const isTrue = n > 0xffffff ? false : n > 255;
  if (isTrue && mode === "truecolor") {
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    return `${ESC}[${isBg ? 48 : 38};2;${r};${g};${b}m`;
  }
  if (mode === "truecolor" || mode === "256") {
    if (isTrue) {
      // 256-mode approximation of a truecolor: snap to the 6x6x6 cube.
      const r = Math.min(5, Math.round(((n >> 16) & 0xff) / 51));
      const g = Math.min(5, Math.round(((n >> 8) & 0xff) / 51));
      const b = Math.min(5, Math.round((n & 0xff) / 51));
      const idx = 16 + 36 * r + 6 * g + b;
      return `${ESC}[${isBg ? 48 : 38};5;${idx}m`;
    }
    return `${ESC}[${isBg ? 48 : 38};5;${n & 0xff}m`;
  }
  // basic mode: degrade any numeric color to the nearest of the 16 basics.
  const b = isTrue ? trueToBasic(n) : paletteToBasic(n);
  const code = b < 8 ? 30 + b : 90 + (b - 8);
  return `${ESC}[${isBg ? (b < 8 ? 40 + b : 100 + (b - 8)) : code}m`;
}

/** 256-palette index → nearest basic index (0-15). Approximation, documented:
 *  hue-dominant for the color cube, luminance for grayscale. */
function paletteToBasic(n: number): number {
  if (n < 16) return n;
  if (n >= 232) {
    // grayscale ramp: darker half → bright-black, lighter → white
    return n - 232 < 4 ? 8 : 7;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const lum = (c: number) => (c === 0 ? 0 : c * 40 + 55);
  const rl = lum(r);
  const gl = lum(g);
  const bl = lum(b);
  const max = Math.max(rl, gl, bl);
  if (max === 0) return 8;
  let idx: number;
  if (rl === max && rl >= gl && rl >= bl)
    idx = 1; // red
  else if (gl === max && gl >= bl)
    idx = 2; // green
  else idx = 4; // blue
  const bright = r >= 4 || g >= 4 || b >= 4;
  return bright ? idx + 8 : idx;
}

function trueToBasic(n: number): number {
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const max = Math.max(r, g, b);
  if (max < 40) return 8;
  let idx: number;
  if (r >= g && r >= b) idx = 1;
  else if (g >= b) idx = 2;
  else idx = 4;
  return max >= 160 ? idx + 8 : idx;
}

/**
 * Wrap `text` in SGR sequences for `style`, degraded to `mode`.
 * A RESET is appended whenever any attribute was emitted so callers never
 * leak SGR state. Returns `text` unchanged when there is no style.
 *
 * Note: `mode === "none"` still emits monochrome attributes (bold, inverse,
 * underline, ...). NO_COLOR disables color, not emphasis — matching the
 * NO_COLOR convention.
 */
export function styleText(text: string, style: Style | undefined, mode: ColorMode): string {
  if (!style) return text;
  const parts: string[] = [];
  if (style.bold) parts.push(BOLD);
  if (style.dim) parts.push(DIM);
  if (style.italic) parts.push(ITALIC);
  if (style.underline) parts.push(UNDERLINE);
  if (style.inverse) parts.push(INVERSE);
  if (style.strike) parts.push(STRIKE);
  if (style.fg !== undefined) {
    const c = colorCode(style.fg, false, mode);
    if (c) parts.push(c);
  }
  if (style.bg !== undefined) {
    const c = colorCode(style.bg, true, mode);
    if (c) parts.push(c);
  }
  if (parts.length === 0) return text;
  return `${parts.join("")}${text}${RESET}`;
}
