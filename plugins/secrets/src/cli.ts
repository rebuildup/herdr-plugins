/**
 * rebuildup.secrets CLI — secret reference resolution and env injection
 * (`herdr-plugins.secrets/v1`, Issue #160, boundary ADR-0027).
 *
 * Single JSON document on stdout for `capability` / `resolve` / `inject`
 * / `config`; `run` inherits stdio for the wrapped command and reports
 * only structured errors on stderr. Exit 0 success, 1 handled error,
 * 2 usage.
 *
 * Secret values are never printed, persisted, placed in argv, or written
 * to logs. The only sinks are the wrapped child's environment (`run`)
 * and herdr surface-creation `env` params (`inject`).
 */

import { spawn, spawnSync } from "node:child_process";
import { type CallOptions, pluginDirs } from "../../../packages/herdr-client/src/index";
import { configFilePath, loadConfig, writeInitialConfig } from "./config";
import { type InjectParams, injectEnv, type SurfaceKind } from "./inject";
import {
  type Binding,
  CONTRACT,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SecretsError,
  validateBinding,
} from "./model";
import { probeProvider, resolveSecret } from "./provider";

interface CliOptions {
  command: string;
  args: string[];
  session: string | undefined;
  socketPath: string | undefined;
  timeoutMs: number | undefined;
  configDir: string | undefined;
  infisicalBin: string | undefined;
  bindings: string[];
  surface: string | undefined;
  direction: string | undefined;
  targetPane: string | undefined;
  workspace: string | undefined;
  cwd: string | undefined;
  label: string | undefined;
  focus: boolean;
  ratio: number | undefined;
  probe: boolean;
  init: boolean;
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
    configDir: undefined,
    infisicalBin: undefined,
    bindings: [],
    surface: undefined,
    direction: undefined,
    targetPane: undefined,
    workspace: undefined,
    cwd: undefined,
    label: undefined,
    focus: false,
    ratio: undefined,
    probe: false,
    init: false,
  };
  const rest: string[] = [];
  let passthrough = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (passthrough) {
      rest.push(arg);
      continue;
    }
    const next = () => args[++i];
    if (arg === "--") {
      passthrough = true;
    } else if (arg === "--session") options.session = next();
    else if (arg === "--socket") options.socketPath = next();
    else if (arg === "--timeout") {
      const value = Number(next());
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else if (arg === "--config-dir") options.configDir = next();
    else if (arg === "--infisical-bin") options.infisicalBin = next();
    else if (arg === "--binding" || arg === "-b") options.bindings.push(next() ?? "");
    else if (arg === "--surface") options.surface = next();
    else if (arg === "--direction") options.direction = next();
    else if (arg === "--target-pane") options.targetPane = next();
    else if (arg === "--workspace") options.workspace = next();
    else if (arg === "--cwd") options.cwd = next();
    else if (arg === "--label") options.label = next();
    else if (arg === "--focus") options.focus = true;
    else if (arg === "--ratio") {
      const value = Number(next());
      if (Number.isFinite(value)) options.ratio = value;
    } else if (arg === "--probe") options.probe = true;
    else if (arg === "--init") options.init = true;
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

function providerOptions(options: CliOptions) {
  return {
    ...(options.infisicalBin !== undefined ? { bin: options.infisicalBin } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
}

// --- binding selection ---------------------------------------------------------

interface SelectedBinding {
  binding: Binding;
  projectId: string;
}

/**
 * Resolve `--binding` names against declared config bindings. Unknown
 * names and invalid declared bindings are hard errors — never silently
 * skipped (ADR-0027 §2: every action names its bindings).
 */
async function selectBindings(
  options: CliOptions,
): Promise<{ selected: SelectedBinding[]; configDir: string }> {
  if (options.bindings.length === 0) {
    usageError("at least one --binding <name> is required");
  }
  const { config, invalidBindings } = await loadConfig(options.configDir);
  const invalidNames = new Set(invalidBindings.map((b) => b.name));
  const byName = new Map(config.bindings.map((b) => [b.name, b]));
  const selected: SelectedBinding[] = [];
  for (const name of options.bindings) {
    const binding = byName.get(name);
    if (binding === undefined) {
      if (invalidNames.has(name)) {
        const detail = invalidBindings.find((b) => b.name === name);
        fail(
          `binding ${JSON.stringify(name)} is declared but invalid: ${detail?.error ?? "unknown"}`,
          1,
          "config_error",
        );
      }
      fail(`unknown binding ${JSON.stringify(name)}`, 1, "config_error", {
        declared: [...byName.keys()],
      });
    }
    const projectId = binding.projectId ?? config.infisical.projectId;
    if (projectId === undefined || projectId === "") {
      fail(
        `binding ${JSON.stringify(name)} has no Infisical projectId ` +
          "(set binding.projectId or infisical.projectId in config.json)",
        1,
        "config_error",
      );
    }
    selected.push({ binding, projectId });
  }
  return { selected, configDir: options.configDir ?? pluginDirs(PLUGIN_ID).configDir };
}

interface BindingReport {
  name: string;
  env: string;
  ref: string;
  status: string;
  detail?: string;
}

interface ResolveAllResult {
  reports: BindingReport[];
  /** Resolved env map — secret values; memory only, never emitted. */
  env: Record<string, string>;
  allResolved: boolean;
}

/**
 * Resolve every selected binding against the provider. Values stay in the
 * returned `env` map; reports carry status metadata only.
 */
async function resolveAll(
  options: CliOptions,
  selected: SelectedBinding[],
): Promise<ResolveAllResult> {
  const { config } = await loadConfig(options.configDir);
  const reports: BindingReport[] = [];
  const env: Record<string, string> = {};
  let allResolved = true;
  for (const { binding, projectId } of selected) {
    const parsed = validateBinding(binding);
    if (!parsed.ok) {
      reports.push({
        name: binding.name,
        env: binding.env,
        ref: binding.ref,
        status: "config_error",
        detail: parsed.error,
      });
      allResolved = false;
      continue;
    }
    const outcome = await resolveSecret(
      config,
      { ref: parsed.ref, projectId },
      providerOptions(options),
    );
    if (outcome.ok) {
      if (env[binding.env] !== undefined) {
        reports.push({
          name: binding.name,
          env: binding.env,
          ref: binding.ref,
          status: "config_error",
          detail: `env name ${binding.env} already resolved by another binding`,
        });
        allResolved = false;
        continue;
      }
      env[binding.env] = outcome.value;
      reports.push({ name: binding.name, env: binding.env, ref: binding.ref, status: "resolved" });
    } else {
      allResolved = false;
      reports.push({
        name: binding.name,
        env: binding.env,
        ref: binding.ref,
        status: outcome.status,
        detail: outcome.detail,
      });
    }
  }
  return { reports, env, allResolved };
}

// --- capability -----------------------------------------------------------------

async function detectInfisicalCli(bin: string): Promise<{
  available: boolean;
  version?: string | undefined;
  detail?: string | undefined;
}> {
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: process.env,
  });
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    // Provider stdout/stderr are never echoed: `--version` failure
    // output is arbitrary provider text that could carry secret-shaped
    // material into the capability envelope (issue #209).
    return {
      available: false,
      detail: `infisical --version exited with code ${result.status ?? "signal"}`,
    };
  }
  const firstLine = (result.stdout || "").trim().split("\n")[0] ?? "";
  return { available: true, version: firstLine === "" ? undefined : firstLine };
}

async function cmdCapability(options: CliOptions): Promise<void> {
  const { config, invalidBindings, warnings } = await loadConfig(options.configDir);
  const bin = options.infisicalBin ?? "infisical";
  const cli = await detectInfisicalCli(bin);

  let reachability:
    | { status: "not_checked" }
    | {
        status: "ok" | "unresolved" | "provider_unreachable" | "auth_missing" | "provider_error";
        detail?: string;
      } = {
    status: "not_checked",
  };
  if (options.probe) {
    const projectId = config.infisical.projectId ?? config.bindings[0]?.projectId;
    if (projectId === undefined || projectId === "") {
      reachability = { status: "not_checked" };
    } else {
      const probe = await probeProvider(
        config,
        {
          ref: { env: "dev", path: "/", secret: "__probe__" },
          projectId,
        },
        providerOptions(options),
      );
      reachability = {
        status: probe.status === "ok" ? "ok" : probe.status,
        ...(probe.detail !== undefined ? { detail: probe.detail } : {}),
      };
    }
  }

  emit({
    contract: CONTRACT,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    provider: {
      name: "infisical",
      domain: config.infisical.domain,
      cli: {
        bin,
        available: cli.available,
        ...(cli.version !== undefined ? { version: cli.version } : {}),
        ...(cli.detail !== undefined ? { detail: cli.detail } : {}),
      },
      project_id_configured:
        config.infisical.projectId !== undefined ||
        config.bindings.some((b) => b.projectId !== undefined),
      reachability,
    },
    bindings: config.bindings.map((b) => ({
      name: b.name,
      env: b.env,
      ref: b.ref,
      ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
    })),
    invalid_bindings: invalidBindings,
    config_warnings: warnings,
    credential_boundary: {
      adr: "docs/adr/0027-secrets-env-injection-boundary.md",
      transit: "provider -> memory -> {child env (run), surface-create env params (inject)}",
      never: "persisted / logged / argv / emitted",
    },
    commands: ["capability", "resolve", "run", "inject", "config"],
    generated_at: now(),
  });
}

// --- resolve ---------------------------------------------------------------------

async function cmdResolve(options: CliOptions): Promise<void> {
  const { selected } = await selectBindings(options);
  const result = await resolveAll(options, selected);
  emit({
    contract: CONTRACT,
    command: "resolve",
    plugin: PLUGIN_ID,
    ok: result.allResolved,
    bindings: result.reports,
    // Deliberately no `env`/values section: resolve is metadata-only
    // (ADR-0027 §3 — there is no emit escape hatch in v1).
    generated_at: now(),
  });
  if (!result.allResolved) process.exit(1);
}

// --- run -------------------------------------------------------------------------

async function cmdRun(options: CliOptions): Promise<void> {
  const cmdArgs = options.args;
  if (cmdArgs.length === 0) {
    usageError("run requires a command after --binding <name> -- <cmd> [args...]");
  }
  const { selected } = await selectBindings(options);
  const result = await resolveAll(options, selected);
  if (!result.allResolved) {
    process.stderr.write(
      `${JSON.stringify({
        contract: CONTRACT,
        ok: false,
        error: {
          code: "error",
          kind: "resolution_failed",
          message: "one or more bindings could not be resolved; command not started",
          bindings: result.reports,
        },
      })}\n`,
    );
    process.exit(1);
  }

  const [cmd, ...cmdRest] = cmdArgs as [string, ...string[]];
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  Object.assign(childEnv, result.env);

  const child = spawn(cmd, cmdRest, { env: childEnv, stdio: "inherit" });
  child.on("error", (err) => {
    process.stderr.write(
      `${JSON.stringify({
        contract: CONTRACT,
        ok: false,
        error: { code: "error", kind: "spawn_failed", message: err.message },
      })}\n`,
    );
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    if (signal !== null) {
      // Re-raise the signal so the exit status reflects the child's fate.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

// --- inject ----------------------------------------------------------------------

const SURFACES: readonly SurfaceKind[] = ["workspace", "tab", "pane"];

async function cmdInject(options: CliOptions): Promise<void> {
  if (options.surface === undefined || options.surface === "") {
    usageError("inject requires --surface <workspace|tab|pane>");
  }
  if (!SURFACES.includes(options.surface as SurfaceKind)) {
    usageError(
      `unknown surface ${JSON.stringify(options.surface)}; expected one of ${SURFACES.join(", ")}`,
    );
  }
  const surface = options.surface as SurfaceKind;
  if (
    surface === "pane" &&
    options.direction !== undefined &&
    options.direction !== "right" &&
    options.direction !== "down"
  ) {
    usageError("--direction must be right or down");
  }

  const { selected } = await selectBindings(options);
  const result = await resolveAll(options, selected);
  if (!result.allResolved) {
    process.stderr.write(
      `${JSON.stringify({
        contract: CONTRACT,
        ok: false,
        error: {
          code: "error",
          kind: "resolution_failed",
          message: "one or more bindings could not be resolved; surface not created",
          bindings: result.reports,
        },
      })}\n`,
    );
    process.exit(1);
  }

  const params: InjectParams = { surface };
  if (options.direction !== undefined) params.direction = options.direction as "right" | "down";
  if (options.targetPane !== undefined) params.targetPaneId = options.targetPane;
  if (options.workspace !== undefined) params.workspaceId = options.workspace;
  if (options.cwd !== undefined) params.cwd = options.cwd;
  if (options.label !== undefined) params.label = options.label;
  if (options.focus) params.focus = true;
  if (options.ratio !== undefined) params.ratio = options.ratio;

  try {
    const injected = await injectEnv(result.env, params, callOptions(options));
    emit({
      contract: CONTRACT,
      command: "inject",
      plugin: PLUGIN_ID,
      ok: true,
      bindings: result.reports,
      injected: {
        surface: injected.surface,
        ...(injected.pane_id !== undefined ? { pane_id: injected.pane_id } : {}),
        ...(injected.tab_id !== undefined ? { tab_id: injected.tab_id } : {}),
        ...(injected.workspace_id !== undefined ? { workspace_id: injected.workspace_id } : {}),
        env_names: injected.env_names,
      },
      generated_at: now(),
    });
  } catch (err) {
    const kind = err instanceof SecretsError ? err.kind : undefined;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${JSON.stringify({
        contract: CONTRACT,
        ok: false,
        error: { code: "error", ...(kind !== undefined ? { kind } : {}), message },
      })}\n`,
    );
    process.exit(1);
  }
}

// --- config ------------------------------------------------------------------------

async function cmdConfig(options: CliOptions): Promise<void> {
  if (options.init) {
    const file = await writeInitialConfig(options.configDir);
    emit({
      contract: CONTRACT,
      command: "config",
      ok: true,
      action: "init",
      file,
      note: "edit bindings under the 'bindings' array; see docs/specs/secrets.md",
    });
    return;
  }
  const { config, invalidBindings, warnings } = await loadConfig(options.configDir);
  emit({
    contract: CONTRACT,
    command: "config",
    ok: true,
    file: configFilePath(options.configDir),
    // Metadata only: binding refs and env names are declarations, never
    // secret values.
    config: {
      infisical: {
        domain: config.infisical.domain,
        ...(config.infisical.projectId !== undefined
          ? { projectId: config.infisical.projectId }
          : {}),
        ...(config.infisical.tokenEnv !== undefined ? { tokenEnv: config.infisical.tokenEnv } : {}),
      },
      bindings: config.bindings.map((b) => ({
        name: b.name,
        env: b.env,
        ref: b.ref,
        ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
      })),
    },
    invalid_bindings: invalidBindings,
    warnings,
    generated_at: now(),
  });
}

// --- entry -------------------------------------------------------------------------

const USAGE = `rebuildup.secrets — herdr-plugins.secrets/v1 (ADR-0027)

Usage:
  bun run src/cli.ts capability [--probe] [--infisical-bin <path>]
  bun run src/cli.ts resolve  --binding <name>... [--config-dir <dir>]
  bun run src/cli.ts run      --binding <name>... -- <cmd> [args...]
  bun run src/cli.ts inject   --binding <name>... --surface <workspace|tab|pane>
                              [--workspace <id>] [--target-pane <id>]
                              [--direction right|down] [--cwd <dir>]
                              [--label <text>] [--focus] [--ratio <n>]
  bun run src/cli.ts config   [--init] [--config-dir <dir>]

Common: --session <name> --socket <path> --timeout <ms>
Secret values are never printed or persisted; resolve reports status only.
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "capability":
      await cmdCapability(options);
      return;
    case "resolve":
      await cmdResolve(options);
      return;
    case "run":
      await cmdRun(options);
      return;
    case "inject":
      await cmdInject(options);
      return;
    case "config":
      await cmdConfig(options);
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      usageError(`unknown command ${JSON.stringify(options.command)}`);
  }
}

main().catch((err) => {
  const kind = err instanceof SecretsError ? err.kind : undefined;
  fail(err instanceof Error ? err.message : String(err), 1, kind);
});
