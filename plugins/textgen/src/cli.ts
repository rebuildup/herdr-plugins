/**
 * rebuildup.textgen CLI — text generation contract
 * (`herdr-plugins.textgen/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * Commands: capability / generate / git-context / watch-next-prompt /
 * config. Generation is strictly
 * separated from execution — the plugin returns validated candidate
 * text; adopting it (git, forge, composer) is the caller's job, and a
 * manual path always exists (Issue #107, ADR-0017/0018).
 */

import { readFile } from "node:fs/promises";
import {
  type CallOptions,
  reportPaneMetadata,
  subscribeAgentEvents,
} from "../../../packages/herdr-client/src/index";
import { type AgentTransport, socketTransport } from "./agent";
import {
  configFilePath,
  loadConfigWithWarnings,
  normalizeConfig,
  PLUGIN_ID,
  parseApiGenerator,
  redactConfig,
  resolveApiKey,
  writeConfigJson,
} from "./config";
import { generate } from "./generate";
import {
  collectGitContext,
  type GitContextResult,
  isGitTask,
  resolveGitPluginRoot,
} from "./gitcontext";
import { parseInputJson, validateTaskInput } from "./input";
import {
  CONTRACT,
  isTaskKind,
  PLUGIN_VERSION,
  TASKS,
  type TaskKind,
  TextgenError,
  taskSpec,
} from "./model";
import { type AgentManifestEntry, KNOWN_AGENT_KINDS } from "./providers";
import { watchNextPrompt } from "./watch";

interface CliOptions {
  command: string;
  args: string[];
  session: string | undefined;
  socketPath: string | undefined;
  timeoutMs: number | undefined;
  inputFile: string | undefined;
  task: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  raw: boolean;
  configDir: string | undefined;
  cwd: string | undefined;
  gitPane: string | undefined;
  gitRoot: string | undefined;
  pane: string | undefined;
  once: boolean;
  maxTriggers: number | undefined;
  debounceMs: number | undefined;
  readLines: number | undefined;
  allowExpensive: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = {
    command,
    args: [],
    session: undefined,
    socketPath: undefined,
    timeoutMs: undefined,
    inputFile: undefined,
    task: undefined,
    provider: undefined,
    model: undefined,
    raw: false,
    configDir: undefined,
    cwd: undefined,
    gitPane: undefined,
    gitRoot: undefined,
    pane: undefined,
    once: false,
    maxTriggers: undefined,
    debounceMs: undefined,
    readLines: undefined,
    allowExpensive: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const next = () => args[++i];
    if (arg === "--session") options.session = next();
    else if (arg === "--socket") options.socketPath = next();
    else if (arg === "--timeout") {
      const value = Number(next());
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else if (arg === "--input") options.inputFile = next();
    else if (arg === "--task") options.task = next();
    else if (arg === "--provider") options.provider = next();
    else if (arg === "--model") options.model = next();
    else if (arg === "--raw") options.raw = true;
    else if (arg === "--config-dir") options.configDir = next();
    else if (arg === "--cwd") options.cwd = next();
    else if (arg === "--git-pane") options.gitPane = next();
    else if (arg === "--git-root") options.gitRoot = next();
    else if (arg === "--pane") options.pane = next();
    else if (arg === "--once") options.once = true;
    else if (arg === "--allow-expensive") options.allowExpensive = true;
    else if (arg === "--max-triggers") {
      const value = Number(next());
      if (Number.isFinite(value) && value > 0) options.maxTriggers = Math.floor(value);
    } else if (arg === "--debounce-ms") {
      const value = Number(next());
      if (Number.isFinite(value) && value >= 0) options.debounceMs = Math.floor(value);
    } else if (arg === "--read-lines") {
      const value = Number(next());
      if (Number.isFinite(value) && value > 0) options.readLines = Math.floor(value);
    } else rest.push(arg);
  }
  options.args = rest;
  return options;
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message: string, code = 1, kind?: string, extra?: Record<string, unknown>): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind) error.kind = kind;
  if (extra) Object.assign(error, extra);
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function usageError(message: string): never {
  fail(message, 2);
}

function now(): string {
  return new Date().toISOString();
}

function callOptions(options: CliOptions): CallOptions {
  const call: CallOptions = {};
  if (options.session !== undefined) call.session = options.session;
  if (options.socketPath !== undefined) call.socketPath = options.socketPath;
  if (options.timeoutMs !== undefined) call.timeoutMs = options.timeoutMs;
  return call;
}

function agentTransport(options: CliOptions): AgentTransport {
  return socketTransport(callOptions(options));
}

/** Best-effort agent manifest list; undefined when herdr is unreachable. */
async function fetchManifests(
  transport: AgentTransport,
): Promise<AgentManifestEntry[] | undefined> {
  try {
    const result = await transport.call("server.agent_manifests", {});
    const manifests = Array.isArray(result.manifests) ? result.manifests : [];
    return manifests
      .map((m) => {
        const rec = typeof m === "object" && m !== null ? (m as Record<string, unknown>) : {};
        return typeof rec.agent === "string"
          ? ({
              agent: rec.agent,
              ...(typeof rec.source === "string" ? { source: rec.source } : {}),
              ...(typeof rec.source_kind === "string" ? { source_kind: rec.source_kind } : {}),
              ...(rec.warning !== undefined ? { warning: rec.warning as string | null } : {}),
            } satisfies AgentManifestEntry)
          : null;
      })
      .filter((m): m is AgentManifestEntry => m !== null);
  } catch {
    return undefined;
  }
}

// --- capability ---------------------------------------------------------------

async function cmdCapability(options: CliOptions): Promise<void> {
  const { config, warnings } = await loadConfigWithWarnings(options.configDir);
  const transport = agentTransport(options);
  const manifests = await fetchManifests(transport);

  const manifestByKind = new Map((manifests ?? []).map((m) => [m.agent, m]));
  const agentProviders = KNOWN_AGENT_KINDS.map((kind) => {
    const override = config.agentProviders[kind];
    const manifest = manifestByKind.get(kind);
    const enabled = override?.enabled !== false;
    return {
      id: `agent:${kind}`,
      path: "agent",
      kind,
      enabled,
      availability:
        manifests === undefined
          ? "unverified"
          : manifest !== undefined
            ? "manifest"
            : "not_in_manifests",
      ...(manifest?.warning ? { warning: manifest.warning } : {}),
      ...(override?.model !== undefined ? { model: override.model } : {}),
      cost_note: "uses the provider's own subscription/CLI credentials via herdr",
    };
  });

  const apiProviders = await Promise.all(
    config.apiGenerators.map(async (g) => ({
      id: `api:${g.id}`,
      path: "api",
      generator: g.id,
      kind: g.kind,
      endpoint: g.endpoint,
      model: g.model ?? null,
      enabled: g.enabled,
      credential_configured: g.enabled
        ? (await resolveApiKey(g, options.configDir)) !== null
        : false,
      cost_note: "per-token API billing; opt-in only (ADR-0018)",
    })),
  );

  const gitResolution = await resolveGitPluginRoot(options.gitRoot ?? config.gitPluginRoot);

  emit({
    contract: CONTRACT,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    integrations: {
      git: gitResolution.ok
        ? {
            status: "resolved",
            plugin_id: "rebuildup.git",
            plugin_root: gitResolution.root,
            resolved_via: gitResolution.via,
            contract: "herdr-plugins.git/v1",
            git_tasks: ["branch_name", "commit_message", "pr_content"],
          }
        : {
            status: "unavailable",
            plugin_id: "rebuildup.git",
            error: gitResolution.error,
          },
    },
    credential_boundary: {
      execution_path: "docs/adr/0017-textgen-execution-path.md",
      api_credentials: "docs/adr/0018-textgen-api-credential-boundary.md",
    },
    tasks: TASKS.map((t) => ({
      kind: t.kind,
      description: t.description,
      paths: t.paths,
      input_fields: t.inputFields,
      required_input: t.requiredInput,
      output: t.output,
      max_output_chars: t.maxOutputChars,
      requires_opt_in: t.requiresOptIn === true,
      ...(t.requiresOptIn === true
        ? {
            opt_in:
              "guards.expensiveTaskOptIn in config.json or --allow-expensive; " +
              "multi-step agent investigation bills like any agent turn",
          }
        : {}),
    })),
    guards: {
      expensive_task_opt_in: config.guards.expensiveTaskOptIn,
      quota_check: {
        enabled: config.guards.quota.enabled,
        max_used_percent: config.guards.quota.maxUsedPercent,
        provider: "rebuildup.usage quota (read-only, soft dependency)",
      },
    },
    providers: {
      agent: agentProviders,
      api: apiProviders,
      cli: {
        status: "unsupported",
        reason:
          "headless provider CLI subprocess rejected by ADR-0017 (bypasses herdr PTY authority)",
      },
    },
    agent_manifests: manifests === undefined ? "unreachable" : "queried",
    config: redactConfig(config),
    config_warnings: warnings,
    commands: ["capability", "generate", "git-context", "watch-next-prompt", "config"],
    // Commands with side effects (#224): `generate` and
    // `watch-next-prompt` drive herdr agent panes (agent.start/prompt)
    // and record pane metadata; the listed `config` subcommands write
    // config.json (`config show` is a read). `capability` and
    // `git-context` are read-only.
    mutation_commands: [
      "generate",
      "watch-next-prompt",
      "config set-default-provider",
      "config set-default-model",
      "config add-api-generator",
      "config remove-api-generator",
    ],
    generated_at: now(),
  });
}

// --- generate ------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read the --input payload source: FILE, '-' (stdin), or piped stdin. */
async function readInputText(options: CliOptions): Promise<string> {
  if (options.inputFile !== undefined && options.inputFile !== "-") {
    try {
      return await readFile(options.inputFile, "utf8");
    } catch (err) {
      fail(
        `cannot read --input file: ${err instanceof Error ? err.message : String(err)}`,
        1,
        "bad_request",
      );
    }
  }
  if (options.inputFile === "-" || !process.stdin.isTTY) {
    return readStdin();
  }
  return "";
}

async function cmdGenerate(options: CliOptions): Promise<void> {
  if (options.task === undefined || options.task === "") {
    usageError("generate requires --task <kind>");
  }
  if (!isTaskKind(options.task)) {
    fail(`unknown task kind: ${options.task}`, 2, "bad_request", {
      known: TASKS.map((t) => t.kind),
    });
  }
  const spec = taskSpec(options.task as TaskKind);
  const gitPane = options.gitPane !== undefined && options.gitPane !== "" ? options.gitPane : null;
  if (gitPane !== null && !isGitTask(spec.kind)) {
    usageError(
      `--git-pane is only supported for git tasks (branch_name, commit_message, pr_content); got ${spec.kind}`,
    );
  }

  // Input: --input FILE | --input - | stdin (when piped) | required error.
  // With --git-pane the payload may be empty: the git adapter supplies
  // the task fields and explicit input only overrides them.
  const inputText = await readInputText(options);
  let rawInput: Record<string, unknown> =
    inputText.trim() === "" && gitPane !== null ? {} : parseInputJson(inputText, spec);
  // Validate early so boundary errors surface before any provider call.
  const { config, warnings: configWarnings } = await loadConfigWithWarnings(options.configDir);

  // Git/forge context adapter (Issue #108): gather diff/commits/conventions
  // through the rebuildup.git plugin's read-only git-v1 CLI. Explicit
  // input fields win over collected ones; collection is read-only and
  // never mutates the repository or the forge.
  let gitContext: { pane: string; result: GitContextResult } | null = null;
  if (gitPane !== null) {
    const resolution = await resolveGitPluginRoot(options.gitRoot ?? config.gitPluginRoot);
    if (!resolution.ok) {
      fail(resolution.error, 1, "git_unavailable");
    }
    const collected = await collectGitContext({
      task: spec.kind,
      pane: gitPane,
      gitRoot: resolution.root,
      ...(options.session !== undefined ? { session: options.session } : {}),
      ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    gitContext = { pane: gitPane, result: collected };
    const merged: Record<string, unknown> = { ...collected.input };
    for (const [key, value] of Object.entries(rawInput)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
    rawInput = merged;
  }

  validateTaskInput(spec, rawInput, config.limits);

  // Agent manifests improve default provider choice when herdr is up.
  const transport = agentTransport(options);
  const manifests = await fetchManifests(transport);

  const result = await generate({
    task: options.task as TaskKind,
    input: rawInput,
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    config,
    agentTransport: transport,
    ...(manifests !== undefined ? { manifests } : {}),
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
    ...(options.cwd !== undefined
      ? { cwd: options.cwd }
      : gitContext?.result.repoRoot !== null && gitContext?.result.repoRoot !== undefined
        ? { cwd: gitContext.result.repoRoot }
        : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.allowExpensive ? { allowExpensive: true } : {}),
    session: options.session,
    socketPath: options.socketPath,
  });
  result.warnings.push(...configWarnings);
  if (gitContext !== null) {
    result.warnings.push(...gitContext.result.warnings);
  }

  if (options.raw) {
    if (typeof result.result === "string") {
      process.stdout.write(`${result.result}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result.result)}\n`);
    }
    return;
  }
  emit({
    ...result,
    ...(gitContext !== null
      ? {
          git_context: {
            pane_id: gitContext.pane,
            repo_root: gitContext.result.repoRoot,
            branch: gitContext.result.branch,
            sources: gitContext.result.sources,
          },
        }
      : {}),
  });
}

// --- git-context -----------------------------------------------------------------

/**
 * `git-context` previews the repository input the git adapter would feed
 * a task — the same collection `generate --git-pane` performs, without
 * invoking any provider. Useful for debugging and for callers that want
 * to inspect/override collected fields before generating.
 */
async function cmdGitContext(options: CliOptions): Promise<void> {
  if (options.task === undefined || options.task === "") {
    usageError("git-context requires --task <kind>");
  }
  if (!isTaskKind(options.task)) {
    fail(`unknown task kind: ${options.task}`, 2, "bad_request", {
      known: TASKS.map((t) => t.kind),
    });
  }
  const spec = taskSpec(options.task as TaskKind);
  if (!isGitTask(spec.kind)) {
    usageError(
      `git-context only supports git tasks (branch_name, commit_message, pr_content); got ${spec.kind}`,
    );
  }
  const pane = options.gitPane;
  if (pane === undefined || pane === "") {
    usageError("git-context requires --git-pane <pane_id>");
  }
  const { config } = await loadConfigWithWarnings(options.configDir);
  const resolution = await resolveGitPluginRoot(options.gitRoot ?? config.gitPluginRoot);
  if (!resolution.ok) {
    fail(resolution.error, 1, "git_unavailable");
  }
  const collected = await collectGitContext({
    task: spec.kind,
    pane,
    gitRoot: resolution.root,
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  emit({
    contract: CONTRACT,
    command: "git-context",
    ok: true,
    task: spec.kind,
    pane_id: pane,
    git_plugin: {
      plugin_id: "rebuildup.git",
      plugin_root: resolution.root,
      resolved_via: resolution.via,
    },
    repo_root: collected.repoRoot,
    branch: collected.branch,
    input: collected.input,
    sources: collected.sources,
    warnings: collected.warnings,
    generated_at: now(),
  });
}

// --- watch-next-prompt -----------------------------------------------------------

function emitLine(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Long-running next-prompt watcher (Issue #109). Subscribes to
 * `pane.agent_status_changed` for `--pane` and generates a `next_prompt`
 * candidate on each observed `working → idle|done` transition — through
 * the same agent-pane path as `generate`, so every generation is
 * visible, bounded by timeouts, and cleaned up. The result is recorded
 * as pane metadata (`textgen_next_prompt`) plus JSONL events on stdout;
 * composer/notification UI is the caller's (herdr-t3) side.
 *
 * stdout is JSONL:
 *   {"contract","type":"watch.started"|"next_prompt.triggered"|
 *    "next_prompt.generated"|"next_prompt.skipped"|"next_prompt.error"|
 *    "next_prompt.warning"|"watch.stopped", ...}
 * Stops on SIGINT/SIGTERM, stream end, --once, or --max-triggers.
 */
async function cmdWatchNextPrompt(options: CliOptions): Promise<void> {
  const paneId = options.pane;
  if (paneId === undefined || paneId === "") {
    usageError("watch-next-prompt requires --pane <pane_id>");
  }
  const spec = taskSpec("next_prompt");
  const { config, warnings: configWarnings } = await loadConfigWithWarnings(options.configDir);
  for (const w of configWarnings) {
    emitLine({ contract: CONTRACT, type: "watch.warning", warning: w });
  }

  // Optional static input overrides the per-trigger pane read. When
  // absent, each trigger supplies the pane's recent scrollback as
  // `context` — the conversation the finished turn belongs to.
  let staticInput: Record<string, unknown> | undefined;
  const inputText = await readInputText(options);
  if (inputText.trim() !== "") {
    staticInput = parseInputJson(inputText, spec);
  }

  const transport = agentTransport(options);
  const manifests = await fetchManifests(transport);
  const call = callOptions(options);
  const source = subscribeAgentEvents(call);

  let signaled = false;
  const stop = () => {
    signaled = true;
    source.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  emitLine({
    contract: CONTRACT,
    type: "watch.started",
    pane_id: paneId,
    at: now(),
  });

  const summary = await watchNextPrompt(
    source,
    {
      paneId,
      config,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(manifests !== undefined ? { manifests } : {}),
      ...(options.allowExpensive ? { allowExpensive: true } : {}),
      ...(staticInput !== undefined ? { input: staticInput } : {}),
      ...(options.maxTriggers !== undefined ? { maxTriggers: options.maxTriggers } : {}),
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
      ...(options.readLines !== undefined ? { readLines: options.readLines } : {}),
      ...(options.once ? { once: true } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      session: options.session,
      socketPath: options.socketPath,
    },
    {
      transport,
      generate: (genOptions) =>
        generate({
          ...genOptions,
          agentTransport: transport,
          ...(manifests !== undefined ? { manifests } : {}),
          session: options.session,
          socketPath: options.socketPath,
        }),
      reportMetadata: (pane, tokens) =>
        reportPaneMetadata(pane, tokens, { ...call, source: PLUGIN_ID }),
      emit: emitLine,
    },
  );
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (signaled && summary.stopped === "stream_end") {
    summary.stopped = "signal";
  }

  emitLine({
    contract: CONTRACT,
    type: "watch.stopped",
    ...summary,
    at: now(),
  });
}

// --- config --------------------------------------------------------------------

async function readRawConfig(configDir?: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(configFilePath(configDir), "utf8")) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function configSubcommand(options: CliOptions): Promise<void> {
  const [sub, ...rest] = options.args;
  if (sub === "show") {
    const { config, warnings } = await loadConfigWithWarnings(options.configDir);
    emit({
      contract: CONTRACT,
      command: "config show",
      config: redactConfig(config),
      config_file: configFilePath(options.configDir),
      config_warnings: warnings,
      generated_at: now(),
    });
    return;
  }
  if (sub === "set-default-provider" || sub === "set-default-model") {
    const value = rest[0];
    if (value === undefined || value === "") usageError(`${sub} requires a value`);
    const raw = await readRawConfig(options.configDir);
    raw[sub === "set-default-provider" ? "defaultProvider" : "defaultModel"] = value;
    await writeConfigJson(options.configDir, raw);
    emit({
      contract: CONTRACT,
      command: `config ${sub}`,
      ok: true,
      key: sub === "set-default-provider" ? "defaultProvider" : "defaultModel",
      value,
      config_file: configFilePath(options.configDir),
    });
    return;
  }
  if (sub === "add-api-generator") {
    // Flags: --id --kind --endpoint --model --key-env --enable --max-tokens
    const kv = new Map<string, string>();
    let enable = false;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i] as string;
      if (arg === "--enable") {
        enable = true;
        continue;
      }
      if (arg.startsWith("--")) kv.set(arg.slice(2), rest[++i] ?? "");
    }
    const entry: Record<string, unknown> = {
      id: kv.get("id"),
      kind: kv.get("kind"),
      endpoint: kv.get("endpoint"),
      enabled: enable,
    };
    if (kv.get("model") !== undefined) entry.model = kv.get("model");
    if (kv.get("key-env") !== undefined) entry.keyEnv = kv.get("key-env");
    if (kv.get("max-tokens") !== undefined) entry.maxTokens = Number(kv.get("max-tokens"));
    const parsed = parseApiGenerator(entry);
    if (parsed === null) {
      fail(
        "invalid api generator entry: need --id, --kind (openai|anthropic|openai-compatible), --endpoint; --enable opts in",
        2,
      );
    }
    const raw = await readRawConfig(options.configDir);
    const list = Array.isArray(raw.apiGenerators) ? [...raw.apiGenerators] : [];
    const idx = list.findIndex(
      (e) => typeof e === "object" && e !== null && (e as { id?: string }).id === parsed.id,
    );
    if (idx === -1) list.push(entry);
    else list[idx] = entry;
    raw.apiGenerators = list;
    await writeConfigJson(options.configDir, raw);
    const redactedGenerators = redactConfig(normalizeConfig(raw).config).apiGenerators as Array<
      Record<string, unknown>
    >;
    emit({
      contract: CONTRACT,
      command: "config add-api-generator",
      ok: true,
      generator: redactedGenerators.find((g) => g.id === parsed.id) ?? null,
      note: enable
        ? "generator enabled — API calls will be billed per token"
        : "generator stored DISABLED; re-run with --enable to opt in (ADR-0018)",
      config_file: configFilePath(options.configDir),
    });
    return;
  }
  if (sub === "remove-api-generator") {
    const id = rest[0];
    if (id === undefined || id === "") usageError("remove-api-generator requires an id");
    const raw = await readRawConfig(options.configDir);
    const list = Array.isArray(raw.apiGenerators) ? raw.apiGenerators : [];
    raw.apiGenerators = list.filter(
      (e) => !(typeof e === "object" && e !== null && (e as { id?: string }).id === id),
    );
    await writeConfigJson(options.configDir, raw);
    emit({
      contract: CONTRACT,
      command: "config remove-api-generator",
      ok: true,
      removed: id,
      config_file: configFilePath(options.configDir),
    });
    return;
  }
  usageError(
    "config requires a subcommand: show | set-default-provider <id> | set-default-model <m> | add-api-generator ... | remove-api-generator <id>",
  );
}

// --- entry ---------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  try {
    switch (options.command) {
      case "capability":
        await cmdCapability(options);
        return;
      case "generate":
        await cmdGenerate(options);
        return;
      case "git-context":
        await cmdGitContext(options);
        return;
      case "watch-next-prompt":
        await cmdWatchNextPrompt(options);
        return;
      case "config":
        await configSubcommand(options);
        return;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(
          "rebuildup.textgen — herdr-plugins.textgen/v1\n" +
            "  capability\n" +
            "  generate --task <kind> [--provider <id>] [--model <m>] [--input <file|->] [--raw]\n" +
            "          [--git-pane <pane>] [--git-root <dir>] [--cwd DIR] [--allow-expensive]\n" +
            "  git-context --task <kind> --git-pane <pane> [--git-root <dir>]\n" +
            "  watch-next-prompt --pane <pane> [--once] [--max-triggers N] [--debounce-ms MS]\n" +
            "          [--input <file|->] [--provider <id>] [--model <m>] [--allow-expensive]\n" +
            "  config show | set-default-provider | set-default-model | add-api-generator | remove-api-generator\n" +
            "tasks: " +
            TASKS.map((t) => t.kind).join(", ") +
            "\n",
        );
        return;
      default:
        usageError(`unknown command: ${options.command}`);
    }
  } catch (err) {
    if (err instanceof TextgenError) {
      fail(err.message, 1, err.kind, { code: err.code, ...err.details });
    }
    fail(err instanceof Error ? err.message : String(err), 1);
  }
}

await main();
