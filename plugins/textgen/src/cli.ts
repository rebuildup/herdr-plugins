/**
 * rebuildup.textgen CLI — text generation contract
 * (`herdr-plugins.textgen/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * Commands: capability / generate / config. Generation is strictly
 * separated from execution — the plugin returns validated candidate
 * text; adopting it (git, forge, composer) is the caller's job, and a
 * manual path always exists (Issue #107, ADR-0017/0018).
 */

import { readFile } from "node:fs/promises";
import type { CallOptions } from "../../../packages/herdr-client/src/index";
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
    else rest.push(arg);
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

  emit({
    contract: CONTRACT,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
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
    })),
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
    commands: ["capability", "generate", "config"],
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

  // Input: --input FILE | --input - | stdin (when piped) | required error.
  let inputText = "";
  if (options.inputFile !== undefined && options.inputFile !== "-") {
    try {
      inputText = await readFile(options.inputFile, "utf8");
    } catch (err) {
      fail(
        `cannot read --input file: ${err instanceof Error ? err.message : String(err)}`,
        1,
        "bad_request",
      );
    }
  } else if (options.inputFile === "-" || !process.stdin.isTTY) {
    inputText = await readStdin();
  }
  const rawInput = parseInputJson(inputText, spec);
  // Validate early so boundary errors surface before any provider call.
  const { config, warnings: configWarnings } = await loadConfigWithWarnings(options.configDir);
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
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  result.warnings.push(...configWarnings);

  if (options.raw) {
    if (typeof result.result === "string") {
      process.stdout.write(`${result.result}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result.result)}\n`);
    }
    return;
  }
  emit(result);
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
