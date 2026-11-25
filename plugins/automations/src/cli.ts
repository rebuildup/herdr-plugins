/**
 * rebuildup.automations CLI — versioned structured interface
 * (`herdr-plugins.automations/v1`, DRAFT skeleton per Issue #137).
 *
 * T1 scaffold: `capability` discovery only. Task registry (#144),
 * firing drivers `tick`/`fire`/`watch`/`schedule` (#145), event hook
 * (#146), and webhook evaluation (#147) are implemented by the
 * downstream tickets against docs/contracts/automations-v1.md.
 *
 * Output contract (same shape as other plugins): one JSON document on
 * stdout for success, one JSON error object on stderr, exit 0 / 1 /
 * 2 (usage). The plugin holds no clock and no daemon — firing is
 * driven by external clocks calling `tick`/`fire` (ADR-0022).
 */

export const CONTRACT = "herdr-plugins.automations/v1";
export const PLUGIN_ID = "rebuildup.automations";
export const PLUGIN_VERSION = "0.1.0";

export interface CapabilityDocument {
  contract: string;
  plugin: string;
  version: string;
  contract_status: "draft";
  commands: string[];
  planned_commands: string[];
  schedules: string[];
  reserved_schedules: string[];
  state_file: string | null;
}

export function capabilityDocument(): CapabilityDocument {
  return {
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    contract_status: "draft",
    commands: ["capability"],
    planned_commands: [
      "create",
      "list",
      "get",
      "update",
      "set-enabled",
      "delete",
      "run-now",
      "runs",
      "fire",
      "tick",
      "watch",
      "schedule",
      "reconcile",
      "hook",
    ],
    schedules: ["interval", "fixed_time", "once"],
    reserved_schedules: ["webhook", "event"],
    state_file: null,
  };
}

function emitError(code: string, message: string): never {
  process.stderr.write(
    `${JSON.stringify({ contract: CONTRACT, ok: false, error: { code, message } })}\n`,
  );
  process.exit(code === "usage" ? 2 : 1);
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? "help";
  if (command === "capability" || command === "--capability") {
    process.stdout.write(`${JSON.stringify(capabilityDocument(), null, 2)}\n`);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(
      "rebuildup.automations — scheduled agent runs (contract herdr-plugins.automations/v1, draft)\n" +
        "commands: capability\n" +
        "planned: create/list/get/update/set-enabled/delete/run-now/runs/fire/tick/watch/schedule/reconcile/hook\n" +
        "see docs/contracts/automations-v1.md and docs/specs/automations.md\n",
    );
    return;
  }
  emitError(
    "usage",
    `unknown command '${command}' — only 'capability' is implemented in this scaffold (#137); ` +
      "registry and drivers land in #144/#145",
  );
}

// Run only when executed directly (`bun run src/cli.ts …`), not on import.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
