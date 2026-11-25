/**
 * Provider resolution for rebuildup.textgen (Issue #107, ADR-0017/0018).
 *
 * Two live execution paths:
 *  - `agent` — a dedicated herdr pane running a provider agent CLI
 *    (`agent:<kind>`, e.g. `agent:claude`). herdr owns the PTY; the
 *    generation is visible and interruptible.
 *  - `api` — an opt-in HTTP text generator (`api:<id>`) configured under
 *    `apiGenerators[]` with `enabled: true` (ADR-0018).
 *
 * `cli` (headless provider CLI subprocess) is a reserved path: ADR-0017
 * rejects it for v1 because it bypasses herdr's PTY authority and inherits
 * ambient credentials unsupervised.
 */

import type { ApiGeneratorConfig, TextgenConfig } from "./config";
import type { GenerationPath, TaskSpec } from "./model";
import { TextgenError } from "./model";

export interface AgentManifestEntry {
  agent: string;
  source?: string;
  source_kind?: string;
  warning?: string | null;
}

export interface ResolvedProvider {
  /** Canonical id, e.g. "agent:claude" or "api:openai". */
  id: string;
  path: Exclude<GenerationPath, "cli">;
  /** herdr agent kind when path === "agent". */
  agentKind?: string;
  /** extra argv for agent.start (agent path only). */
  agentArgs?: string[];
  /** configured API generator when path === "api". */
  api?: ApiGeneratorConfig;
  /** resolved default model for this provider (may be undefined). */
  model?: string;
}

/**
 * herdr agent kinds known to `agent.start` (herdr 0.9.x possible values).
 * Availability is still verified against `server.agent_manifests` at
 * capability/execution time — this list only bounds what we will attempt.
 */
export const KNOWN_AGENT_KINDS: readonly string[] = [
  "claude",
  "codex",
  "gemini",
  "grok",
  "opencode",
  "copilot",
  "cursor",
  "devin",
  "amp",
  "droid",
  "kimi",
  "kiro",
  "qwen",
];

export function isKnownAgentKind(kind: string): boolean {
  return KNOWN_AGENT_KINDS.includes(kind);
}

/** Parse a --provider value into {path, name}. Bare names resolve later. */
export function parseProviderRef(
  ref: string,
): { path: "agent" | "api" | null; name: string } | null {
  const trimmed = ref.trim();
  if (trimmed === "") return null;
  const sep = trimmed.indexOf(":");
  if (sep > 0) {
    const prefix = trimmed.slice(0, sep);
    const name = trimmed.slice(sep + 1);
    if ((prefix === "agent" || prefix === "api") && name !== "") {
      return { path: prefix, name };
    }
  }
  return { path: null, name: trimmed };
}

function agentProviderEnabled(config: TextgenConfig, kind: string): boolean {
  const override = config.agentProviders[kind];
  return override?.enabled !== false;
}

/**
 * Resolve the provider for a task. Throws TextgenError with structured
 * codes: `provider_unknown`, `provider_disabled`, `provider_path_unsupported`,
 * `no_provider`.
 */
export function resolveProvider(
  spec: TaskSpec,
  options: {
    provider?: string | undefined;
    model?: string | undefined;
    config: TextgenConfig;
    manifests?: AgentManifestEntry[] | undefined;
  },
): ResolvedProvider {
  const { config } = options;
  const manifestKinds = new Set((options.manifests ?? []).map((m) => m.agent));
  const ref = options.provider !== undefined ? parseProviderRef(options.provider) : null;
  if (options.provider !== undefined && ref === null) {
    throw new TextgenError(
      "provider_unknown",
      "bad_request",
      `unparseable provider reference: ${options.provider}`,
      { provider: options.provider },
    );
  }

  const candidates: ResolvedProvider[] = [];

  const pushAgent = (kind: string) => {
    if (!agentProviderEnabled(config, kind)) return;
    const override = config.agentProviders[kind];
    candidates.push({
      id: `agent:${kind}`,
      path: "agent",
      agentKind: kind,
      ...(override?.args !== undefined ? { agentArgs: override.args } : {}),
      ...(override?.model !== undefined
        ? { model: override.model }
        : config.defaultModel !== undefined
          ? { model: config.defaultModel }
          : {}),
    });
  };

  const pushApi = (gen: ApiGeneratorConfig) => {
    if (!gen.enabled) return;
    candidates.push({
      id: `api:${gen.id}`,
      path: "api",
      api: gen,
      ...(gen.model !== undefined
        ? { model: gen.model }
        : config.defaultModel !== undefined
          ? { model: config.defaultModel }
          : {}),
    });
  };

  if (ref !== null) {
    if (ref.path === "agent") {
      // Explicit agent kinds must be known or manifest-listed — herdr
      // would reject them at agent.start anyway; fail earlier and
      // structured instead.
      if (isKnownAgentKind(ref.name) || manifestKinds.has(ref.name)) {
        pushAgent(ref.name);
      }
    } else if (ref.path === "api") {
      const gen = config.apiGenerators.find((g) => g.id === ref.name);
      if (gen !== undefined) pushApi(gen);
    } else {
      // Bare name: agent kind first, then api generator id.
      if (isKnownAgentKind(ref.name) || manifestKinds.has(ref.name)) pushAgent(ref.name);
      const gen = config.apiGenerators.find((g) => g.id === ref.name);
      if (gen !== undefined) pushApi(gen);
    }
  } else {
    // Default resolution: config.defaultProvider first. An explicitly
    // configured default that resolves to nothing is an error, not a
    // silent fallback to every provider.
    const def = config.defaultProvider;
    if (def !== undefined) {
      const defRef = parseProviderRef(def);
      if (defRef !== null) {
        if (
          (defRef.path === "agent" &&
            (isKnownAgentKind(defRef.name) || manifestKinds.has(defRef.name))) ||
          (defRef.path === null &&
            (isKnownAgentKind(defRef.name) || manifestKinds.has(defRef.name)))
        ) {
          pushAgent(defRef.name);
        } else if (defRef.path === "api" || defRef.path === null) {
          const gen = config.apiGenerators.find((g) => g.id === defRef.name);
          if (gen !== undefined) pushApi(gen);
        }
      }
      if (candidates.length === 0) {
        throw new TextgenError(
          "provider_unknown",
          "bad_request",
          `configured defaultProvider "${def}" is not a known provider or is disabled`,
          { defaultProvider: def },
        );
      }
    }
    if (candidates.length === 0) {
      if (options.manifests !== undefined && options.manifests.length > 0) {
        for (const m of options.manifests) pushAgent(m.agent);
      } else {
        for (const kind of KNOWN_AGENT_KINDS) pushAgent(kind);
      }
      for (const gen of config.apiGenerators) pushApi(gen);
    }
  }

  if (candidates.length === 0) {
    if (ref !== null) {
      throw new TextgenError(
        "provider_unknown",
        "bad_request",
        `provider "${options.provider}" is not configured or not enabled`,
        {
          provider: options.provider,
          available: [
            ...KNOWN_AGENT_KINDS.map((k) => `agent:${k}`),
            ...config.apiGenerators.filter((g) => g.enabled).map((g) => `api:${g.id}`),
          ],
        },
      );
    }
    throw new TextgenError(
      "no_provider",
      "unavailable",
      "no usable provider: configure apiGenerators (enabled) or a herdr agent kind",
      { task: spec.kind, provider: options.provider ?? null },
    );
  }

  // Task/path compatibility: agent-only tasks reject api providers.
  const usable = candidates.filter((c) => spec.paths.includes(c.path));
  if (usable.length === 0) {
    throw new TextgenError(
      "provider_path_unsupported",
      "unsupported",
      `task ${spec.kind} does not support the resolved provider path(s)`,
      {
        task: spec.kind,
        paths: candidates.map((c) => c.id),
        supported: spec.paths,
      },
    );
  }

  // Explicit provider refs must match exactly one candidate kind of path.
  const chosen = usable[0] as ResolvedProvider;
  if (ref !== null) {
    const exact = usable.find((c) =>
      ref.path !== null ? c.id === `${ref.path}:${ref.name}` : c.id.endsWith(`:${ref.name}`),
    );
    if (exact === undefined) {
      const known = usable.map((c) => c.id);
      const looksAgent = ref.path === "agent" || isKnownAgentKind(ref.name);
      const looksApi = config.apiGenerators.some((g) => g.id === ref.name);
      throw new TextgenError(
        "provider_unknown",
        looksApi && !looksAgent ? "unavailable" : "bad_request",
        `provider "${options.provider}" is not configured or not enabled`,
        { provider: options.provider, available: known },
      );
    }
    return exact;
  }

  // Default order: prefer agent path (subscription CLI, no per-call API
  // billing — ADR-0017), then api. Within a path keep candidate order.
  const agentFirst = usable.find((c) => c.path === "agent");
  const resolved = agentFirst ?? chosen;
  if (options.model !== undefined) {
    return { ...resolved, model: options.model };
  }
  return resolved;
}
