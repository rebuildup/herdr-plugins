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
import { listMachines, probeAllMachines, probeMachine, RemoteError } from "./remote";
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

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
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
      "bun run src/cli.ts <capability|help|list|probe> — " +
      "list [saved machines + last probe]; probe <machine-id|label|--all>",
  });
}

async function cmdList(): Promise<void> {
  const machines = await listMachines();
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
  const pos = positional(args);
  const all = args.includes("--all");
  if (all && pos.length > 0) {
    fail("probe accepts either <selector> or --all, not both", 2);
  }
  if (!all && pos.length !== 1) {
    fail("probe requires exactly one <machine-id|label> or --all", 2);
  }

  let probes: MachineProbe[];
  if (all) {
    probes = await probeAllMachines();
  } else {
    probes = [await probeMachine(pos[0] as string)];
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
      cmdCapability();
      return;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      return;
    case "list":
      if (args.length > 0 && args[0] !== "--help") {
        fail(`unexpected argument: ${args[0]}`, 2);
      }
      await cmdList();
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
