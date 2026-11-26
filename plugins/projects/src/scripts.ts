/**
 * Project script definition resolution for rebuildup.projects (#50).
 *
 * Resolution priority (highest wins, mirrors upstream
 * `resolveProjectScripts` in packages/shared/src/projectScripts.ts where
 * applicable):
 *
 *   1. `override`    — per-project settings key `defaultProjectScripts`
 *                      (verbatim string stored by `settings set`).
 *   2. `env-default` — plugin config `<configDir>/config.json` key
 *                      `defaultScripts`.
 *   3. `t3.json`     — `scripts[]` at the repo root.
 *   4. `builtin`     — built-in defaults compiled into the plugin.
 *
 * The first *active* layer supplies the list wholesale. An explicitly
 * empty override/env list is authoritative (resolves to zero scripts);
 * an absent or empty `t3.json` `scripts` array falls through, matching
 * upstream's `project.scripts.length > 0` check. Upstream defines no
 * builtin project-script set, so `BUILTIN_SCRIPTS` is intentionally
 * empty — the layer exists so a future builtin set slots in without a
 * contract change.
 *
 * List entries are either script definition objects (validated like
 * `T3ProjectFileScript`, plus an optional `id`) or bare strings naming a
 * script defined in a lower-priority layer. Names resolve against
 * definition entries of lower layers in priority order, then definitions
 * within the selected layer; an unresolvable name is a structured
 * `unknown_script` error, never a fabricated entry.
 */

import {
  type ProjectScriptIcon,
  parseT3ScriptEntry,
  T3JsonError,
  type T3ProjectFileScript,
} from "./t3json";

export type ScriptSource = "override" | "env-default" | "t3.json" | "builtin";

/** A script definition as accepted from override/env/t3.json layers. */
export interface ScriptDefinition extends T3ProjectFileScript {
  id?: string;
}

/** One entry in a script list: a definition object or a name reference. */
export type ScriptListEntry = ScriptDefinition | string;

/** Fully resolved script emitted by `scripts list`. */
export interface ResolvedScript {
  id: string;
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  runOnSettle: boolean | undefined;
  stopOnSettle: boolean | undefined;
  async: boolean | undefined;
  previewUrl: string | undefined;
  autoOpenPreview: boolean | undefined;
  source: ScriptSource;
}

export type ScriptErrorReason = "invalid_script_list" | "unknown_script";

/** Structured failure while interpreting a script list layer. */
export class ScriptError extends Error {
  readonly reason: ScriptErrorReason;
  /** Which layer failed: "override", "env-default", or a file path. */
  readonly layer: string;
  constructor(reason: ScriptErrorReason, layer: string, message: string) {
    super(message);
    this.name = "ScriptError";
    this.reason = reason;
    this.layer = layer;
  }
}

/** Built-in script defaults. Upstream ships none; kept empty deliberately. */
export const BUILTIN_SCRIPTS: readonly ScriptDefinition[] = [];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scriptListInvalid(layer: string, message: string): ScriptError {
  return new ScriptError("invalid_script_list", layer, `${layer}: ${message}`);
}

/**
 * Normalize a raw layer value into script entries. Accepts a JSON array
 * directly or a string containing a JSON array (settings values are
 * stored verbatim as strings). Throws ScriptError on anything else.
 */
export function parseScriptEntries(raw: unknown, layer: string): ScriptListEntry[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw scriptListInvalid(layer, "is not valid JSON");
    }
  }
  if (!Array.isArray(value)) {
    throw scriptListInvalid(layer, "must be a JSON array of script names or definitions");
  }
  return value.map((entry, i) => {
    const where = `${layer}[${i}]`;
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name.length === 0) throw scriptListInvalid(layer, `${where} must be non-empty`);
      return name;
    }
    if (!isPlainObject(entry)) {
      throw scriptListInvalid(layer, `${where} must be a string or an object`);
    }
    // t3.json schema validation (name/command required, typed optionals);
    // `id` is plugin-side metadata upstream does not define.
    let def: ScriptDefinition;
    try {
      def = parseT3ScriptEntry(entry, layer, where) as ScriptDefinition;
    } catch (err) {
      if (err instanceof T3JsonError) {
        throw scriptListInvalid(layer, err.message.replace(`${layer}: `, ""));
      }
      throw err;
    }
    const id = entry.id;
    if (id !== undefined) {
      if (typeof id !== "string" || id.trim().length === 0) {
        throw scriptListInvalid(layer, `${where}.id must be a non-empty string`);
      }
      def.id = id.trim();
    }
    return def;
  });
}

interface ScriptPool {
  source: ScriptSource;
  /** Present (possibly empty) means this layer is active. */
  entries: ScriptListEntry[] | undefined;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "script";
}

function toResolved(
  def: ScriptDefinition,
  source: ScriptSource,
  usedIds: Set<string>,
): ResolvedScript {
  const base = def.id ?? slugify(def.name);
  let id = base;
  let n = 2;
  while (usedIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  usedIds.add(id);
  const resolved: ResolvedScript = {
    id,
    name: def.name,
    command: def.command,
    icon: def.icon ?? "play",
    runOnWorktreeCreate: def.runOnWorktreeCreate ?? false,
    runOnSettle: def.runOnSettle,
    stopOnSettle: def.stopOnSettle,
    async: def.async,
    previewUrl: def.previewUrl,
    autoOpenPreview: def.autoOpenPreview,
    source,
  };
  return resolved;
}

export interface ScriptLayers {
  /** Raw `defaultProjectScripts` settings string, undefined when unset. */
  override?: unknown;
  /** Raw `defaultScripts` plugin config value, undefined when unset. */
  envDefault?: unknown;
  /** Scripts parsed from the target repo's t3.json, undefined when absent/empty. */
  t3Scripts?: readonly T3ProjectFileScript[] | undefined;
  /** Built-in definitions (BUILTIN_SCRIPTS; injectable for tests). */
  builtin?: readonly ScriptDefinition[] | undefined;
}

/**
 * Resolve the effective script list for a target. Throws ScriptError
 * (`invalid_script_list` / `unknown_script`) on malformed layers or
 * unresolvable name references.
 */
export function resolveScripts(layers: ScriptLayers): ResolvedScript[] {
  const pools: ScriptPool[] = [
    {
      source: "override",
      entries:
        layers.override === undefined
          ? undefined
          : parseScriptEntries(layers.override, "override.defaultProjectScripts"),
    },
    {
      source: "env-default",
      entries:
        layers.envDefault === undefined
          ? undefined
          : parseScriptEntries(layers.envDefault, "env.defaultScripts"),
    },
    {
      source: "t3.json",
      entries:
        layers.t3Scripts === undefined || layers.t3Scripts.length === 0
          ? undefined
          : layers.t3Scripts.map((s) => ({ ...s })),
    },
    {
      source: "builtin",
      entries:
        layers.builtin === undefined || layers.builtin.length === 0
          ? undefined
          : layers.builtin.map((s) => ({ ...s })),
    },
  ];

  const selected = pools.findIndex((p) => p.entries !== undefined);
  if (selected === -1) return [];
  const pool = pools[selected] as ScriptPool;
  const entries = pool.entries as ScriptListEntry[];

  // Name-reference candidates: definitions from lower-priority layers in
  // order, then definitions inside the selected layer itself. `source`
  // records which layer defined the script (provenance of the definition,
  // not of the reference).
  const candidates: { name: string; def: ScriptDefinition; source: ScriptSource }[] = [];
  for (const lower of pools.slice(selected + 1)) {
    for (const entry of lower.entries ?? []) {
      if (typeof entry !== "string") {
        candidates.push({ name: entry.name, def: entry, source: lower.source });
      }
    }
  }
  for (const entry of entries) {
    if (typeof entry !== "string") {
      candidates.push({ name: entry.name, def: entry, source: pool.source });
    }
  }

  const usedIds = new Set<string>();
  const resolved: ResolvedScript[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const match = candidates.find((c) => c.name === entry);
      if (!match) {
        throw new ScriptError(
          "unknown_script",
          pool.source,
          `${pool.source}: no script named "${entry}" in lower-priority layers`,
        );
      }
      resolved.push(toResolved(match.def, match.source, usedIds));
      continue;
    }
    resolved.push(toResolved(entry, pool.source, usedIds));
  }
  return resolved;
}
