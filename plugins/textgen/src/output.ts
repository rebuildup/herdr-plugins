/**
 * Output validation for rebuildup.textgen (Issue #107).
 *
 * Provider output is untrusted: it is extracted, normalized, and checked
 * against the task's output contract before it is returned. Empty output,
 * runaway length, control characters, and stray code fences are rejected
 * with structured errors — never silently repaired into a different
 * meaning.
 */

import {
  type GenerationResult,
  type OutputShape,
  type PrContentResult,
  type TaskSpec,
  TextgenError,
} from "./model";

/** True when the string contains C0 control chars other than \n and \t, or DEL. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x09) continue; // \n, \t are legitimate
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const FENCE_RE = /^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/;

function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new TextgenError(code, "invalid_output", message, details);
}

/** Strip a single wrapping code fence; report whether one was removed. */
function unwrapFence(text: string): { text: string; unwrapped: boolean } {
  const match = FENCE_RE.exec(text.trim());
  if (match === null) return { text, unwrapped: false };
  return { text: (match[1] ?? "").trim(), unwrapped: true };
}

function checkClean(text: string, spec: TaskSpec, label: string): string {
  if (hasControlChars(text)) {
    fail("output_control_chars", `${label} contains control characters`, {
      task: spec.kind,
    });
  }
  if (text.length > spec.maxOutputChars) {
    fail("output_too_long", `${label} exceeds maxOutputChars (${spec.maxOutputChars})`, {
      task: spec.kind,
      chars: text.length,
      max: spec.maxOutputChars,
    });
  }
  return text;
}

/** Locate the first balanced block; returns the block and its end offset. */
function extractFirstBalancedBlock(
  text: string,
  opener: "{" | "[",
  closer: "}" | "]",
): { text: string; end: number } | null {
  const start = text.indexOf(opener);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Escape raw `\n`/`\r`/`\t` that appear inside JSON string literals.
 * Characters outside strings (legal JSON whitespace) are untouched.
 */
function escapeRawControlsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Parse provider JSON output (Issue #186 / #132).
 *
 * Strict `JSON.parse` runs first and is unchanged; only on its failure
 * do we apply a conservative second chance:
 *
 * 1. extract the FIRST balanced `{...}`/`[...]` block, scanning with
 *    string-literal and escape awareness (never guessing at missing or
 *    extra structure),
 * 2. require the block to be followed by whitespace only — trailing
 *    content such as a second JSON value stays an error,
 * 3. escape raw control characters (`\n`, `\r`, `\t`) that appear INSIDE
 *    JSON string literals only — whitespace between tokens is already
 *    legal JSON and is untouched,
 * 4. re-parse strictly.
 *
 * Anything still unparseable — truncated JSON, unbalanced braces,
 * multiple top-level values, non-JSON prose — fails with the same
 * `output_invalid_json` error as before. This is additive tolerance
 * under contract `herdr-plugins.textgen/v1`: the accepted result shape
 * and error taxonomy are unchanged.
 */
function parseJsonOutput(
  text: string,
  opener: "{" | "[",
  closer: "}" | "]",
  task: TaskSpec,
): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to tolerant path
  }
  const block = extractFirstBalancedBlock(text, opener, closer);
  if (block === null || text.slice(block.end).trim() !== "") {
    fail("output_invalid_json", `task ${task.kind} output is not valid JSON`);
  }
  try {
    return JSON.parse(escapeRawControlsInStrings(block.text));
  } catch {
    fail("output_invalid_json", `task ${task.kind} output is not valid JSON`);
  }
}

function validateText(spec: TaskSpec, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") fail("output_empty", `task ${spec.kind} produced empty output`);
  const { text, unwrapped } = unwrapFence(trimmed);
  if (text.trim() === "") fail("output_empty", `task ${spec.kind} produced empty output`);
  // A single wrapping fence is a common model habit and is normalized;
  // interior fences mean the model emitted structure we did not ask for.
  if (!unwrapped && text.includes("```")) {
    fail("output_unexpected_fence", `task ${spec.kind} output contains a code fence`, {
      task: spec.kind,
    });
  }
  return checkClean(text.trim(), spec, "output");
}

function validateTextList(spec: TaskSpec, raw: string, requested: number): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") fail("output_empty", `task ${spec.kind} produced empty output`);

  let candidates: string[];
  const jsonStart = trimmed.startsWith("[");
  if (jsonStart) {
    const parsed = parseJsonOutput(trimmed, "[", "]", spec);
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
      fail("output_invalid_json", `task ${spec.kind} list output must be a JSON string array`);
    }
    candidates = (parsed as string[]).map((v) => v.trim());
  } else {
    // Plain-text convention: candidates separated by a line containing
    // only "---" (mirrors the prompt instruction).
    candidates = trimmed
      .split(/\n\s*---\s*\n/)
      .map((v) => v.trim())
      .filter((v) => v !== "");
  }

  if (candidates.length === 0) {
    fail("output_empty", `task ${spec.kind} produced no candidates`);
  }
  const cap = Math.min(spec.maxListItems, Math.max(1, requested));
  if (candidates.length > cap) {
    candidates = candidates.slice(0, cap);
  }
  return candidates.map((c, i) => {
    if (c.includes("```")) {
      fail("output_unexpected_fence", `candidate ${i + 1} contains a code fence`, {
        task: spec.kind,
        index: i,
      });
    }
    return checkClean(c, spec, `candidate ${i + 1}`);
  });
}

function validatePrContent(spec: TaskSpec, raw: string): PrContentResult {
  const trimmed = raw.trim();
  if (trimmed === "") fail("output_empty", `task ${spec.kind} produced empty output`);

  let title: string | null = null;
  let body: string | null = null;

  const unfenced = unwrapFence(trimmed);
  const candidate = unfenced.text.trim();
  if (candidate.startsWith("{")) {
    const parsed = parseJsonOutput(candidate, "{", "}", spec);
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.title === "string" && typeof obj.body === "string") {
      title = obj.title.trim();
      body = obj.body.trim();
    } else {
      fail("output_invalid_json", `task ${spec.kind} PR content needs {title, body} strings`);
    }
  }
  if (title === null || body === null) {
    // Fallback: first non-empty line is the title, remainder is the body.
    // Only used when the provider ignored the JSON instruction; the shape
    // is still validated identically.
    const lines = candidate.split("\n");
    const firstIdx = lines.findIndex((l) => l.trim() !== "");
    if (firstIdx === -1) fail("output_empty", `task ${spec.kind} produced empty output`);
    title = (lines[firstIdx] ?? "").trim();
    body = lines
      .slice(firstIdx + 1)
      .join("\n")
      .trim();
    if (title.startsWith("#")) title = title.replace(/^#+\s*/, "").trim();
  }

  if (title === "" || body === "") {
    fail("output_empty", `task ${spec.kind} produced an empty title or body`);
  }
  if (title.length > 300) {
    fail("output_too_long", "PR title exceeds 300 chars", { task: spec.kind });
  }
  if (hasControlChars(title) || hasControlChars(body)) {
    fail("output_control_chars", "PR content contains control characters", {
      task: spec.kind,
    });
  }
  if (body.length > spec.maxOutputChars) {
    fail("output_too_long", `PR body exceeds maxOutputChars (${spec.maxOutputChars})`, {
      task: spec.kind,
      chars: body.length,
      max: spec.maxOutputChars,
    });
  }
  return { title, body };
}

/**
 * Validate raw provider text against the task output contract and return
 * the typed result. `requestedCandidates` comes from task input
 * (`candidates`) and only affects list truncation.
 */
export function validateGeneratedOutput(
  spec: TaskSpec,
  raw: string,
  requestedCandidates = 3,
): GenerationResult {
  const shape: OutputShape = spec.output;
  if (shape === "text") return validateText(spec, raw);
  if (shape === "text_list") return validateTextList(spec, raw, requestedCandidates);
  return validatePrContent(spec, raw);
}

// Marker lines may carry terminal decorations: agent TUIs indent replies
// and prefix them with bullets (`• `, `> `, `- `). Leading decoration is
// allowed; anything else before a marker (e.g. the model quoting the
// instruction mid-sentence) disqualifies the match.
const MARKER_PREFIX = "[ \\t>*•\\-–—]*";
const MARKER_BLOCK_RE = new RegExp(
  `(?:^|\\n)${MARKER_PREFIX}<<<TEXTGEN_RESULT>>>[ \\t]*\\r?\\n` +
    `([\\s\\S]*?)\\r?\\n?${MARKER_PREFIX}<<<TEXTGEN_END>>>[ \\t]*(?=\\n|$)`,
  "g",
);

/** Strip the common leading indentation shared by non-empty lines. */
function dedentBlock(text: string): string {
  const lines = text.split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent < min) min = indent;
  }
  if (!Number.isFinite(min) || min === 0) return text;
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(min))).join("\n");
}

/**
 * Extract the marked region from agent-pane terminal text. The agent
 * prompt instructs the model to wrap its answer in TEXTGEN markers on
 * their own lines; scrollback noise (prompt echo, TUI chrome, and the
 * model *quoting* the marker instruction inline) is discarded by
 * requiring line-anchored markers and taking the LAST marker block.
 * Returns null when markers are absent — callers decide whether an
 * unmarked fallback is acceptable (never for v1: agents must comply or
 * the generation fails honestly).
 */
export function extractMarkedResult(text: string): string | null {
  let result: string | null = null;
  for (const match of text.matchAll(MARKER_BLOCK_RE)) {
    result = dedentBlock(match[1] ?? "");
  }
  return result;
}
