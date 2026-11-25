/**
 * rebuildup.automations CLI — versioned structured interface
 * (`herdr-plugins.automations/v1`, DRAFT per Issue #137/#144).
 *
 * T2 (#144): task registry core — schedule model (interval /
 * fixed_time / once; webhook/event schema-reserved →
 * `unsupported_schedule`), CRUD (`create`/`list`/`get`/`update`/
 * `set-enabled`/`delete`), manual runs (`run-now`/`runs`), lazy
 * missed-run derivation on reads, and `reconcile` materialization.
 * Firing (`fire`/`tick`/`watch`/`schedule`) and delivery land in #145;
 * event schedules in #146; webhook in #147.
 *
 * Output contract (same shape as other plugins): one JSON document on
 * stdout for success, one JSON error object on stderr, exit 0 / 1 /
 * 2 (usage). The plugin holds no clock and no daemon — every command
 * takes the wall clock at invocation; occurrence math is deterministic
 * (ADR-0022).
 */

import {
  AutomationsError,
  CONTRACT,
  type MisfirePolicy,
  PLUGIN_ID,
  RUN_STATUSES,
  type RunStatus,
} from "./model";
import {
  createTask,
  deleteTask,
  listRuns,
  listTaskViews,
  materializeMissed,
  runNow,
  setTaskEnabled,
  taskView,
  updateTask,
} from "./registry";
import {
  type AutomationsState,
  loadState,
  type SessionRegistry,
  sessionKeyFor,
  sessionRegistry,
  updateState,
} from "./state";

export { CONTRACT, PLUGIN_ID };
export const PLUGIN_VERSION = "0.2.0";

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
    commands: [
      "capability",
      "create",
      "list",
      "get",
      "update",
      "set-enabled",
      "delete",
      "run-now",
      "runs",
      "reconcile",
    ],
    planned_commands: ["fire", "tick", "watch", "schedule", "hook", "serve"],
    schedules: ["interval", "fixed_time", "once"],
    reserved_schedules: ["webhook", "event"],
    state_file: "state.json",
  };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  command: string;
  args: string[];
  session: string | undefined;
  socketPath: string | undefined;
  timeoutMs: number | undefined;
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
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--session") {
      options.session = args[++i];
    } else if (arg === "--socket") {
      options.socketPath = args[++i];
    } else if (arg === "--timeout") {
      const value = Number(args[++i]);
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else {
      rest.push(arg);
    }
  }
  options.args = rest;
  return options;
}

class UsageError extends Error {}

function takeFlag(args: string[], name: string): { value: string | undefined; rest: string[] } {
  const idx = args.indexOf(name);
  if (idx === -1) return { value: undefined, rest: args };
  const value = args[idx + 1];
  if (value === undefined) throw new UsageError(`${name} requires a value`);
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, rest };
}

function hasFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(name);
  if (idx === -1) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

function parseJsonFlag(value: string | undefined, field: string): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`${field} must be a valid JSON value`);
  }
}

function parseMisfireFlag(value: string | undefined): MisfirePolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "skip" || value === "run_once") return value;
  throw new UsageError("--misfire must be 'skip' or 'run_once'");
}

function parseBoolFlag(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new UsageError(`${field} must be true|false`);
}

function parsePositiveInt(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${field} must be a positive integer`);
  return n;
}

function requireTaskId(args: string[], command: string): { taskId: string; rest: string[] } {
  const taskId = args[0];
  if (taskId === undefined || taskId.startsWith("--")) {
    throw new UsageError(`${command} requires a task_id argument`);
  }
  return { taskId, rest: args.slice(1) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ contract: CONTRACT, ok: true, ...payload }, null, 2)}\n`,
  );
}

function emitError(code: string, message: string, taskId?: string): never {
  const error: Record<string, unknown> = { code, message };
  if (taskId !== undefined) error.task_id = taskId;
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code === "usage" ? 2 : 1);
}

function usage(message: string): never {
  emitError("usage", message);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdCreate(options: CliOptions): Promise<void> {
  let args = options.args;
  const name = takeFlag(args, "--name");
  args = name.rest;
  const prompt = takeFlag(args, "--prompt");
  args = prompt.rest;
  const schedule = takeFlag(args, "--schedule");
  args = schedule.rest;
  const destination = takeFlag(args, "--destination");
  args = destination.rest;
  const misfire = takeFlag(args, "--misfire");
  args = misfire.rest;
  const enabled = takeFlag(args, "--enabled");
  args = enabled.rest;
  const createdBy = takeFlag(args, "--created-by");
  args = createdBy.rest;
  if (args.length > 0) usage(`create: unexpected argument '${args[0]}'`);
  if (
    name.value === undefined ||
    prompt.value === undefined ||
    schedule.value === undefined ||
    destination.value === undefined
  ) {
    usage("create requires --name, --prompt, --schedule <json>, --destination <json>");
  }
  const scheduleJson = parseJsonFlag(schedule.value, "--schedule");
  const destinationJson = parseJsonFlag(destination.value, "--destination");
  const nowMs = Date.now();
  const task = await updateState((state) =>
    createTask(
      // Session registry is created on demand inside the mutation.
      registryFor(state, options),
      {
        name: name.value as string,
        prompt: prompt.value as string,
        schedule: scheduleJson,
        destination: destinationJson,
        misfire: parseMisfireFlag(misfire.value),
        enabled: parseBoolFlag(enabled.value, "--enabled"),
        created_by: createdBy.value,
      },
      nowMs,
    ),
  );
  emit({ task: await taskViewFor(options, task.task_id, nowMs) });
}

function sessionKey(options: CliOptions): string {
  return sessionKeyFor({ session: options.session, socketPath: options.socketPath });
}

function registryFor(state: AutomationsState, options: CliOptions): SessionRegistry {
  return sessionRegistry(state, sessionKey(options));
}

async function taskViewFor(
  options: CliOptions,
  taskId: string,
  nowMs: number,
): Promise<ReturnType<typeof taskView>> {
  const state = await loadState();
  const registry = state.sessions[sessionKey(options)];
  if (!registry)
    throw new AutomationsError("task_not_found", `unknown task_id '${taskId}'`, taskId);
  return taskView(registry, taskId, nowMs);
}

async function cmdList(options: CliOptions): Promise<void> {
  let args = options.args;
  const enabled = takeFlag(args, "--enabled");
  args = enabled.rest;
  const limitFlag = takeFlag(args, "--limit");
  args = limitFlag.rest;
  if (args.length > 0) usage(`list: unexpected argument '${args[0]}'`);
  const enabledFilter = parseBoolFlag(enabled.value, "--enabled");
  const limit = parsePositiveInt(limitFlag.value, "--limit");
  const nowMs = Date.now();
  const state = await loadState();
  const registry = state.sessions[sessionKey(options)];
  let tasks = registry ? listTaskViews(registry, { enabled: enabledFilter, nowMs }) : [];
  if (limit !== undefined) tasks = tasks.slice(0, limit);
  emit({ tasks });
}

async function cmdGet(options: CliOptions): Promise<void> {
  const { taskId, rest } = requireTaskId(options.args, "get");
  if (rest.length > 0) usage(`get: unexpected argument '${rest[0]}'`);
  const nowMs = Date.now();
  emit({ task: await taskViewFor(options, taskId, nowMs) });
}

async function cmdUpdate(options: CliOptions): Promise<void> {
  const { taskId, rest } = requireTaskId(options.args, "update");
  let args = rest;
  const name = takeFlag(args, "--name");
  args = name.rest;
  const prompt = takeFlag(args, "--prompt");
  args = prompt.rest;
  const schedule = takeFlag(args, "--schedule");
  args = schedule.rest;
  const destination = takeFlag(args, "--destination");
  args = destination.rest;
  const misfire = takeFlag(args, "--misfire");
  args = misfire.rest;
  if (args.length > 0) usage(`update: unexpected argument '${args[0]}'`);
  if (
    name.value === undefined &&
    prompt.value === undefined &&
    schedule.value === undefined &&
    destination.value === undefined &&
    misfire.value === undefined
  ) {
    usage("update requires at least one of --name/--prompt/--schedule/--destination/--misfire");
  }
  const nowMs = Date.now();
  await updateState((state) =>
    updateTask(
      registryFor(state, options),
      taskId,
      {
        name: name.value,
        prompt: prompt.value,
        schedule: parseJsonFlag(schedule.value, "--schedule"),
        destination: parseJsonFlag(destination.value, "--destination"),
        misfire: parseMisfireFlag(misfire.value),
      },
      nowMs,
    ),
  );
  emit({ task: await taskViewFor(options, taskId, nowMs) });
}

async function cmdSetEnabled(options: CliOptions): Promise<void> {
  const { taskId, rest } = requireTaskId(options.args, "set-enabled");
  const value = rest[0];
  if (value === undefined || rest.length > 1) {
    usage("set-enabled requires <task_id> <true|false>");
  }
  const enabled = parseBoolFlag(value, "enabled");
  if (enabled === undefined) usage("set-enabled requires <true|false>");
  const nowMs = Date.now();
  await updateState((state) =>
    setTaskEnabled(registryFor(state, options), taskId, enabled as boolean, nowMs),
  );
  emit({ task: await taskViewFor(options, taskId, nowMs) });
}

async function cmdDelete(options: CliOptions): Promise<void> {
  const { taskId, rest } = requireTaskId(options.args, "delete");
  if (rest.length > 0) usage(`delete: unexpected argument '${rest[0]}'`);
  const result = await updateState((state) => deleteTask(registryFor(state, options), taskId));
  emit(result);
}

async function cmdRunNow(options: CliOptions): Promise<void> {
  const { taskId, rest } = requireTaskId(options.args, "run-now");
  if (rest.length > 0) usage(`run-now: unexpected argument '${rest[0]}'`);
  const nowMs = Date.now();
  const run = await updateState((state) => runNow(registryFor(state, options), taskId, nowMs));
  emit({ run });
}

async function cmdRuns(options: CliOptions): Promise<void> {
  let args = options.args;
  const task = takeFlag(args, "--task");
  args = task.rest;
  const status = takeFlag(args, "--status");
  args = status.rest;
  const limit = takeFlag(args, "--limit");
  args = limit.rest;
  const storedOnly = hasFlag(args, "--stored-only");
  args = storedOnly.rest;
  if (args.length > 0) usage(`runs: unexpected argument '${args[0]}'`);
  let statusFilter: RunStatus | undefined;
  if (status.value !== undefined) {
    if (!(RUN_STATUSES as readonly string[]).includes(status.value)) {
      usage(`runs: --status must be one of ${RUN_STATUSES.join("|")}`);
    }
    statusFilter = status.value as RunStatus;
  }
  const nowMs = Date.now();
  const state = await loadState();
  const registry = state.sessions[sessionKey(options)];
  const runs = registry
    ? listRuns(registry, {
        taskId: task.value,
        status: statusFilter,
        includeMissed: !storedOnly.present,
        limit: parsePositiveInt(limit.value, "--limit"),
        nowMs,
      })
    : [];
  emit({ runs });
}

async function cmdReconcile(options: CliOptions): Promise<void> {
  let args = options.args;
  const task = takeFlag(args, "--task");
  args = task.rest;
  if (args.length > 0) usage(`reconcile: unexpected argument '${args[0]}'`);
  const nowMs = Date.now();
  const written = await updateState((state) =>
    materializeMissed(registryFor(state, options), { taskId: task.value, nowMs }),
  );
  emit({ materialized: written });
}

async function cmdCapability(): Promise<void> {
  // Discovery document keeps the T1 shape: the bare document, no
  // ok-envelope (same as other plugins' capability output).
  process.stdout.write(`${JSON.stringify(capabilityDocument(), null, 2)}\n`);
}

function helpText(): string {
  return (
    "rebuildup.automations — scheduled agent runs (contract herdr-plugins.automations/v1, draft)\n" +
    "commands:\n" +
    "  capability\n" +
    "  create --name N --prompt P --schedule '<json>' --destination '<json>' [--misfire skip|run_once] [--enabled true|false] [--created-by cli]\n" +
    "  list [--enabled true|false] [--limit N]\n" +
    "  get <task_id>\n" +
    "  update <task_id> [--name N] [--prompt P] [--schedule '<json>'] [--destination '<json>'] [--misfire skip|run_once]\n" +
    "  set-enabled <task_id> <true|false>\n" +
    "  delete <task_id>\n" +
    "  run-now <task_id>\n" +
    "  runs [--task <task_id>] [--status S] [--limit N] [--stored-only]\n" +
    "  reconcile [--task <task_id>]\n" +
    "global flags: --session NAME --socket PATH --timeout MS\n" +
    "planned (#145-#147): fire/tick/watch/schedule/hook/serve\n" +
    "see docs/contracts/automations-v1.md and docs/specs/automations.md\n"
  );
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  try {
    switch (options.command) {
      case "capability":
      case "--capability":
        await cmdCapability();
        return;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(helpText());
        return;
      case "create":
        await cmdCreate(options);
        return;
      case "list":
        await cmdList(options);
        return;
      case "get":
        await cmdGet(options);
        return;
      case "update":
        await cmdUpdate(options);
        return;
      case "set-enabled":
        await cmdSetEnabled(options);
        return;
      case "delete":
        await cmdDelete(options);
        return;
      case "run-now":
        await cmdRunNow(options);
        return;
      case "runs":
        await cmdRuns(options);
        return;
      case "reconcile":
        await cmdReconcile(options);
        return;
      default:
        usage(
          `unknown command '${options.command}' — see 'help' (registry: create/list/get/update/set-enabled/delete/run-now/runs/reconcile)`,
        );
    }
  } catch (err) {
    if (err instanceof UsageError) usage(err.message);
    if (err instanceof AutomationsError) {
      emitError(err.code, err.message, err.taskId);
    }
    const message = err instanceof Error ? err.message : String(err);
    emitError("error", message);
  }
}

// Run only when executed directly (`bun run src/cli.ts …`), not on import.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
