/**
 * rebuildup.machines CLI — read-only saved-machine inventory and probe
 * (contract `herdr-plugins.machines/v1`, issue #161, parent #34,
 * boundary ADR-0028).
 *
 * Commands:
 * - `capability` — machine-readable contract discovery (offline).
 * - `list` — saved machines from `herdr machine list --json` merged with
 *   last-known probe metadata from plugin state (`last_probe`, null when
 *   never probed). No live probing.
 * - `probe <selector|--all>` — live probe via `herdr --machine <id>`:
 *   remote `api snapshot` (reachability + version/protocol) and remote
 *   `plugin list` (plugin surface, honest `unsupported` fallback).
 *   Results are recorded to plugin state as last-known metadata.
 *
 * Every command accepts the shared target flags `--socket PATH` and
 * `--session NAME` selecting the LOCAL herdr instance (forwarded to
 * spawned `herdr` CLI children as HERDR_SOCKET_PATH / HERDR_SESSION —
 * the herdr CLI has no target flags of its own).
 *
 * Machine lifecycle (add/remove/enable/disable/reconnect) is never
 * reimplemented — mutations go through the herdr CLI. No credential
 * handling: SSH auth is OpenSSH-owned.
 *
 * All commands emit a single JSON document on stdout; diagnostics go to
 * stderr. Exit code 0 on success, 1 on handled errors, 2 on usage.
 */

import {
  CONTRACT,
  CONTRACT_STATUS,
  IMPLEMENTED_COMMANDS,
  type MachineProbe,
  PLUGIN_ID,
  PLUGIN_SURFACES,
  PLUGIN_VERSION,
  PROBE_STATES,
} from "./model";
import {
  type HerdrTarget,
  listMachines,
  probeAllMachines,
  probeMachine,
  RemoteError,
  spawnHerdr,
} from "./remote";
import { loadState, recordProbe, stateFilePath } from "./state";

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message: string, code = 1, kind?: string, extra?: Record<string, unknown>): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind !== undefined) error.kind = kind;
  if (extra !== undefined) Object.assign(error, extra);
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Parsed command arguments. `--socket PATH` / `--session NAME` are the
 * shared plugin target flags (contract: explicit flag > ambient env >
 * default); they select the LOCAL herdr instance whose saved machines
 * are listed/probed — unrelated to the remote `session` field on each
 * MachineEntry. Unknown arguments are usage errors (exit 2).
 */
interface ParsedArgs {
  target: HerdrTarget;
  positionals: string[];
  all: boolean;
}

function parseArgs(args: string[], opts: { allowAll?: boolean } = {}): ParsedArgs {
  const parsed: ParsedArgs = { target: {}, positionals: [], all: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--socket" || arg === "--session") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`option ${arg} requires a value`, 2);
      }
      i += 1;
      if (arg === "--socket") parsed.target.socketPath = value;
      else parsed.target.session = value;
    } else if (arg === "--all" && opts.allowAll === true) {
      parsed.all = true;
    } else if (arg === "--help" || arg === "-h") {
      cmdHelp();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      parsed.positionals.push(arg);
    } else {
      fail(`unknown argument: ${arg}`, 2);
    }
  }
  return parsed;
}

/** Target flags only; any leftover positional is a usage error. */
function parseTargetOnly(args: string[]): HerdrTarget {
  const parsed = parseArgs(args);
  if (parsed.positionals.length > 0) {
    fail(`unexpected argument: ${parsed.positionals[0]}`, 2);
  }
  return parsed.target;
}

function cmdCapability(): void {
  emit({
    contract: CONTRACT,
    contract_status: CONTRACT_STATUS,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    read_only: true,
    mutation_commands: [],
    commands: [...IMPLEMENTED_COMMANDS],
    implemented_commands: [...IMPLEMENTED_COMMANDS],
    probe_states: [...PROBE_STATES],
    plugin_surfaces: [...PLUGIN_SURFACES],
    transport: "herdr machine list --json + herdr --machine <id> <cli> (SavedSshApiBridge)",
    state_file: stateFilePath(),
    notes: [
      "Read-only inventory (ADR-0028): machine lifecycle — add/remove/rename/enable/disable/reconnect — is owned by the herdr CLI (`herdr machine …`); this plugin never mutates it.",
      "No credential handling: SSH keys/agent and machine auth are OpenSSH/herdr-owned; the plugin passes target strings to argv only and stores probe metadata (timestamps, versions, reachability) under HERDR_PLUGIN_STATE_DIR.",
      "probe performs remote `api snapshot` (reachability, server_version, protocol) then remote `plugin list --json` (plugin surface). Disabled machines report state=disabled without any SSH attempt; unreachable/bridge-less remotes report unreachable/unsupported_remote — success is never assumed.",
      "plugin_surface=unsupported means the remote answered api snapshot but `plugin list` failed or returned no usable result (older herdr without the plugin.list API method); upstream gap candidate recorded in ADR-0028.",
      "list merges live `herdr machine list --json` with last-known probe metadata (state.probes); it never probes live — run `probe` to refresh.",
      "Global flags --socket PATH / --session NAME select the local herdr target; the herdr CLI has no target flags, so they are forwarded to spawned children as HERDR_SOCKET_PATH / HERDR_SESSION (explicit flag beats ambient env).",
    ],
    generated_at: now(),
  });
}

function cmdHelp(): void {
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    usage:
      "bun run src/cli.ts <capability|help|list|probe> [--socket PATH] [--session NAME] — " +
      "list [saved machines + last probe]; probe <machine-id|label|--all>",
  });
}

async function cmdList(target: HerdrTarget): Promise<void> {
  const machines = await listMachines(spawnHerdr, target);
  const state = await loadState();
  const items = machines.map((machine) => ({
    machine,
    last_probe: state.probes[machine.id] ?? null,
  }));
  emit({
    contract: CONTRACT,
    command: "list",
    total: items.length,
    machines: items,
    state_file: stateFilePath(),
    generated_at: now(),
  });
}

async function cmdProbe(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { allowAll: true });
  const pos = parsed.positionals;
  if (parsed.all && pos.length > 0) {
    fail("probe accepts either <selector> or --all, not both", 2);
  }
  if (!parsed.all && pos.length !== 1) {
    fail("probe requires exactly one <machine-id|label> or --all", 2);
  }

  let probes: MachineProbe[];
  if (parsed.all) {
    probes = await probeAllMachines({ target: parsed.target });
  } else {
    probes = [await probeMachine(pos[0] as string, { target: parsed.target })];
  }

  // Persist last-known probe metadata (lock + atomic rename).
  for (const probe of probes) {
    await recordProbe(probe);
  }

  emit({
    contract: CONTRACT,
    command: "probe",
    total: probes.length,
    results: probes,
    state_file: stateFilePath(),
    generated_at: now(),
  });
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "capability":
      parseTargetOnly(args);
      cmdCapability();
      return;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      return;
    case "list":
      await cmdList(parseTargetOnly(args));
      return;
    case "probe":
      await cmdProbe(args);
      return;
    default:
      fail(`unknown command: ${command}`, 2);
  }
}

main().catch((err) => {
  if (err instanceof RemoteError) {
    const usageKinds = new Set(["machine_not_found", "machine_ambiguous"]);
    fail(err.message, usageKinds.has(err.kind) ? 2 : 1, err.kind, err.extra);
  }
  fail(err instanceof Error ? err.message : String(err), 1);
});
