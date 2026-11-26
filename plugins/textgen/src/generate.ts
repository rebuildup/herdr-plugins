/**
 * Generation orchestration for rebuildup.textgen (Issue #107).
 *
 * Pipeline: task lookup → input validation + secret guard → provider
 * resolution → prompt build → path execution (agent pane / API) →
 * output validation → typed result. Generation is strictly separated
 * from execution: callers adopt or discard the result; nothing here
 * touches git, forge, or the agent being described.
 */

import { type AgentTransport, executeAgentPrompt } from "./agent";
import { executeApiPrompt, type FetchImpl } from "./api";
import type { TextgenConfig } from "./config";
import { checkGenerationGuards } from "./guards";
import { validateTaskInput } from "./input";
import { CONTRACT, type GenerationResult, type TaskKind, TextgenError, taskSpec } from "./model";
import { validateGeneratedOutput } from "./output";
import { buildPrompt } from "./prompts";
import { type AgentManifestEntry, resolveProvider } from "./providers";
import type { QuotaProbe } from "./quota";

export interface GenerateOptions {
  task: TaskKind;
  /** Raw JSON input object (already parsed). */
  input: Record<string, unknown>;
  provider?: string | undefined;
  model?: string | undefined;
  config: TextgenConfig;
  /** Injectable herdr transport (agent path). */
  agentTransport?: AgentTransport | undefined;
  /** Injectable fetch (api path). */
  fetchImpl?: FetchImpl | undefined;
  /** herdr agent manifests for provider resolution hints. */
  manifests?: AgentManifestEntry[] | undefined;
  /** cwd forwarded to the agent workspace (e.g. review_guide input.cwd). */
  cwd?: string | undefined;
  agentName?: string | undefined;
  configDir?: string | undefined;
  /** Per-call timeout override (ms) for the provider wait/request. */
  timeoutMs?: number | undefined;
  /** Per-call opt-in for `requiresOptIn` tasks (e.g. `--allow-expensive`). */
  allowExpensive?: boolean | undefined;
  /** Injectable usage-quota probe (tests); default = usage plugin CLI. */
  quotaProbe?: QuotaProbe | undefined;
  /** Passed to the default quota probe for session/socket routing. */
  session?: string | undefined;
  socketPath?: string | undefined;
}

export interface GenerateSuccess {
  contract: typeof CONTRACT;
  command: "generate";
  ok: true;
  task: TaskKind;
  provider: string;
  path: "agent" | "api";
  model: string | null;
  result: GenerationResult;
  elapsed_ms: number;
  warnings: string[];
}

export async function generate(options: GenerateOptions): Promise<GenerateSuccess> {
  const spec = taskSpec(options.task);
  const started = Date.now();
  const warnings: string[] = [];

  const input = validateTaskInput(spec, options.input, options.config.limits);
  const requestedCandidates =
    typeof input.candidates === "number" && Number.isFinite(input.candidates)
      ? Math.min(spec.maxListItems, Math.max(1, Math.floor(input.candidates)))
      : 3;

  const provider = resolveProvider(spec, {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    config: options.config,
    ...(options.manifests !== undefined ? { manifests: options.manifests } : {}),
  });

  // Cheap pre-execution guards (Issue #109): expensive-task opt-in,
  // agent-kind availability vs herdr manifests, optional usage-quota
  // probe. All run before any pane is spawned; failures are structured.
  const guard = await checkGenerationGuards({
    spec,
    provider,
    config: options.config,
    ...(options.manifests !== undefined ? { manifests: options.manifests } : {}),
    ...(options.allowExpensive !== undefined ? { allowExpensive: options.allowExpensive } : {}),
    ...(options.quotaProbe !== undefined ? { quotaProbe: options.quotaProbe } : {}),
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
  });
  warnings.push(...guard.warnings);

  // Model resolution: explicit --model > provider default > config default.
  const model =
    options.model ??
    (provider.path === "api" ? provider.api?.model : undefined) ??
    provider.model ??
    options.config.defaultModel ??
    null;

  const prompt =
    provider.path === "agent"
      ? buildPrompt(spec, input, { marked: true })
      : buildPrompt(spec, input, { marked: false });

  let rawText: string;
  if (provider.path === "agent") {
    if (options.agentTransport === undefined) {
      throw new TextgenError(
        "agent_transport_missing",
        "internal",
        "agent path requires an agent transport",
      );
    }
    const kind = provider.agentKind ?? "";
    if (kind === "") {
      throw new TextgenError("provider_unknown", "internal", "agent provider has no kind");
    }
    // herdr agent names: lowercase letters/digits/'-'/'_', 1-32 chars.
    const agentName =
      options.agentName ??
      `textgen-${spec.kind.replace(/_/g, "-")}-${Date.now().toString(36)}`.slice(0, 32);
    const cwd = options.cwd ?? (typeof input.cwd === "string" ? input.cwd : undefined);
    const exec = await executeAgentPrompt(options.agentTransport, {
      kind,
      name: agentName,
      ...(provider.agentArgs !== undefined ? { args: provider.agentArgs } : {}),
      prompt,
      startupTimeoutMs: options.config.agent.startupTimeoutMs,
      // Agent-only tasks (review_guide/next_prompt) use their per-task
      // default timeout — review_guide's multi-step investigation needs
      // far longer than the generic agent prompt wait. `--timeout`
      // always wins; agent+api tasks keep the config default.
      promptTimeoutMs:
        options.timeoutMs ??
        (spec.paths.length === 1 && spec.paths[0] === "agent"
          ? spec.defaultTimeoutMs
          : options.config.agent.promptTimeoutMs),
      readLines: options.config.agent.readLines,
      ...(cwd !== undefined ? { cwd } : {}),
      label: `textgen:${spec.kind}`,
    });
    for (const w of exec.cleanupWarnings) warnings.push(w);
    if (exec.markedText === null) {
      throw new TextgenError(
        "output_unmarked",
        "invalid_output",
        "agent output did not contain the TEXTGEN result markers",
        { agent: exec.agentName },
      );
    }
    rawText = exec.markedText;
  } else {
    if (provider.api === undefined || model === null) {
      throw new TextgenError(
        "provider_misconfigured",
        "bad_request",
        "api provider requires a configured generator and model",
        { provider: provider.id },
      );
    }
    const exec = await executeApiPrompt({
      generator: provider.api,
      model,
      prompt,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
    });
    rawText = exec.text;
  }

  if (provider.path === "agent" && options.model !== undefined) {
    // Agent CLIs own model selection; per-provider argv lives in
    // config agentProviders[].args. Report, don't pretend it applied.
    warnings.push("model_flag_ignored_on_agent_path");
  }

  const result = validateGeneratedOutput(spec, rawText, requestedCandidates);

  return {
    contract: CONTRACT,
    command: "generate",
    ok: true,
    task: spec.kind,
    provider: provider.id,
    path: provider.path,
    model,
    result,
    elapsed_ms: Date.now() - started,
    warnings,
  };
}
