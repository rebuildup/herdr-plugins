/**
 * rebuildup.artifacts CLI — artifact registry contract
 * (`herdr-plugins.artifacts/v1`, DRAFT) for agents and external
 * clients. Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * T1 (#136) ships the contract skeleton: `capability` reports the
 * draft contract, kinds, storage modes, and size caps; `help` prints
 * usage. Registry commands (register/list/get/search/verify/delete/
 * deliver/gc) are declared in the contract but return `contract_draft`
 * until T2–T4 (#141/#142/#143) implement them.
 *
 * The plugin never executes or renders artifact content (ADR-0022 §4);
 * render-time sandbox/CSP is a herdr-t3 requirement.
 */

import {
  ARTIFACT_ID_PATTERN,
  ARTIFACT_KINDS,
  CONTRACT,
  CONTRACT_STATUS,
  IMPLEMENTED_COMMANDS,
  MAX_BYTES,
  PLANNED_COMMANDS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  STORAGE_MODES,
} from "./model";

const USAGE =
  "bun run src/cli.ts <capability|help> — registry commands " +
  `${PLANNED_COMMANDS.join("|")} are contract_draft until #141/#142/#143`;

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

function now(): string {
  return new Date().toISOString();
}

function cmdCapability(): void {
  emit({
    contract: CONTRACT,
    contract_status: CONTRACT_STATUS,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    read_only: false,
    mutation_commands: ["register", "delete", "gc"],
    commands: [...IMPLEMENTED_COMMANDS, ...PLANNED_COMMANDS],
    implemented_commands: [...IMPLEMENTED_COMMANDS],
    planned_commands: [...PLANNED_COMMANDS],
    kinds: [...ARTIFACT_KINDS],
    storage_modes: [...STORAGE_MODES],
    artifact_id_pattern: ARTIFACT_ID_PATTERN.source,
    limits: {
      max_bytes: MAX_BYTES,
      path_ref_oversize: "warn",
    },
    notes: [
      "Contract is DRAFT (T1, Issue #136): only capability/help are implemented; registry commands return contract_draft until T2-T4 (#141/#142/#143).",
      "Plugin never executes or renders artifact content; render-time sandbox/CSP/network isolation is a herdr-t3 requirement (ADR-0022, docs/contracts/artifacts-v1.md).",
      "state_copy (default) enforces per-kind caps at register; path_ref records oversize as a warning flag and reports vanished targets as missing_ref.",
      "v1 attachment delivery is the artifact's stable absolute path inside agent.prompt/pane.send_text text; no structured attachment API exists in herdr protocol 22 (upstream gap candidate, ADR-0022).",
      "SnapShots (OS capture), browser import, and MCP Apps UI are out of plugin scope: herdr-t3/desktop or upstream-blocked on #30 (ADR-0022 section 5).",
    ],
    generated_at: now(),
  });
}

function main(): void {
  const command = process.argv[2];
  if (command === undefined) {
    fail(USAGE, 2);
  }
  switch (command) {
    case "capability":
      cmdCapability();
      return;
    case "help":
    case "--help":
    case "-h":
      emit({ contract: CONTRACT, plugin: PLUGIN_ID, version: PLUGIN_VERSION, usage: USAGE });
      return;
    default:
      if ((PLANNED_COMMANDS as readonly string[]).includes(command)) {
        fail(
          `command '${command}' is part of the draft contract but not implemented yet (T2-T4: #141/#142/#143)`,
          1,
          "contract_draft",
          { command },
        );
      }
      fail(`unknown command: ${command}`, 2);
  }
}

main();
