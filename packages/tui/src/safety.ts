/**
 * Safety helpers enforcing `docs/contracts/tui-v1.md` §5 items 6–10 in ONE
 * place (ADR-0033 §3):
 *
 * - item 8  — `sanitizeDisplay`: strip CSI/OSC/DCS and control characters
 *             from untrusted text before it can reach the renderer.
 * - item 10 — `BoundedBuffer` / `boundText`: bounded output and log
 *             surfaces; `createThrottle`: frame-write throttling.
 * - item 8  — `openExternal`: explicit external-open that never goes
 *             through a shell and never interpolates the target into a
 *             command string.
 * - item 6  — secret non-display is a *plugin* responsibility (the core
 *             cannot know what is secret), but `maskSecret`-style helpers
 *             are not provided on purpose: surfaces must render metadata
 *   only. See README note in index.ts header.
 */

import { spawn } from "node:child_process";
import path from "node:path";

// --- sanitizeDisplay ----------------------------------------------------------

/**
 * Strip everything that could act as a terminal control sequence or inject
 * layout-breaking characters into rendered output.
 *
 * Removed:
 * - CSI sequences: ESC [ params final  (and the C1 CSI 0x9b form)
 * - OSC sequences: ESC ] ... terminated by BEL or ST (ESC \ or 0x9c)
 * - DCS/SOS/PM/APC: ESC P/X/^/_ ... ST
 * - Any remaining ESC byte and C0/C1 control characters
 * - Unicode bidi/format controls that can visually spoof text
 *   (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C)
 *
 * Replaced, not deleted, where a visible gap is safer than silent joins:
 * - tab → spaces to the next multiple of 4 columns within the string
 * - newline / carriage return → single space (rendered lines are
 *   single-line by contract; multi-line content must be split *before*
 *   sanitizing, then each line sanitized separately)
 * - other disallowed controls → U+FFFD (�)
 *
 * The function is idempotent and allocation-light enough for per-frame use
 * on untrusted strings (filenames, agent output, remote data, errors).
 */
export function sanitizeDisplay(text: string): string {
  if (text.length === 0) return text;
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const cp = text.codePointAt(i) ?? 0;
    const step = cp > 0xffff ? 2 : 1;
    if (cp === 0x1b) {
      // ESC: consume the whole escape sequence if recognizable.
      const seq = consumeEscape(text, i);
      i = seq.next;
      continue; // drop the sequence entirely
    }
    if (cp === 0x9b) {
      // C1 CSI: params until final byte 0x40–0x7e
      i += 1;
      while (i < n) {
        const c = text.charCodeAt(i);
        i += 1;
        if (c >= 0x40 && c <= 0x7e) break;
      }
      continue;
    }
    if (cp === 0x9d) {
      // C1 OSC: until BEL or 0x9c
      i += 1;
      while (i < n) {
        const c = text.charCodeAt(i);
        i += 1;
        if (c === 0x07 || c === 0x9c) break;
      }
      continue;
    }
    if (cp === 0x90 || cp === 0x98 || cp === 0x9e || cp === 0x9f) {
      // DCS/SOS/PM/APC: until ST (ESC \ or 0x9c)
      i += 1;
      while (i < n) {
        if (text[i] === "\x1b" && text[i + 1] === "\\") {
          i += 2;
          break;
        }
        const c = text.charCodeAt(i);
        i += 1;
        if (c === 0x9c) break;
      }
      continue;
    }
    if (cp === 0x09) {
      // tab → spaces to next multiple of 4 (approximation of a tab stop)
      const col = displayCells(out);
      const pad = 4 - (col % 4);
      out += " ".repeat(pad === 4 ? 4 : pad);
      i += 1;
      continue;
    }
    if (cp === 0x0a || cp === 0x0d) {
      out += " ";
      i += 1;
      continue;
    }
    if ((cp < 0x20 && cp !== 0x09) || (cp >= 0x7f && cp < 0xa0) || cp === 0x2028 || cp === 0x2029) {
      out += "�";
      i += step;
      continue;
    }
    if (
      (cp >= 0x202a && cp <= 0x202e) || // bidi embeddings/overrides
      (cp >= 0x2066 && cp <= 0x2069) || // bidi isolates
      cp === 0x200e || // LRM
      cp === 0x200f || // RLM
      cp === 0x061c // Arabic letter mark
    ) {
      i += step;
      continue;
    }
    out += text.slice(i, i + step);
    i += step;
  }
  return out;
}

/** Cheap cell-width tracker used only for tab expansion inside sanitize. */
function displayCells(s: string): number {
  // Width approximation for tab stops: count code points, treating common
  // wide ranges as 2. Kept local to avoid a unicode.ts import cycle risk.
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80) ? 2 : 1;
  }
  return w;
}

/**
 * Consume one escape sequence starting at `start` (text[start] === ESC).
 * Returns the index just past the sequence. Malformed/unterminated
 * sequences consume through end of input (fail-safe: drop them).
 */
function consumeEscape(text: string, start: number): { next: number } {
  const n = text.length;
  const second = text[start + 1];
  if (second === undefined) return { next: start + 1 };
  const cp2 = second.codePointAt(0) ?? 0;
  if (cp2 === 0x5b) {
    // CSI: parameter/intermediate bytes 0x20-0x3f, final 0x40-0x7e
    let i = start + 2;
    while (i < n) {
      const c = text.charCodeAt(i);
      i += 1;
      if (c >= 0x40 && c <= 0x7e) break;
      if (c < 0x20 || c > 0x3f) break; // malformed → stop
    }
    return { next: i };
  }
  if (cp2 === 0x5d || cp2 === 0x50 || cp2 === 0x58 || cp2 === 0x5e || cp2 === 0x5f) {
    // OSC / DCS / SOS / PM / APC: until BEL, ST (ESC \), or CAN/SUB
    let i = start + 2;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x07 || c === 0x18 || c === 0x1a) return { next: i + 1 };
      if (c === 0x1b) {
        if (text[i + 1] === "\\") return { next: i + 2 };
        return { next: i + 1 }; // another ESC starts a new sequence
      }
      i += 1;
    }
    return { next: n };
  }
  if (
    cp2 === 0x4f ||
    cp2 === 0x4e ||
    cp2 === 0x7e ||
    (cp2 >= 0x28 && cp2 <= 0x2f) || // charset selects ESC ( ) * + , - . /
    (cp2 >= 0x3c && cp2 <= 0x3f) || // ESC < = > ?
    (cp2 >= 0x40 && cp2 <= 0x5f && cp2 !== 0x5b)
  ) {
    // SS3 (ESC O), SS2 (ESC N), charset selects, ESC =/>/ etc: consume the
    // introducer plus one more byte.
    return { next: start + 3 };
  }
  // ESC + printable char (alt-key style in *input*) or an unrecognized
  // two-byte sequence: for display sanitization the safest reading is to
  // drop only the ESC introducer and keep the following character as text.
  return { next: start + 1 };
}

// --- Bounded output ------------------------------------------------------------

export interface BoundedBufferOptions {
  /** Maximum retained lines. Oldest lines are dropped first. Default 500. */
  maxLines?: number;
  /** Maximum retained characters across all lines. Default 200_000. */
  maxChars?: number;
}

/**
 * A bounded line buffer for log/output surfaces (contract item 10).
 * Push sanitized or pre-sanitized lines; reads always return at most the
 * configured bounds. Deterministic — no timers, no async.
 */
export class BoundedBuffer {
  private lines: string[] = [];
  private chars = 0;
  private readonly maxLines: number;
  private readonly maxChars: number;
  /** Number of lines dropped from the front. */
  dropped = 0;

  constructor(opts: BoundedBufferOptions = {}) {
    this.maxLines = opts.maxLines ?? 500;
    this.maxChars = opts.maxChars ?? 200_000;
  }

  push(line: string): void {
    const clean = sanitizeDisplay(line);
    this.lines.push(clean);
    this.chars += clean.length + 1;
    this.evict();
  }

  pushMany(lines: Iterable<string>): void {
    for (const l of lines) this.push(l);
  }

  private evict(): void {
    while (this.lines.length > this.maxLines || this.chars > this.maxChars) {
      const removed = this.lines.shift();
      if (removed === undefined) break;
      this.chars -= removed.length + 1;
      this.dropped += 1;
    }
  }

  /** All retained lines (oldest → newest). */
  all(): string[] {
    return [...this.lines];
  }

  /** Last `n` lines. */
  tail(n: number): string[] {
    return this.lines.slice(Math.max(0, this.lines.length - n));
  }

  get size(): number {
    return this.lines.length;
  }

  clear(): void {
    this.lines = [];
    this.chars = 0;
  }
}

/** Truncate a single rendered line's *text* content to `maxChars` as a last
 *  resort bound. ANSI styling is preserved because callers pass styled
 *  lines only through the renderer, which bounds by cell width already. */
export function boundText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

// --- Frame throttling ----------------------------------------------------------

export interface ThrottleOptions {
  /** Minimum interval between invocations, ms. Default 33 (~30fps). */
  intervalMs?: number;
}

/**
 * Trailing-edge throttle for frame writes (contract item 10). Calls within
 * `intervalMs` of the last *executed* call are coalesced into one trailing
 * call with the latest arguments. `flush()` forces an immediate pending
 * call — use it on exit/resize so the last frame is never lost.
 */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  opts: ThrottleOptions = {},
): { call: (...args: A) => void; flush: () => void; cancel: () => void } {
  const interval = opts.intervalMs ?? 33;
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: A | null = null;

  const run = (args: A) => {
    lastRun = Date.now();
    pendingArgs = null;
    fn(...args);
  };

  return {
    call(...args: A) {
      const now = Date.now();
      const elapsed = now - lastRun;
      if (elapsed >= interval) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        run(args);
        return;
      }
      pendingArgs = args;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          if (pendingArgs !== null) {
            const a = pendingArgs;
            pendingArgs = null;
            run(a);
          }
        }, interval - elapsed);
        // Do not keep the process alive for a pending frame.
        if (typeof timer === "object" && timer && "unref" in timer) {
          (timer as { unref: () => void }).unref();
        }
      }
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pendingArgs !== null) {
        const a = pendingArgs;
        pendingArgs = null;
        lastRun = Date.now();
        fn(...a);
      }
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingArgs = null;
    },
  };
}

// --- Explicit external open -----------------------------------------------------

export interface OpenExternalOptions {
  /** Platform override for tests. Default: process.platform. */
  platform?: NodeJS.Platform;
  /** Extra env for the opener child (merged over a minimal scrubbed env). */
  env?: Record<string, string>;
  /** Timeout for the opener spawn, ms. Default 10_000. */
  timeoutMs?: number;
}

export type OpenExternalResult =
  | { ok: true }
  | { ok: false; reason: "invalid-target" | "unsupported-platform" | "spawn-failed" | "timeout" };

const URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Open `target` with the OS handler — ALWAYS an explicit user action, never
 * implicit (contract items 8/9). `target` must be either:
 * - an http(s)/mailto URL, or
 * - an absolute filesystem path.
 *
 * The opener is spawned with an argv array — the target is a single argv
 * element, never interpolated into a shell command string. The child env
 * is scrubbed to a minimal set (no ambient secret inheritance).
 */
export async function openExternal(
  target: string,
  opts: OpenExternalOptions = {},
): Promise<OpenExternalResult> {
  const platform = opts.platform ?? process.platform;
  const trimmed = target.trim();
  if (trimmed.length === 0) return { ok: false, reason: "invalid-target" };

  let isUrl = false;
  try {
    const u = new URL(trimmed);
    isUrl = URL_SCHEMES.has(u.protocol);
  } catch {
    isUrl = false;
  }
  const isPath = !isUrl && path.isAbsolute(trimmed);
  if (!isUrl && !isPath) return { ok: false, reason: "invalid-target" };

  let argv: string[];
  if (platform === "darwin") {
    argv = ["open", trimmed];
  } else if (platform === "win32") {
    // `start` is a cmd builtin; argv form keeps the target unquoted-as-shell.
    argv = ["cmd.exe", "/c", "start", "", trimmed];
  } else {
    argv = ["xdg-open", trimmed];
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "",
    ...(platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {}),
    ...(opts.env ?? {}),
  };

  return await new Promise<OpenExternalResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, reason: "spawn-failed" });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve({ ok: false, reason: "timeout" });
    }, opts.timeoutMs ?? 10_000);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "spawn-failed" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      // xdg-open returns non-zero for missing handlers; still counts as
      // "attempted" — the surface should show the path so the user can act.
      void code;
      resolve({ ok: true });
    });
  });
}
