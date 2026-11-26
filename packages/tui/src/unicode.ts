/**
 * Unicode display-width handling for `packages/tui` (zero-dependency).
 *
 * Width model — a documented approximation of wcwidth, NOT a full
 * implementation:
 * - Grapheme clusters are segmented with `Intl.Segmenter` so combining
 *   marks, ZWJ emoji sequences, and regional indicators count as one unit.
 * - A cluster's width is the maximum per-codepoint width inside it, with
 *   two refinements: clusters containing U+FE0F (emoji presentation
 *   selector) or a codepoint in the emoji/wide ranges count as 2; clusters
 *   made only of zero-width codepoints count as 0.
 * - East-Asian "ambiguous" codepoints count as 1 (the narrow reading).
 *   Terminals that render them wide will see one column of drift at the
 *   line edge; acceptable for a shared minimal core.
 *
 * All line layout (truncate/pad) goes through these helpers so no component
 * has to reimplement width math.
 */

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Split `text` into grapheme clusters. */
export function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

/** Zero-width / combining ranges (general approximation of wcwidth==0). */
function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200b || // zero-width space
    cp === 0x200d || // ZWJ
    cp === 0xfeff || // BOM / ZWNBSP
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) || // hebrew points
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) || // arabic vowel marks
    (cp >= 0x0670 && cp <= 0x0670) ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x0e31 && cp <= 0x0e3a) || // thai marks
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x20d0 && cp <= 0x20f0) || // combining marks for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors (incl. FE0F)
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x101fd && cp <= 0x101fd) ||
    (cp >= 0x102e0 && cp <= 0x102e0) ||
    (cp >= 0x10376 && cp <= 0x1037a) ||
    (cp >= 0x10a01 && cp <= 0x10a03) ||
    (cp >= 0x10a05 && cp <= 0x10a06) ||
    (cp >= 0x10a0c && cp <= 0x10a0f) ||
    (cp >= 0x10a38 && cp <= 0x10a3a) ||
    (cp >= 0x10a3f && cp <= 0x10a3f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors suppl.
  );
}

/** Wide / fullwidth ranges (wcwidth==2). Includes CJK and emoji blocks. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // hangul jamo
    (cp >= 0x231a && cp <= 0x231b) || // watch/hourglass emoji
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    (cp >= 0x23f0 && cp <= 0x23f0) ||
    (cp >= 0x23f3 && cp <= 0x23f3) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) || // zodiac
    (cp >= 0x267f && cp <= 0x267f) ||
    (cp >= 0x2693 && cp <= 0x2693) ||
    (cp >= 0x26a1 && cp <= 0x26a1) ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    (cp >= 0x26ce && cp <= 0x26ce) ||
    (cp >= 0x26d4 && cp <= 0x26d4) ||
    (cp >= 0x26ea && cp <= 0x26ea) ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    (cp >= 0x26f5 && cp <= 0x26f5) ||
    (cp >= 0x26fa && cp <= 0x26fa) ||
    (cp >= 0x26fd && cp <= 0x26fd) ||
    (cp >= 0x2705 && cp <= 0x2705) ||
    (cp >= 0x270a && cp <= 0x270b) ||
    (cp >= 0x2728 && cp <= 0x2728) ||
    (cp >= 0x274c && cp <= 0x274c) ||
    (cp >= 0x274e && cp <= 0x274e) ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    (cp >= 0x2757 && cp <= 0x2757) ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    (cp >= 0x27b0 && cp <= 0x27b0) ||
    (cp >= 0x27bf && cp <= 0x27bf) ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    (cp >= 0x2b50 && cp <= 0x2b50) ||
    (cp >= 0x2b55 && cp <= 0x2b55) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x16fe4) ||
    (cp >= 0x17000 && cp <= 0x187f7) ||
    (cp >= 0x18800 && cp <= 0x18cd5) ||
    (cp >= 0x1b000 && cp <= 0x1b152) ||
    (cp >= 0x1b170 && cp <= 0x1b2fb) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) || // regional indicators (flags)
    (cp >= 0x1f004 && cp <= 0x1f004) ||
    (cp >= 0x1f0cf && cp <= 0x1f0cf) ||
    (cp >= 0x1f18e && cp <= 0x1f18e) ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f202) ||
    (cp >= 0x1f210 && cp <= 0x1f23b) ||
    (cp >= 0x1f240 && cp <= 0x1f248) ||
    (cp >= 0x1f250 && cp <= 0x1f251) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

function codePointWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidth(cp)) return 0;
  if (isWide(cp)) return 2;
  return 1;
}

/** Display width of one grapheme cluster. */
function clusterWidth(cluster: string): number {
  let w = 0;
  let hasWide = false;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0) ?? 0;
    const cw = codePointWidth(cp);
    if (cw === 2) hasWide = true;
    if (cw > w) w = cw;
  }
  // ZWJ emoji sequences (e.g. family emoji) segment as one cluster whose
  // members are wide anyway; a cluster containing FE0F should be wide even
  // if its base is ambiguous-width.
  if (!hasWide && cluster.includes("\ufe0f")) {
    for (const ch of cluster) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp >= 0x1f000) return 2;
    }
  }
  return w;
}

/** Total display width of `text` in terminal cells. */
export function displayWidth(text: string): number {
  let w = 0;
  for (const g of graphemes(text)) w += clusterWidth(g);
  return w;
}

/**
 * Truncate `text` to at most `maxWidth` cells. Never splits a grapheme
 * cluster and never leaves a dangling wide char in the last column (a wide
 * char that would straddle the boundary is dropped entirely).
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  let out = "";
  let w = 0;
  for (const g of graphemes(text)) {
    const gw = clusterWidth(g);
    if (w + gw > maxWidth) break;
    out += g;
    w += gw;
  }
  return out;
}

/** Truncate and append an ellipsis `…` (or `...` when `ascii`) if cut. */
export function ellipsize(text: string, maxWidth: number, ascii = false): string {
  if (displayWidth(text) <= maxWidth) return text;
  const mark = ascii ? "..." : "…";
  const mw = displayWidth(mark);
  if (maxWidth <= mw) return truncateToWidth(mark, maxWidth);
  const body = truncateToWidth(text, maxWidth - mw).replace(/\s+$/, "");
  return `${body}${mark}`;
}

/** Pad `text` with spaces on the right to exactly `width` cells. */
export function padEndWidth(text: string, width: number): string {
  const w = displayWidth(text);
  if (w >= width) return text;
  return text + " ".repeat(width - w);
}

/** Pad `text` with spaces on the left to exactly `width` cells. */
export function padStartWidth(text: string, width: number): string {
  const w = displayWidth(text);
  if (w >= width) return text;
  return " ".repeat(width - w) + text;
}

/** Center `text` within `width` cells (truncated first if needed). */
export function centerWidth(text: string, width: number): string {
  const t = truncateToWidth(text, width);
  const w = displayWidth(t);
  const left = Math.max(0, Math.floor((width - w) / 2));
  return " ".repeat(left) + t + " ".repeat(Math.max(0, width - w - left));
}

/**
 * Word-wrap `text` to `width` cells, returning lines of at most `width`.
 * Long unbreakable runs are hard-split on grapheme boundaries. Explicit
 * newlines in `text` are preserved.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const hard of text.split("\n")) {
    let line = "";
    let lineW = 0;
    for (const word of hard.split(/(\s+)/)) {
      if (word === "") continue;
      const ww = displayWidth(word);
      if (lineW > 0 && lineW + ww > width) {
        out.push(line.replace(/\s+$/, ""));
        line = "";
        lineW = 0;
      }
      if (ww > width) {
        // hard-split the long word
        if (lineW > 0) {
          out.push(line.replace(/\s+$/, ""));
          line = "";
          lineW = 0;
        }
        let chunk = "";
        let cw = 0;
        for (const g of graphemes(word)) {
          const gw = clusterWidth(g);
          if (cw + gw > width) {
            out.push(chunk);
            chunk = "";
            cw = 0;
          }
          chunk += g;
          cw += gw;
        }
        if (chunk) {
          line = chunk;
          lineW = cw;
        }
        continue;
      }
      line += word;
      lineW += ww;
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}
