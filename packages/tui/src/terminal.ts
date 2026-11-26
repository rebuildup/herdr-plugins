/**
 * Terminal capability detection for `packages/tui`.
 *
 * Everything is derived from the environment and stream properties — no
 * terminal queries that could block startup. Where detection is a
 * heuristic (synchronized output, truecolor), the docs comment says so and
 * callers can override explicitly.
 */

import type { ColorMode } from "./ansi";

export interface TerminalInfo {
  /** Terminal columns (>=1). Falls back to 80 when unknown. */
  columns: number;
  /** Terminal rows (>=1). Falls back to 24 when unknown. */
  rows: number;
  /** Resolved color depth. */
  colors: ColorMode;
  /** True when running on a real TTY (stdin+stdout). */
  isTTY: boolean;
  /** Synchronized-output (mode 2026) should be attempted. */
  syncOutput: boolean;
  /** ASCII-safe degradation: replace box-drawing/typographic glyphs. */
  ascii: boolean;
  /** TERM value ("" when unset). */
  term: string;
  /** TERM_PROGRAM value ("" when unset). */
  termProgram: string;
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  /** Stream to read dimensions from. Default process.stdout. */
  stdout?: NodeJS.WriteStream;
  /** stdin stream for the isTTY check. Default process.stdin. */
  stdin?: NodeJS.ReadStream;
  /** Explicit overrides win over detection. */
  colors?: ColorMode;
  syncOutput?: boolean;
  ascii?: boolean;
}

/** TERM programs known to support synchronized output (mode 2026). */
const SYNC_PROGRAMS = new Set([
  "iTerm.app",
  "WezTerm",
  "kitty",
  "ghostty",
  "Alacritty",
  "foot",
  "rio",
  "contour",
  "WindowsTerminal",
]);

/** TERM substrings known to support synchronized output. */
const SYNC_TERM_PARTS = ["kitty", "ghostty", "foot", "alacritty", "wezterm", "contour", "rio"];

/**
 * Heuristic synchronized-output detection. Mode 2026 is a private mode:
 * terminals that do not implement it ignore the set/reset harmlessly, so
 * the main reason to disable it is multiplexers (tmux/screen) that would
 * swallow or mis-render the markers. `auto` enables it everywhere except
 * dumb terms and tmux/screen without explicit opt-in.
 */
export function detectSyncOutput(env: NodeJS.ProcessEnv): boolean {
  if (env.TUI_SYNC === "0" || env.TUI_SYNC === "off") return false;
  if (env.TUI_SYNC === "1" || env.TUI_SYNC === "on") return true;
  const term = env.TERM ?? "";
  if (term === "dumb" || term === "") return false;
  if (env.TMUX || env.STY) {
    // tmux/screen only pass mode 2026 through with extended-keys/passthrough
    // configured; default to off inside multiplexers.
    return env.TUI_SYNC_INNER === "1";
  }
  const prog = env.TERM_PROGRAM ?? "";
  if (SYNC_PROGRAMS.has(prog)) return true;
  const lower = term.toLowerCase();
  if (SYNC_TERM_PARTS.some((p) => lower.includes(p))) return true;
  // VTE-based terminals (gnome-terminal, tilix, ...) ≥0.78 support it;
  // VTE is common enough that attempting is reasonable — unsupported
  // terminals ignore the sequences.
  if (lower.includes("vte") || lower.includes("gnome") || prog === "vte") return true;
  return false;
}

export function detectColors(env: NodeJS.ProcessEnv, isTTY: boolean): ColorMode {
  if (!isTTY) return "none";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.TERM === "dumb") return "none";
  if (env.TERM === "" || env.TERM === undefined) return "basic";
  const colorterm = env.COLORTERM ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const term = env.TERM.toLowerCase();
  if (term.includes("256color") || term.includes("256") || env.TERM_COLORS === "256") {
    return "256";
  }
  return "basic";
}

/**
 * Detect terminal capabilities. `columns`/`rows` come from the stream when
 * available (TIOCGWINSZ-backed on real TTYs), else env COLUMNS/LINES, else
 * 80x24.
 */
export function detectTerminal(opts: DetectOptions = {}): TerminalInfo {
  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const isTTY = Boolean(stdout.isTTY && stdin.isTTY);

  const colsRaw = stdout.columns ?? Number.parseInt(env.COLUMNS ?? "", 10);
  const rowsRaw = stdout.rows ?? Number.parseInt(env.LINES ?? "", 10);
  const columns = Number.isFinite(colsRaw) && (colsRaw as number) > 0 ? (colsRaw as number) : 80;
  const rows = Number.isFinite(rowsRaw) && (rowsRaw as number) > 0 ? (rowsRaw as number) : 24;

  const colors = opts.colors ?? detectColors(env, isTTY);
  const term = env.TERM ?? "";
  const termProgram = env.TERM_PROGRAM ?? "";

  return {
    columns,
    rows,
    colors,
    isTTY,
    syncOutput: opts.syncOutput ?? detectSyncOutput(env),
    ascii: opts.ascii ?? (term === "dumb" || env.TUI_ASCII === "1"),
    term,
    termProgram,
  };
}

/** Current size, re-read live (for SIGWINCH). */
export function readSize(stdout: NodeJS.WriteStream = process.stdout): {
  columns: number;
  rows: number;
} {
  const cols = stdout.columns;
  const rows = stdout.rows;
  return {
    columns: cols && cols > 0 ? cols : 80,
    rows: rows && rows > 0 ? rows : 24,
  };
}
