/**
 * Input boundary for rebuildup.textgen (Issue #107 / ADR boundary rules).
 *
 * A task input is a strict allowlist of named fields. Unknown keys are
 * rejected, required fields must be non-empty strings, every string is
 * length-capped, and a credential-pattern scan fails closed before any
 * bytes reach a provider. Secret material is never sent to a generator:
 * the scan reports field paths and pattern names only — never the
 * matched value.
 */

import { type TaskSpec, TextgenError } from "./model";

export interface TextgenLimits {
  maxInputChars: number;
}

export const DEFAULT_LIMITS: TextgenLimits = {
  maxInputChars: 200_000,
};

/**
 * High-confidence credential patterns. Deliberately narrow: diffs and
 * conventions legitimately contain the words "token"/"key", so only
 * shapes that are almost certainly live secrets trigger the guard.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "pem_private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "openai_style_key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws_access_key_id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/ },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a raw JSON payload against the task's input contract.
 * Returns a normalized record containing only allowed fields.
 */
export function validateTaskInput(
  spec: TaskSpec,
  raw: unknown,
  limits: TextgenLimits = DEFAULT_LIMITS,
): Record<string, string | number> {
  if (!isRecord(raw)) {
    throw new TextgenError("input_invalid", "bad_request", "task input must be a JSON object");
  }

  const allowed = new Set(spec.inputFields);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new TextgenError(
      "input_unknown_field",
      "bad_request",
      `input contains fields not allowed for task ${spec.kind}`,
      { fields: unknown.sort(), allowed: [...spec.inputFields].sort() },
    );
  }

  const normalized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value) && key === "candidates") {
      normalized[key] = Math.floor(value);
    } else {
      throw new TextgenError(
        "input_invalid",
        "bad_request",
        `input field "${key}" must be a string${key === "candidates" ? " or number" : ""}`,
        { field: key },
      );
    }
  }

  for (const key of spec.requiredInput) {
    const value = normalized[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new TextgenError(
        "input_missing_field",
        "bad_request",
        `task ${spec.kind} requires non-empty input field "${key}"`,
        { field: key },
      );
    }
  }

  // Optional fields may be omitted but must be non-empty when present.
  for (const key of spec.inputFields) {
    if (spec.requiredInput.includes(key)) continue;
    const value = normalized[key];
    if (typeof value === "string" && value.trim() === "") {
      delete normalized[key];
    }
  }

  // Total payload cap before the secret scan (bounds scan cost too).
  const totalChars = Object.values(normalized).reduce<number>(
    (sum, v) => sum + String(v).length,
    0,
  );
  if (totalChars > limits.maxInputChars) {
    throw new TextgenError(
      "input_too_large",
      "bad_request",
      `task input exceeds maxInputChars (${limits.maxInputChars})`,
      { chars: totalChars, max: limits.maxInputChars },
    );
  }

  // Credential guard: fail closed, report locations only.
  const hits: { field: string; pattern: string }[] = [];
  for (const [key, value] of Object.entries(normalized)) {
    const text = String(value);
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ field: key, pattern: name });
    }
  }
  if (hits.length > 0) {
    throw new TextgenError(
      "input_secret_detected",
      "policy",
      "input contains credential-shaped material; refusing to send it to a generator",
      {
        fields: [...new Set(hits.map((h) => h.field))].sort(),
        patterns: [...new Set(hits.map((h) => h.pattern))].sort(),
      },
    );
  }

  return normalized;
}

/** Parse a JSON payload from text; structured error on failure. */
export function parseInputJson(text: string, spec: TaskSpec): Record<string, unknown> {
  if (text.trim() === "") {
    throw new TextgenError(
      "input_required",
      "bad_request",
      `task ${spec.kind} requires a JSON input payload on stdin or --input`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new TextgenError(
      "input_invalid",
      "bad_request",
      `input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
