/**
 * Loader for the upstream T3 Code project file (`t3.json` at a repository
 * root). Mirrors the field semantics of upstream
 * `packages/contracts/src/t3ProjectFile.ts`: the plugin reads the subset
 * it needs, ignores unknown keys (forward compatibility), and rejects
 * malformed JSON or schema violations with a structured T3JsonError.
 *
 * Field notes (upstream parity):
 * - `name`/`command`/`iconPath`/`worktreeSparsePatternsPath`/`previewUrl`
 *   are trimmed and must be non-empty when present.
 * - `iconPath` and `worktreeSparsePatternsPath` are capped at 512 chars.
 * - `scripts` is capped at 50 entries.
 * - Optional boolean/enum fields keep upstream defaults downstream
 *   (icon "play", runOnWorktreeCreate false); the loader preserves only
 *   what the file declares.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const T3_PROJECT_FILE_NAME = "t3.json";
export const T3_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";
export const T3_PROJECT_FILE_PATH_MAX_LENGTH = 512;
export const T3_PROJECT_FILE_MAX_SCRIPTS = 50;

/** Upstream `ProjectScriptIcon` literals (packages/contracts/src/project.ts). */
export const PROJECT_SCRIPT_ICONS = [
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
] as const;
export type ProjectScriptIcon = (typeof PROJECT_SCRIPT_ICONS)[number];

/** Upstream `ThreadEnvMode` literals (packages/contracts/src/environment.ts). */
export const THREAD_ENV_MODES = ["local", "worktree"] as const;
export type ThreadEnvMode = (typeof THREAD_ENV_MODES)[number];

/** Upstream `WorktreeSubmodules` literals (packages/contracts/src/environment.ts). */
export const WORKTREE_SUBMODULES = ["recursive", "top-level", "none"] as const;
export type WorktreeSubmodules = (typeof WORKTREE_SUBMODULES)[number];

export interface T3ProjectFileScript {
  name: string;
  command: string;
  icon?: ProjectScriptIcon;
  runOnWorktreeCreate?: boolean;
  runOnSettle?: boolean;
  stopOnSettle?: boolean;
  async?: boolean;
  previewUrl?: string;
  autoOpenPreview?: boolean;
}

export interface T3ProjectFile {
  $schema?: string;
  iconPath?: string;
  defaultThreadEnvMode?: ThreadEnvMode;
  worktreeSubmodules?: WorktreeSubmodules;
  worktreeSparsePatternsPath?: string;
  scripts?: T3ProjectFileScript[];
}

export type T3JsonErrorReason = "invalid_json" | "invalid_schema";

/** Structured failure for a present-but-unusable t3.json. */
export class T3JsonError extends Error {
  readonly reason: T3JsonErrorReason;
  /** Absolute path of the offending file. */
  readonly file: string;
  constructor(reason: T3JsonErrorReason, file: string, message: string) {
    super(message);
    this.name = "T3JsonError";
    this.reason = reason;
    this.file = file;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(file: string, where: string, message: string): T3JsonError {
  return new T3JsonError("invalid_schema", file, `${file}: ${where}: ${message}`);
}

/** Trimmed non-empty string; undefined when the key is absent. */
function optTrimmedString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  where: string,
  maxLength?: number,
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalid(file, `${where}.${key}`, "must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw invalid(file, `${where}.${key}`, "must be a non-empty string");
  }
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw invalid(file, `${where}.${key}`, `must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function optBoolean(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  where: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalid(file, `${where}.${key}`, "must be a boolean");
  }
  return value;
}

function optEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  file: string,
  where: string,
): T | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(file, `${where}.${key}`, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Validate one script object into the upstream `T3ProjectFileScript`
 * shape. Unknown keys are ignored. Shared by the file loader and the
 * settings/config script-list parser (which additionally allows `id`).
 */
export function parseT3ScriptEntry(
  value: unknown,
  file: string,
  where: string,
): T3ProjectFileScript {
  if (!isPlainObject(value)) {
    throw invalid(file, where, "must be an object");
  }
  const name = optTrimmedString(value, "name", file, where);
  const command = optTrimmedString(value, "command", file, where);
  if (name === undefined) throw invalid(file, `${where}.name`, "is required");
  if (command === undefined) throw invalid(file, `${where}.command`, "is required");
  const script: T3ProjectFileScript = { name, command };
  const icon = optEnum(value, "icon", PROJECT_SCRIPT_ICONS, file, where);
  if (icon !== undefined) script.icon = icon;
  for (const key of [
    "runOnWorktreeCreate",
    "runOnSettle",
    "stopOnSettle",
    "async",
    "autoOpenPreview",
  ] as const) {
    const flag = optBoolean(value, key, file, where);
    if (flag !== undefined) script[key] = flag;
  }
  const previewUrl = optTrimmedString(value, "previewUrl", file, where);
  if (previewUrl !== undefined) script.previewUrl = previewUrl;
  return script;
}

/** Parse an already-decoded JSON value into a T3ProjectFile. */
export function parseT3ProjectFile(value: unknown, file: string): T3ProjectFile {
  if (!isPlainObject(value)) {
    throw invalid(file, "(root)", "must be a JSON object");
  }
  const result: T3ProjectFile = {};
  const schema = optTrimmedString(value, "$schema", file, "(root)");
  if (schema !== undefined) result.$schema = schema;
  const iconPath = optTrimmedString(
    value,
    "iconPath",
    file,
    "(root)",
    T3_PROJECT_FILE_PATH_MAX_LENGTH,
  );
  if (iconPath !== undefined) result.iconPath = iconPath;
  const envMode = optEnum(value, "defaultThreadEnvMode", THREAD_ENV_MODES, file, "(root)");
  if (envMode !== undefined) result.defaultThreadEnvMode = envMode;
  const submodules = optEnum(value, "worktreeSubmodules", WORKTREE_SUBMODULES, file, "(root)");
  if (submodules !== undefined) result.worktreeSubmodules = submodules;
  const sparse = optTrimmedString(
    value,
    "worktreeSparsePatternsPath",
    file,
    "(root)",
    T3_PROJECT_FILE_PATH_MAX_LENGTH,
  );
  if (sparse !== undefined) result.worktreeSparsePatternsPath = sparse;

  const rawScripts = value.scripts;
  if (rawScripts !== undefined) {
    if (!Array.isArray(rawScripts)) {
      throw invalid(file, "scripts", "must be an array");
    }
    if (rawScripts.length > T3_PROJECT_FILE_MAX_SCRIPTS) {
      throw invalid(file, "scripts", `must contain at most ${T3_PROJECT_FILE_MAX_SCRIPTS} entries`);
    }
    result.scripts = rawScripts.map((entry, i) => parseT3ScriptEntry(entry, file, `scripts[${i}]`));
  }
  return result;
}

/**
 * Read and parse `<root>/t3.json`. Returns null when the file does not
 * exist; throws T3JsonError for malformed JSON or schema violations and
 * rethrows filesystem errors (permissions, etc.).
 */
export async function loadT3ProjectFile(root: string): Promise<T3ProjectFile | null> {
  const file = path.join(root, T3_PROJECT_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new T3JsonError("invalid_json", file, `${file}: invalid JSON`);
  }
  return parseT3ProjectFile(decoded, file);
}
