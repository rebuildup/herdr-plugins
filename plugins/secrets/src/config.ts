/**
 * rebuildup.secrets config — `config.json` under the herdr-provided
 * plugin config dir (`HERDR_PLUGIN_CONFIG_DIR` / pluginDirs resolution).
 *
 * The config holds *declarations only*: the Infisical domain/project and
 * named bindings `{name, env, ref}`. It never holds secret values, tokens,
 * or service credentials (ADR-0027 §2/§3; AGENTS §4).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import {
  type Binding,
  CANONICAL_INFISICAL_DOMAIN,
  PLUGIN_ID,
  SecretsError,
  validateBinding,
} from "./model";

export interface SecretsConfig {
  infisical: {
    /** API base URL; canonical default is the self-hosted control plane. */
    domain: string;
    /** Default Infisical project id; per-binding `projectId` overrides. */
    projectId?: string;
    /** Optional env var name the CLI should read a token from. Unset = CLI's own auth. */
    tokenEnv?: string;
  };
  bindings: Binding[];
}

export interface LoadedConfig {
  config: SecretsConfig;
  /** Binding names that failed validation (reported, never fatal alone). */
  invalidBindings: Array<{ name: string; error: string }>;
  warnings: string[];
}

export function configFilePath(configDir?: string): string {
  return path.join(configDir ?? pluginDirs(PLUGIN_ID).configDir, "config.json");
}

const EMPTY: SecretsConfig = {
  infisical: { domain: CANONICAL_INFISICAL_DOMAIN },
  bindings: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load and validate config.json. Missing file → empty config (no
 * bindings). Malformed JSON or wrong top-level shape → SecretsError
 * (`config_error`); individual bad bindings are collected as warnings
 * so one typo does not hide the rest.
 */
export async function loadConfig(configDir?: string): Promise<LoadedConfig> {
  const file = configFilePath(configDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: structuredClone(EMPTY), invalidBindings: [], warnings: [] };
    }
    throw new SecretsError(
      `cannot read config ${file}: ${err instanceof Error ? err.message : String(err)}`,
      "error",
      "config_error",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SecretsError(
      `config ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "error",
      "config_error",
    );
  }
  if (!isRecord(parsed)) {
    throw new SecretsError(`config ${file} must contain a JSON object`, "error", "config_error");
  }

  const warnings: string[] = [];
  const infisicalRaw = isRecord(parsed.infisical) ? parsed.infisical : {};
  const domain =
    typeof infisicalRaw.domain === "string" && infisicalRaw.domain !== ""
      ? infisicalRaw.domain
      : CANONICAL_INFISICAL_DOMAIN;
  if (typeof infisicalRaw.domain !== "string" || infisicalRaw.domain === "") {
    warnings.push(
      "infisical.domain unset; using canonical default https://secrets.rebuildup.dev/api",
    );
  }
  if (domain === "https://app.infisical.com/api" || domain === "https://app.infisical.com") {
    warnings.push(
      "infisical.domain points at Infisical managed Cloud; the canonical profile is the self-hosted instance (secrets-management skill §5)",
    );
  }

  const config: SecretsConfig = {
    infisical: { domain },
    bindings: [],
  };
  if (typeof infisicalRaw.projectId === "string" && infisicalRaw.projectId !== "") {
    config.infisical.projectId = infisicalRaw.projectId;
  }
  if (typeof infisicalRaw.tokenEnv === "string" && infisicalRaw.tokenEnv !== "") {
    config.infisical.tokenEnv = infisicalRaw.tokenEnv;
  }

  const invalidBindings: LoadedConfig["invalidBindings"] = [];
  const bindingsRaw = Array.isArray(parsed.bindings) ? parsed.bindings : [];
  if (parsed.bindings !== undefined && !Array.isArray(parsed.bindings)) {
    warnings.push("config.bindings is not an array; ignored");
  }
  const seenNames = new Set<string>();
  const seenEnv = new Map<string, string>();
  for (const rawBinding of bindingsRaw) {
    const result = validateBinding(rawBinding);
    if (!result.ok) {
      invalidBindings.push({ name: result.name, error: result.error });
      continue;
    }
    const { binding } = result;
    if (seenNames.has(binding.name)) {
      invalidBindings.push({ name: binding.name, error: "duplicate binding name" });
      continue;
    }
    seenNames.add(binding.name);
    const other = seenEnv.get(binding.env);
    if (other !== undefined) {
      invalidBindings.push({
        name: binding.name,
        error: `env name ${binding.env} already used by binding ${other}`,
      });
      continue;
    }
    seenEnv.set(binding.env, binding.name);
    config.bindings.push(binding);
  }

  return { config, invalidBindings, warnings };
}

/**
 * Write a starter config.json (no bindings, canonical domain). Refuses to
 * overwrite an existing file — bindings are user declarations and must
 * never be silently replaced.
 */
export async function writeInitialConfig(configDir?: string): Promise<string> {
  const dir = configDir ?? pluginDirs(PLUGIN_ID).configDir;
  const file = path.join(dir, "config.json");
  const initial: SecretsConfig = structuredClone(EMPTY);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(initial, null, 2)}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SecretsError(`config already exists: ${file}`, "error", "config_error");
    }
    throw err;
  }
  return file;
}
