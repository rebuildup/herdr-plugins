/**
 * Raw-mode stdin input and key parsing for `packages/tui`.
 *
 * - UTF-8 safe: bytes are decoded with a streaming `TextDecoder`, so CJK,
 *   emoji, and multi-byte input split across reads reassemble correctly.
 * - Printable input is emitted per *grapheme cluster* (Intl.Segmenter) so
 *   IME-style composed text and emoji arrive as single events.
 * - Bracketed paste (mode 2004) is parsed into `{kind:"paste"}` events and
 *   never leaks into the key stream.
 * - Terminal query responses (OSC/CSI reports) are swallowed, not emitted
 *   as keys.
 * - A trailing ESC is held briefly (`flushPending`) so Alt+key works while
 *   a lone Escape still resolves as the `escape` key.
 *
 * Everything here is pure and stream-injectable: tests feed strings/bytes
 * directly; `attachInput` wires real TTY streams for the app layer.
 */

import { graphemes } from "./unicode";

// --- Event types ---------------------------------------------------------------

export type KeyEvent =
  | {
      kind: "key";
      /** Canonical key name: a special name ("enter", "up", ...) or the
       *  literal grapheme for printable input. "space" for the space bar. */
      key: string;
      /** The literal text this key inserts, when printable (" " for space). */
      char?: string;
      ctrl: boolean;
      shift: boolean;
      alt: boolean;
    }
  | { kind: "paste"; text: string }
  | { kind: "eof" };

/** Names that are NOT literal text (used by isPrintableKey / keyText). */
export const NAMED_KEYS = new Set([
  "enter",
  "escape",
  "tab",
  "backspace",
  "space",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  "delete",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

/** Text a printable key event would insert, or undefined for named keys
 *  and modified keys. */
export function keyText(ev: KeyEvent): string | undefined {
  if (ev.kind !== "key" || ev.ctrl || ev.alt) return undefined;
  if (ev.key === "space") return " ";
  if (NAMED_KEYS.has(ev.key)) return undefined;
  return ev.char ?? ev.key;
}

export function isPrintableKey(ev: KeyEvent): boolean {
  return keyText(ev) !== undefined;
}

// --- Key spec matching -----------------------------------------------------------

export interface KeySpec {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Parse "ctrl+c", "shift+tab", "?", "enter", "alt+left" into a spec.
 *  Returns null for unparseable input. */
export function parseKeySpec(spec: string): KeySpec | null {
  const parts = spec.split("+");
  const mods = { ctrl: false, shift: false, alt: false };
  let key = "";
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (lp === "ctrl" || lp === "control") mods.ctrl = true;
    else if (lp === "shift") mods.shift = true;
    else if (lp === "alt" || lp === "meta") mods.alt = true;
    else if (key === "") key = p === " " ? "space" : p;
    else return null;
  }
  if (key === "") return null;
  return { key, ...mods };
}

/** Does `ev` match `spec`? Printable specs match the literal key and require
 *  no ctrl/alt (shift is allowed — terminals report shifted letters as the
 *  uppercase char itself). */
export function matchKey(ev: KeyEvent, spec: string | KeySpec): boolean {
  const s = typeof spec === "string" ? parseKeySpec(spec) : spec;
  if (!s || ev.kind !== "key") return false;
  if (s.key !== ev.key) return false;
  if ((s.ctrl ?? false) !== ev.ctrl) return false;
  if ((s.alt ?? false) !== ev.alt) return false;
  if (s.shift !== undefined && s.shift !== ev.shift) return false;
  // A spec without modifiers must not match a modified key.
  if (s.ctrl === undefined && s.alt === undefined && (ev.ctrl || ev.alt)) return false;
  return true;
}

/** Human-readable key name for help overlays: "Ctrl-C", "Enter", "↑". */
export function displayKey(spec: string | KeySpec): string {
  const s = typeof spec === "string" ? parseKeySpec(spec) : spec;
  if (!s) return String(spec);
  const names: Record<string, string> = {
    enter: "Enter",
    escape: "Esc",
    tab: "Tab",
    backspace: "Backspace",
    space: "Space",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    home: "Home",
    end: "End",
    pageup: "PgUp",
    pagedown: "PgDn",
    insert: "Ins",
    delete: "Del",
  };
  const base =
    names[s.key] ??
    (NAMED_KEYS.has(s.key) ? s.key : s.key.length === 1 ? s.key.toUpperCase() : s.key);
  const parts: string[] = [];
  if (s.ctrl) parts.push("Ctrl");
  if (s.alt) parts.push("Alt");
  if (s.shift) parts.push("Shift");
  parts.push(base);
  return parts.join("-");
}

// --- Parser ---------------------------------------------------------------------

const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

/** CSI `~` final-byte parameter → key name. */
const TILDE_KEYS: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

const ARROW_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

/** Kitty/CSI-u functional codes we recognize (unicode-key-code values). */
const CSI_U_KEYS: Record<number, string> = {
  9: "tab",
  13: "enter",
  27: "escape",
  127: "backspace",
};

export interface KeyParserOptions {
  /** Recognize bracketed-paste markers. Default true. */
  paste?: boolean;
}

interface Mods {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

const NO_MODS: Mods = { ctrl: false, shift: false, alt: false };

/** xterm modifier param (1 + bitmask: shift=1, alt=2, ctrl=4). */
function modsFromParam(param: number | undefined): Mods {
  if (param === undefined || param < 1) return { ...NO_MODS };
  const m = param - 1;
  return {
    shift: (m & 1) !== 0,
    alt: (m & 2) !== 0,
    ctrl: (m & 4) !== 0,
  };
}

export class KeyParser {
  private buf = "";
  private decoder: TextDecoder;
  private inPaste = false;
  private pasteBuf = "";
  private readonly pasteEnabled: boolean;

  constructor(opts: KeyParserOptions = {}) {
    this.pasteEnabled = opts.paste ?? true;
    this.decoder = new TextDecoder("utf-8", { fatal: false });
  }

  /** Feed raw bytes (UTF-8, possibly split mid-sequence). */
  feedBytes(data: Uint8Array): KeyEvent[] {
    return this.feed(this.decoder.decode(data, { stream: true }));
  }

  /** Feed already-decoded text. */
  feed(text: string): KeyEvent[] {
    this.buf += text;
    return this.drain();
  }

  /**
   * Resolve pending input after the caller decides no more is coming —
   * e.g. an escape-key timeout or stdin EOF. A trailing lone ESC becomes an
   * `escape` key; unterminated escape fragments are dropped (fail-safe);
   * an unterminated paste is emitted with the content received so far.
   */
  flush(): KeyEvent[] {
    const events = this.drain(true);
    if (this.inPaste) {
      this.inPaste = false;
      this.pasteBuf += this.buf;
      this.buf = "";
      events.push({ kind: "paste", text: this.pasteBuf });
      this.pasteBuf = "";
    }
    // Anything still buffered is an unterminated string sequence (OSC/DCS)
    // that even flush mode refused to consume: drop it rather than emit
    // parameter bytes as phantom keys.
    this.buf = "";
    return events;
  }

  private drain(flushMode = false): KeyEvent[] {
    const events: KeyEvent[] = [];
    for (;;) {
      if (this.inPaste) {
        const end = this.buf.indexOf("\x1b[201~");
        if (end === -1) {
          // No terminator yet: move all but a possible partial-terminator
          // tail ("\x1b[201" is 5 chars; the marker is 6) into pasteBuf so a
          // split "\x1b[20" + "1~" across reads still terminates correctly.
          const keep = Math.min(5, this.buf.length);
          this.pasteBuf += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        this.pasteBuf += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 6);
        this.inPaste = false;
        events.push({ kind: "paste", text: this.pasteBuf });
        this.pasteBuf = "";
        continue;
      }
      if (this.buf.length === 0) break;
      const consumed = this.parseOne(events, flushMode);
      if (!consumed) break;
    }
    return events;
  }

  /** Try to parse exactly one event from buf. Returns false if more input
   *  is needed (incomplete sequence at end of buffer). */
  private parseOne(events: KeyEvent[], flushMode: boolean): boolean {
    const buf = this.buf;
    const c0 = buf.charCodeAt(0);

    // Bracketed paste start
    if (this.pasteEnabled && buf.startsWith("\x1b[200~")) {
      this.buf = buf.slice(6);
      this.inPaste = true;
      this.pasteBuf = "";
      return true;
    }

    if (c0 === 0x1b) {
      return this.parseEscape(events, flushMode);
    }

    // C0 control bytes
    if (c0 === 0x0d || c0 === 0x0a) {
      this.buf = buf.slice(1);
      events.push({ kind: "key", key: "enter", ctrl: false, shift: false, alt: false });
      return true;
    }
    if (c0 === 0x09) {
      this.buf = buf.slice(1);
      events.push({ kind: "key", key: "tab", ctrl: false, shift: false, alt: false });
      return true;
    }
    if (c0 === 0x7f || c0 === 0x08) {
      this.buf = buf.slice(1);
      events.push({ kind: "key", key: "backspace", ctrl: false, shift: false, alt: false });
      return true;
    }
    if (c0 === 0x00) {
      // NUL → ctrl+space / ctrl+@ convention; emit as ctrl+space.
      this.buf = buf.slice(1);
      events.push({ kind: "key", key: " ", char: " ", ctrl: true, shift: false, alt: false });
      return true;
    }
    if (c0 >= 0x01 && c0 <= 0x1a) {
      const ch = String.fromCharCode(c0 + 96); // 0x01→a … 0x1a→z
      this.buf = buf.slice(1);
      events.push({ kind: "key", key: ch, char: ch, ctrl: true, shift: false, alt: false });
      return true;
    }
    if (c0 === 0x1c || c0 === 0x1d || c0 === 0x1e || c0 === 0x1f) {
      // FS/GS/RS/US — ignore
      this.buf = buf.slice(1);
      return true;
    }
    if (c0 < 0x20 || (c0 >= 0x7f && c0 < 0xa0)) {
      // stray C0/C1 — drop
      this.buf = buf.slice(1);
      return true;
    }

    // Printable run: consume until the next ESC or C0 control.
    let end = 0;
    while (end < buf.length) {
      const code = buf.charCodeAt(end);
      if (code === 0x1b || (code < 0x20 && code !== 0x09) || code === 0x7f) break;
      end += 1;
    }
    if (end === 0) {
      // shouldn't happen, but avoid infinite loop
      this.buf = buf.slice(1);
      return true;
    }
    const text = buf.slice(0, end);
    this.buf = buf.slice(end);
    for (const g of graphemes(text)) {
      if (g === " ") {
        events.push({
          kind: "key",
          key: "space",
          char: " ",
          ctrl: false,
          shift: false,
          alt: false,
        });
      } else {
        events.push({ kind: "key", key: g, char: g, ctrl: false, shift: false, alt: false });
      }
    }
    return true;
  }

  private parseEscape(events: KeyEvent[], flushMode: boolean): boolean {
    const buf = this.buf;
    if (buf.length === 1) {
      // Lone trailing ESC: hold for a possible alt-prefix / sequence.
      if (flushMode) {
        this.buf = "";
        events.push({ kind: "key", key: "escape", ctrl: false, shift: false, alt: false });
        return true;
      }
      return false;
    }
    const second = buf.charCodeAt(1);

    // CSI
    if (second === 0x5b) {
      return this.parseCsi(events, flushMode);
    }
    // SS3
    if (second === 0x4f) {
      if (buf.length < 3) return flushMode ? this.flushTruncated(events) : false;
      const third = buf[2] as string;
      this.buf = buf.slice(3);
      const name = SS3_KEYS[third];
      if (name) {
        events.push({ kind: "key", key: name, ctrl: false, shift: false, alt: false });
      } else if (third >= " " && third !== "\x7f") {
        events.push({
          kind: "key",
          key: third,
          char: third,
          ctrl: false,
          shift: false,
          alt: false,
        });
      }
      return true;
    }
    // OSC / DCS / SOS / PM / APC — swallow until terminator.
    if (
      second === 0x5d ||
      second === 0x50 ||
      second === 0x58 ||
      second === 0x5e ||
      second === 0x5f
    ) {
      return this.consumeStringSeq();
    }
    // ESC + char → alt+key (printable or named via same rules)
    return this.parseAlt(events, buf.slice(1));
  }

  private parseAlt(events: KeyEvent[], rest: string): boolean {
    // `rest` begins right after ESC. Parse a single key from it with alt set.
    const c0 = rest.charCodeAt(0);
    if (c0 === 0x0d || c0 === 0x0a) {
      events.push({ kind: "key", key: "enter", ctrl: false, shift: false, alt: true });
      // remaining text continues in buf via caller? We consumed only ESC+CR.
      // But `rest` may hold more — put it back.
      this.buf = rest.slice(1);
      return true;
    }
    if (c0 === 0x09) {
      events.push({ kind: "key", key: "tab", ctrl: false, shift: true, alt: true });
      this.buf = rest.slice(1);
      return true;
    }
    if (c0 === 0x7f || c0 === 0x08) {
      events.push({ kind: "key", key: "backspace", ctrl: false, shift: false, alt: true });
      this.buf = rest.slice(1);
      return true;
    }
    if (c0 >= 0x01 && c0 <= 0x1a) {
      const ch = String.fromCharCode(c0 + 96);
      events.push({ kind: "key", key: ch, char: ch, ctrl: true, shift: false, alt: true });
      this.buf = rest.slice(1);
      return true;
    }
    // printable grapheme cluster
    let end = 0;
    while (end < rest.length) {
      const code = rest.charCodeAt(end);
      if (code === 0x1b || (code < 0x20 && code !== 0x09) || code === 0x7f) break;
      end += 1;
    }
    if (end === 0) {
      // ESC followed by another escape-ish byte: emit escape, reprocess.
      this.buf = rest;
      events.push({ kind: "key", key: "escape", ctrl: false, shift: false, alt: false });
      return true;
    }
    const text = rest.slice(0, end);
    this.buf = rest.slice(end);
    const [g] = graphemes(text);
    if (g !== undefined) {
      const key = g === " " ? "space" : g;
      events.push({
        kind: "key",
        key,
        char: g === " " ? " " : g,
        ctrl: false,
        shift: false,
        alt: true,
      });
    }
    return true;
  }

  /** Parse a CSI sequence: ESC [ params intermediates final. */
  private parseCsi(events: KeyEvent[], flushMode: boolean): boolean {
    const buf = this.buf;
    // Scan from index 2 for the final byte.
    let i = 2;
    let params = "";
    let intermediates = "";
    while (i < buf.length) {
      const code = buf.charCodeAt(i);
      if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) {
        // final byte found
        const finalCh = buf[i] as string;
        const seq = buf.slice(0, i + 1);
        this.buf = buf.slice(i + 1);
        this.handleCsi(params, intermediates, finalCh, seq, events);
        return true;
      }
      if (code >= 0x30 && code <= 0x3f) {
        params += buf[i];
      } else if (code >= 0x20 && code <= 0x2f) {
        intermediates += buf[i];
      } else {
        // malformed — drop the ESC[ and continue with the rest as text
        this.buf = buf.slice(2);
        events.push({ kind: "key", key: "escape", ctrl: false, shift: false, alt: false });
        return true;
      }
      i += 1;
    }
    // No final byte yet.
    if (flushMode) return this.flushTruncated(events);
    return false; // wait for more input
  }

  private handleCsi(
    params: string,
    _intermediates: string,
    finalCh: string,
    _seq: string,
    events: KeyEvent[],
  ): void {
    const paramList = params.split(";").map((p) => {
      if (p === "" || p === "?") return undefined;
      const n = Number.parseInt(p, 10);
      return Number.isNaN(n) ? undefined : n;
    });
    const mods = modsFromParam(paramList[1]);

    // Linux console F1-F5: ESC [ [ A-E — finalCh is "[" handled via seq check
    if (finalCh === "[") {
      // The "[" was consumed as final; the letter arrives as next input.
      // We handle this by peeking — but seq already consumed. Rare enough:
      // emit nothing (the following letter arrives as text). Documented gap.
      return;
    }

    if (finalCh === "~") {
      const code = paramList[0];
      if (code === 200 || code === 201) return; // paste markers (defensive)
      const name = code !== undefined ? TILDE_KEYS[code] : undefined;
      if (name) {
        events.push({ kind: "key", key: name, ctrl: mods.ctrl, shift: mods.shift, alt: mods.alt });
      }
      return;
    }

    if (finalCh === "u") {
      // Kitty keyboard protocol CSI u: code;mods[:event]u
      const code = paramList[0];
      if (code === undefined) return;
      const named = CSI_U_KEYS[code];
      if (named) {
        events.push({ kind: "key", key: named, ctrl: mods.ctrl, shift: mods.shift, alt: mods.alt });
        return;
      }
      if (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        const ch = String.fromCodePoint(code);
        events.push({
          kind: "key",
          key: ch,
          char: ch,
          ctrl: mods.ctrl,
          shift: mods.shift,
          alt: mods.alt,
        });
      }
      return;
    }

    const arrow = ARROW_KEYS[finalCh];
    if (arrow) {
      events.push({ kind: "key", key: arrow, ctrl: mods.ctrl, shift: mods.shift, alt: mods.alt });
      return;
    }
    if (finalCh === "Z") {
      events.push({ kind: "key", key: "tab", ctrl: false, shift: true, alt: false });
      return;
    }
    // Other CSI (e.g. cursor-position reports \x1b[{r};{c}R, DA responses)
    // are terminal replies, not keys — swallow.
  }

  /** Swallow an OSC/DCS/SOS/PM/APC string sequence. */
  private consumeStringSeq(): boolean {
    const buf = this.buf;
    // Find terminator: BEL, ST (ESC \), or 0x9c
    let i = 2;
    while (i < buf.length) {
      const c = buf.charCodeAt(i);
      if (c === 0x07 || c === 0x9c) {
        this.buf = buf.slice(i + 1);
        return true;
      }
      if (c === 0x1b && buf[i + 1] === "\\") {
        this.buf = buf.slice(i + 2);
        return true;
      }
      i += 1;
    }
    // Unterminated: could be a split sequence — wait for more input unless
    // flushing. String sequences can be long (OSC 52 clipboard etc.), so we
    // do keep buffering; bounded by terminal behavior in practice.
    return false;
  }

  private flushTruncated(events: KeyEvent[]): boolean {
    // Incomplete escape sequence at end of input: emit escape and drop the
    // fragment (safer than emitting stray parameter bytes as text).
    const escIdx = this.buf.indexOf("\x1b");
    if (escIdx === -1) {
      this.buf = "";
      return true;
    }
    this.buf = this.buf.slice(escIdx + 1);
    events.push({ kind: "key", key: "escape", ctrl: false, shift: false, alt: false });
    return this.buf.length === 0 ? true : this.parseOne(events, true);
  }
}

const SS3_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

// --- Stream attachment -----------------------------------------------------------

export interface InputHandle {
  /** Detach listeners and restore the terminal (caller owns raw-mode exit). */
  detach(): void;
}

export interface AttachInputOptions {
  /** Defaults to process.stdin/process.stdout. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  onEvent: (ev: KeyEvent) => void;
  /** Called on SIGWINCH / 'resize' events. */
  onResize?: () => void;
  /** Called when stdin ends (EOF). */
  onEof?: () => void;
}

/**
 * Attach raw-mode input to a TTY. Returns a handle whose `detach()` removes
 * listeners; the caller is responsible for `setRawMode(false)` and writing
 * disable sequences — `TuiApp` does both.
 *
 * Escape-key timeout: a lone trailing ESC is flushed as `escape` after
 * `escapeTimeoutMs` of input silence (default 50ms), which keeps Alt+key
 * working for same-chunk sequences while still delivering Escape promptly.
 */
export function attachInput(opts: AttachInputOptions): {
  detach: () => void;
  parser: KeyParser;
} {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const parser = new KeyParser();
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;

  const armEscapeFlush = () => {
    if (escapeTimer !== null) clearTimeout(escapeTimer);
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      for (const ev of parser.flush()) opts.onEvent(ev);
    }, 50);
    if (typeof escapeTimer === "object" && escapeTimer && "unref" in escapeTimer) {
      (escapeTimer as { unref: () => void }).unref();
    }
  };

  const onData = (chunk: Buffer | string) => {
    const events = typeof chunk === "string" ? parser.feed(chunk) : parser.feedBytes(chunk);
    for (const ev of events) opts.onEvent(ev);
    armEscapeFlush();
  };

  const onResize = () => opts.onResize?.();
  const onEnd = () => {
    for (const ev of parser.flush()) opts.onEvent(ev);
    opts.onEof?.();
  };

  input.on("data", onData);
  input.on("end", onEnd);
  if (typeof process !== "undefined" && process.stdin === input) {
    process.on("SIGWINCH", onResize);
  } else {
    input.on("resize", onResize);
  }
  void output;

  return {
    parser,
    detach() {
      if (escapeTimer !== null) clearTimeout(escapeTimer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("resize", onResize);
      if (typeof process !== "undefined" && process.stdin === input) {
        process.off("SIGWINCH", onResize);
      }
    },
  };
}
