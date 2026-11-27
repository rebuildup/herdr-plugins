/**
 * Saved-machine transport for `rebuildup.machines` (#161, ADR-0028).
 *
 * Read-only probe path, deliberately minimal and self-contained (ADR-0028
 * §2: handoff's `remote.ts` is execution-shaped; no `packages/`
 * extraction until a second real consumer justifies it):
 *
 * - `herdr machine list --json` enumerates saved machines.
 * - `herdr --machine <id> api snapshot` proves reachability and yields
 *   remote `version` / `protocol`.
 * - `herdr --machine <id> plugin list --json` enumerates the remote
 *   plugin surface (`plugin.list` is an API method — verified live on
 *   herdr 0.9.5 / protocol 22; older remotes may lack it and report
 *   `plugin_surface: "unsupported"` honestly).
 *
 * Every call is a stateless CLI spawn with a timeout; ambient `HERDR_*`
 * env is stripped from children (ADR-0020 rule 1). No credential
 * material is read or stored — SSH auth is OpenSSH-owned.
 */

import { spawn } from "node:child_process";
import { CONTRACT, type MachineEntry, type MachineProbe, type RemotePluginEntry } from "./model";

// --- Errors -----------------------------------------------------------------

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// --- Process runner (injectable for tests) ------------------------------------

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the runner killed the child at its timeout. */
  timedOut: boolean;
}

/**
 * Explicit local-herdr target parsed from `--socket PATH` / `--session
 * NAME` CLI flags. The `herdr` CLI has no target flags of its own — the
 * equivalent knobs are the `HERDR_SOCKET_PATH` / `HERDR_SESSION` env
 * vars (upstream precedence `HERDR_SOCKET_PATH` > `HERDR_SESSION` >
 * default), which `spawnHerdr` injects into each child.
 */
export interface HerdrTarget {
  socketPath?: string;
  session?: string;
}

export type HerdrRunner = (
  args: string[],
  options: { timeoutMs: number; target?: HerdrTarget | undefined },
) => Promise<RunResult>;

/** Ambient herdr vars that must never leak into remote CLI children. */
const STRIPPED_ENV = new Set([
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_SESSION",
]);

/** Default `herdr` binary; HERDR_BIN_PATH overrides (test/dev hook). */
export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/**
 * Environment for a spawned `herdr` CLI child: ambient `HERDR_*`
 * context stripped (ADR-0020 rule 1), then explicit `--socket` /
 * `--session` flags re-injected as `HERDR_SOCKET_PATH` / `HERDR_SESSION`
 * — the flag > env > default resolution order. When both flags are
 * given both vars are set and herdr's own precedence
 * (`HERDR_SOCKET_PATH` > `HERDR_SESSION`) applies.
 */
export function herdrChildEnv(target?: HerdrTarget): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || STRIPPED_ENV.has(key)) continue;
    env[key] = value;
  }
  if (target?.socketPath !== undefined) {
    env.HERDR_SOCKET_PATH = target.socketPath;
  }
  if (target?.session !== undefined) {
    env.HERDR_SESSION = target.session;
  }
  return env;
}

/**
 * Spawn the local `herdr` CLI. Each remote call is a fresh process: the
 * `--machine` bridge lifetime is bound to the CLI invocation upstream.
 */
export const spawnHerdr: HerdrRunner = (args, options) =>
  new Promise((resolve) => {
    const env = herdrChildEnv(options.target);
    const child = spawn(herdrBin(), args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: null, stdout, stderr: `${stderr}${String(err)}`, timedOut });
    });
    child.on("close", (code, signal) => {
      // Node reports SIGTERM kills via `signal`; treat as timeout when the
      // runner's own timeout fired (spawn `timeout` sends SIGTERM).
      timedOut = signal === "SIGTERM";
      resolve({ code, stdout, stderr, timedOut });
    });
  });

// --- Envelope parsing ---------------------------------------------------------

interface CliEnvelope {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/** Extract the last JSON envelope line from stdout (or stderr for errors). */
function parseEnvelope(run: RunResult): CliEnvelope {
  for (const text of [run.stdout, run.stderr]) {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{") && l.endsWith("}"));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i] as string) as CliEnvelope;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          ("result" in parsed || "error" in parsed)
        ) {
          return parsed;
        }
      } catch {
        /* not JSON */
      }
    }
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Run a remote CLI command and return its `result` payload. Throws
 * RemoteError on transport failure, nonzero exit, or an `{error}`
 * envelope — the remote server's own error code/message is preserved.
 */
async function runRemote(
  runner: HerdrRunner,
  selector: string,
  cliArgs: string[],
  timeoutMs: number,
  target?: HerdrTarget,
): Promise<unknown> {
  const args = ["--machine", selector, ...cliArgs];
  const run = await runner(args, { timeoutMs, target });
  if (run.timedOut) {
    throw new RemoteError(
      `herdr --machine ${selector} ${cliArgs.join(" ")} timed out after ${timeoutMs}ms`,
      "remote_timeout",
      { args },
    );
  }
  const envelope = parseEnvelope(run);
  if (envelope.error !== undefined) {
    const code = typeof envelope.error.code === "string" ? envelope.error.code : "remote_error";
    const message =
      typeof envelope.error.message === "string" ? envelope.error.message : "remote command failed";
    throw new RemoteError(`${code}: ${message}`, `remote_${code}`, { code, message });
  }
  if (run.code !== 0) {
    const detail = (run.stderr || run.stdout).trim().slice(0, 400);
    throw new RemoteError(
      `herdr --machine ${selector} exited ${run.code ?? "?"}: ${detail || "no output"}`,
      "remote_command_failed",
      { exit_code: run.code, stderr: run.stderr.slice(0, 2000) },
    );
  }
  if (!("result" in envelope)) {
    throw new RemoteError(
      `herdr --machine ${selector} returned no result envelope: ${(run.stdout || run.stderr).slice(0, 300)}`,
      "remote_malformed",
    );
  }
  return envelope.result;
}

// --- Saved machines ------------------------------------------------------------

export const DEFAULT_CALL_TIMEOUT_MS = 45_000;

/**
 * Enumerate saved machines via `herdr machine list --json`. Throws
 * RemoteError(`machine_list_failed`) on any failure — an inventory that
 * cannot enumerate must fail honestly, never return a partial guess.
 */
export async function listMachines(
  runner: HerdrRunner = spawnHerdr,
  target?: HerdrTarget,
): Promise<MachineEntry[]> {
  const run = await runner(["machine", "list", "--json"], {
    timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    target,
  });
  if (run.code !== 0) {
    throw new RemoteError(
      `herdr machine list failed: ${(run.stderr || run.stdout).trim().slice(0, 300)}`,
      "machine_list_failed",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new RemoteError(
      "herdr machine list --json returned non-JSON output",
      "machine_list_failed",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new RemoteError("herdr machine list --json returned a non-array", "machine_list_failed");
  }
  const machines: MachineEntry[] = [];
  for (const entry of parsed) {
    const e = asRecord(entry);
    if (typeof e.id !== "string" || typeof e.target !== "string") continue;
    machines.push({
      id: e.id,
      label: typeof e.label === "string" ? e.label : e.id,
      target: e.target,
      session: typeof e.session === "string" ? e.session : "default",
      enabled: e.enabled !== false,
      selected: typeof e.selected === "boolean" ? e.selected : null,
    });
  }
  return machines;
}

/**
 * Resolve a probe selector (machine id or label) against the saved
 * machine list. Labels match case-insensitively; ids match exactly.
 * Ambiguity and unknown selectors are usage errors (exit 2 upstream).
 */
export function resolveMachine(selector: string, machines: MachineEntry[]): MachineEntry {
  const byId = machines.find((m) => m.id === selector);
  if (byId !== undefined) return byId;
  const lower = selector.toLowerCase();
  const byLabel = machines.filter((m) => m.label.toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0] as MachineEntry;
  if (byLabel.length > 1) {
    throw new RemoteError(
      `machine selector "${selector}" matches multiple machines; use the machine id`,
      "machine_ambiguous",
      { matches: byLabel.map((m) => m.id) },
    );
  }
  throw new RemoteError(`unknown machine "${selector}"`, "machine_not_found", {
    selector,
  });
}

// --- Probe ---------------------------------------------------------------------

function probeShell(
  machine: MachineEntry,
  state: MachineProbe["state"],
  probedAt: string,
): MachineProbe {
  return {
    contract: CONTRACT,
    machine_id: machine.id,
    state,
    probed_at: probedAt,
    reachable: state === "ok" ? true : state === "disabled" ? null : false,
    server_version: null,
    protocol: null,
    plugin_surface: "unknown",
    plugins: null,
    plugin_surface_error: null,
    error_kind: null,
    error: null,
  };
}

function failProbe(
  machine: MachineEntry,
  probedAt: string,
  state: MachineProbe["state"],
  kind: string,
  message: string,
): MachineProbe {
  const probe = probeShell(machine, state, probedAt);
  probe.error_kind = kind;
  probe.error = message;
  return probe;
}

/**
 * Classify a remote `api snapshot` failure into an honest probe state.
 * Mirrors handoff's remote.ts taxonomy (ADR-0020): bridge-less remotes
 * are `unsupported_remote`, transport/exit failures are `unreachable`,
 * everything else is `error`.
 */
function classifySnapshotError(machine: MachineEntry, err: unknown): MachineProbe {
  const probedAt = new Date().toISOString();
  if (err instanceof RemoteError) {
    if (/remote-api-bridge|machine API forwarding|does not support/i.test(err.message)) {
      return failProbe(
        machine,
        probedAt,
        "unsupported_remote",
        err.kind,
        `remote machine "${machine.label}" runs a herdr without machine API forwarding (needs remote-api-bridge); upgrade herdr on ${machine.target}`,
      );
    }
    if (err.kind === "remote_command_failed" || err.kind === "remote_timeout") {
      return failProbe(
        machine,
        probedAt,
        "unreachable",
        err.kind,
        `remote machine "${machine.label}" (${machine.target}) unreachable: ${err.message}`,
      );
    }
    return failProbe(machine, probedAt, "error", err.kind, err.message);
  }
  return failProbe(
    machine,
    probedAt,
    "error",
    "unknown",
    err instanceof Error ? err.message : String(err),
  );
}

/** Parse remote `plugin list --json` result into contract entries. */
function parsePluginEntries(result: unknown): RemotePluginEntry[] {
  const record = asRecord(result);
  const raw = Array.isArray(record.plugins) ? record.plugins : [];
  const entries: RemotePluginEntry[] = [];
  for (const item of raw) {
    const e = asRecord(item);
    const id =
      typeof e.plugin_id === "string" ? e.plugin_id : typeof e.id === "string" ? e.id : null;
    if (id === null) continue;
    entries.push({
      id,
      name: typeof e.name === "string" ? e.name : null,
      version: typeof e.version === "string" ? e.version : null,
    });
  }
  return entries;
}

/**
 * Probe the remote plugin surface after a successful snapshot. Any
 * failure degrades to `plugin_surface: "unsupported"` with the detail
 * preserved — never a fabricated inventory (ADR-0028 §4/§5).
 */
async function probePluginSurface(
  runner: HerdrRunner,
  machine: MachineEntry,
  probe: MachineProbe,
  target?: HerdrTarget,
): Promise<void> {
  try {
    const result = await runRemote(
      runner,
      machine.id,
      ["plugin", "list", "--json"],
      DEFAULT_CALL_TIMEOUT_MS,
      target,
    );
    const record = asRecord(result);
    if (!Array.isArray(record.plugins)) {
      probe.plugin_surface = "unsupported";
      probe.plugin_surface_error = `remote plugin list returned no plugins array: ${JSON.stringify(result).slice(0, 200)}`;
      return;
    }
    probe.plugin_surface = "supported";
    probe.plugins = parsePluginEntries(result);
  } catch (err) {
    probe.plugin_surface = "unsupported";
    probe.plugin_surface_error = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Probe one saved machine: resolve nothing here (callers resolve), check
 * `enabled`, then `api snapshot` + `plugin list` over the SSH bridge.
 * Always returns a MachineProbe — failures are data, not exceptions
 * (except selector resolution, which stays a usage error).
 */
export async function probeMachineEntry(
  machine: MachineEntry,
  deps: { runner?: HerdrRunner; target?: HerdrTarget | undefined } = {},
): Promise<MachineProbe> {
  const runner = deps.runner ?? spawnHerdr;
  const target = deps.target;
  const probedAt = new Date().toISOString();
  if (!machine.enabled) {
    return probeShell(machine, "disabled", probedAt);
  }

  let result: unknown;
  try {
    result = await runRemote(
      runner,
      machine.id,
      ["api", "snapshot"],
      DEFAULT_CALL_TIMEOUT_MS,
      target,
    );
  } catch (err) {
    return classifySnapshotError(machine, err);
  }

  const record = asRecord(result);
  const rawSnapshot = asRecord(record.snapshot ?? result);
  const probe = probeShell(machine, "ok", probedAt);
  probe.server_version = typeof rawSnapshot.version === "string" ? rawSnapshot.version : null;
  probe.protocol = typeof rawSnapshot.protocol === "number" ? rawSnapshot.protocol : null;

  await probePluginSurface(runner, machine, probe, target);
  return probe;
}

/**
 * Probe a selector (id or label) against the saved machine list.
 * Throws RemoteError for `machine_not_found` / `machine_ambiguous` /
 * `machine_list_failed`; all probe outcomes are returned as data.
 */
export async function probeMachine(
  selector: string,
  deps: { runner?: HerdrRunner; machines?: MachineEntry[]; target?: HerdrTarget | undefined } = {},
): Promise<MachineProbe> {
  const runner = deps.runner ?? spawnHerdr;
  const target = deps.target;
  const machines = deps.machines ?? (await listMachines(runner, target));
  const machine = resolveMachine(selector, machines);
  return probeMachineEntry(machine, { runner, target });
}

/**
 * Probe every saved machine sequentially — each probe re-opens the SSH
 * bridge per call, so parallelism would multiply connection churn for
 * no correctness gain.
 */
export async function probeAllMachines(
  deps: { runner?: HerdrRunner; machines?: MachineEntry[]; target?: HerdrTarget | undefined } = {},
): Promise<MachineProbe[]> {
  const runner = deps.runner ?? spawnHerdr;
  const target = deps.target;
  const machines = deps.machines ?? (await listMachines(runner, target));
  const probes: MachineProbe[] = [];
  for (const machine of machines) {
    probes.push(await probeMachineEntry(machine, { runner, target }));
  }
  return probes;
}
