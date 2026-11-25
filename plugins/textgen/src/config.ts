/**
 * Plugin configuration for rebuildup.textgen (Issue #107, ADR-0018).
 *
 * `config.json` lives under `HERDR_PLUGIN_CONFIG_DIR` (herdr-provided
 * plugin dir). It may hold endpoints, model names, provider ids, and
 * *names* of credential environment variables — never credential values.
 * API keys resolve per invocation from the named env var or an optional
 * key file under `<configDir>/keys/<id>.key`; neither is copied into
 * state, logs, or command output.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import { DEFAULT_LIMITS, type TextgenLimits } from "./input";
import { TextgenError } from "./model";

export const PLUGIN_ID = "rebuildup.textgen";

export type ApiGeneratorKind = "openai" | "anthropic" | "openai-compatible";

export interface ApiGeneratorConfig {
  id: string;
  kind: ApiGeneratorKind;
  /** Base URL; kind-specific path is appended (see api.ts). */
  endpoint: string;
  model?: string;
  /** Env var holding the API key. Never the key itself. */
  keyEnv?: string;
  /** Explicit opt-in: a generator without `enabled: true` is inert. */
  enabled: boolean;
  maxTokens?: number;
}

export interface AgentProviderConfig {
  /** herdr agent kind override (e.g. "claude"); defaults to the id suffix. */
  kind?: string;
  /** Extra argv forwarded to `agent.start`. */
  args?: string[];
  model?: string;
  enabled?: boolean;
}

export interface TextgenConfig {
  defaultProvider?: string;
  defaultModel?: string;
  /** Override for the rebuildup.git plugin root (git-context adapter). */
  gitPluginRoot?: string;
  apiGenerators: ApiGeneratorConfig[];
  /** agent-kind → overrides (key is the bare kind, e.g. "claude"). */
  agentProviders: Record<string, AgentProviderConfig>;
  agent: {
    startupTimeoutMs: number;
    promptTimeoutMs: number;
    readLines: number;
  };
  limits: TextgenLimits;
}

export const DEFAULT_AGENT_TIMEOUTS = {
  startupTimeoutMs: 60_000,
  promptTimeoutMs: 300_000,
  readLines: 400,
} as const;

const API_KINDS: ReadonlySet<string> = new Set(["openai", "anthropic", "openai-compatible"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Parse one apiGenerators[] entry; returns null when malformed. */
export function parseApiGenerator(raw: unknown): ApiGeneratorConfig | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const kind = str(raw.kind);
  const endpoint = str(raw.endpoint);
  if (id === undefined || kind === undefined || endpoint === undefined) return null;
  if (!API_KINDS.has(kind)) return null;
  const model = str(raw.model);
  const keyEnv = str(raw.keyEnv);
  const maxTokens = typeof raw.maxTokens === "number" ? Math.floor(raw.maxTokens) : undefined;
  const base: ApiGeneratorConfig = {
    id,
    kind: kind as ApiGeneratorKind,
    endpoint,
    enabled: raw.enabled === true,
    ...(model !== undefined ? { model } : {}),
    ...(keyEnv !== undefined ? { keyEnv } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
  return base;
}

/**
 * Load and normalize config.json. A missing file yields defaults; a
 * malformed file yields defaults plus a warning surfaced via
 * `loadConfigWithWarnings` (capability must never hard-fail on config).
 */
export function normalizeConfig(raw: unknown): {
  config: TextgenConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const root = isRecord(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    warnings.push("config.json is not a JSON object; using defaults");
  }

  const apiGenerators: ApiGeneratorConfig[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(root.apiGenerators)) {
    for (const entry of root.apiGenerators) {
      const parsed = parseApiGenerator(entry);
      if (parsed === null) {
        warnings.push("dropped malformed apiGenerators entry");
        continue;
      }
      if (seenIds.has(parsed.id)) {
        warnings.push(`duplicate apiGenerators id "${parsed.id}" dropped`);
        continue;
      }
      seenIds.add(parsed.id);
      apiGenerators.push(parsed);
    }
  } else if (root.apiGenerators !== undefined) {
    warnings.push("apiGenerators is not an array; ignored");
  }

  const agentProviders: Record<string, AgentProviderConfig> = {};
  if (isRecord(root.agentProviders)) {
    for (const [key, value] of Object.entries(root.agentProviders)) {
      if (!isRecord(value)) continue;
      const kind = str(value.kind);
      const model = str(value.model);
      const args = Array.isArray(value.args)
        ? value.args.filter((a): a is string => typeof a === "string")
        : undefined;
      agentProviders[key] = {
        ...(kind !== undefined ? { kind } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
      };
    }
  }

  const agentRaw = isRecord(root.agent) ? root.agent : {};
  const limitsRaw = isRecord(root.limits) ? root.limits : {};
  const defaultProvider = str(root.defaultProvider);
  const defaultModel = str(root.defaultModel);
  const gitPluginRoot = str(root.gitPluginRoot);

  return {
    config: {
      ...(defaultProvider !== undefined ? { defaultProvider } : {}),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      ...(gitPluginRoot !== undefined ? { gitPluginRoot } : {}),
      apiGenerators,
      agentProviders,
      agent: {
        startupTimeoutMs: num(
          agentRaw.startupTimeoutMs,
          DEFAULT_AGENT_TIMEOUTS.startupTimeoutMs,
          3_000,
          300_000,
        ),
        promptTimeoutMs: num(
          agentRaw.promptTimeoutMs,
          DEFAULT_AGENT_TIMEOUTS.promptTimeoutMs,
          1_000,
          3_600_000,
        ),
        readLines: num(agentRaw.readLines, DEFAULT_AGENT_TIMEOUTS.readLines, 50, 5_000),
      },
      limits: {
        maxInputChars: num(limitsRaw.maxInputChars, DEFAULT_LIMITS.maxInputChars, 1_000, 2_000_000),
      },
    },
    warnings,
  };
}

export function configFilePath(configDir?: string): string {
  return path.join(configDir ?? pluginDirs(PLUGIN_ID).configDir, "config.json");
}

export async function loadConfig(configDir?: string): Promise<TextgenConfig> {
  return (await loadConfigWithWarnings(configDir)).config;
}

export async function loadConfigWithWarnings(
  configDir?: string,
): Promise<{ config: TextgenConfig; warnings: string[] }> {
  try {
    const raw = JSON.parse(await readFile(configFilePath(configDir), "utf8")) as unknown;
    return normalizeConfig(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        config: normalizeConfig(undefined).config,
        warnings: ["config.json is not valid JSON; using defaults"],
      };
    }
    return { config: normalizeConfig(undefined).config, warnings: [] };
  }
}

/** Atomic write of an arbitrary JSON value as config.json. */
export async function writeConfigJson(
  configDir: string | undefined,
  value: unknown,
): Promise<string> {
  const dir = configDir ?? pluginDirs(PLUGIN_ID).configDir;
  await mkdir(dir, { recursive: true });
  const file = configFilePath(dir);
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return file;
}

/** Atomic config.json write (single-writer rename, repo invariant). */
export async function saveConfig(config: TextgenConfig, configDir?: string): Promise<string> {
  return writeConfigJson(configDir, config);
}

/**
 * Resolve the API key for a generator (ADR-0018): env var named by
 * `keyEnv` first, then `<configDir>/keys/<id>.key`. The value is returned
 * to the caller for immediate use as a request credential only — it is
 * never logged, persisted, or embedded in errors.
 */
export async function resolveApiKey(
  generator: ApiGeneratorConfig,
  configDir?: string,
): Promise<string | null> {
  const envName =
    generator.keyEnv ??
    `HERDR_TEXTGEN_${generator.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  try {
    const dir = configDir ?? pluginDirs(PLUGIN_ID).configDir;
    const file = path.join(dir, "keys", `${generator.id}.key`);
    const value = (await readFile(file, "utf8")).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Redacted view of the config for `config show` / capability output. */
export function redactConfig(config: TextgenConfig): Record<string, unknown> {
  return {
    defaultProvider: config.defaultProvider ?? null,
    defaultModel: config.defaultModel ?? null,
    gitPluginRoot: config.gitPluginRoot ?? null,
    apiGenerators: config.apiGenerators.map((g) => ({
      id: g.id,
      kind: g.kind,
      endpoint: g.endpoint,
      model: g.model ?? null,
      enabled: g.enabled,
      keyEnv: g.keyEnv ?? null,
      keyConfigured: "see capability", // resolved per-invocation; never the value
      maxTokens: g.maxTokens ?? null,
    })),
    agentProviders: config.agentProviders,
    agent: config.agent,
    limits: config.limits,
    credential_boundary: "docs/adr/0018-textgen-api-credential-boundary.md",
  };
}

export function configError(message: string): never {
  throw new TextgenError("config_invalid", "bad_request", message);
}
