/**
 * rebuildup.automations CLI — versioned structured interface
 * (`herdr-plugins.automations/v1`, DRAFT per Issue #137/#144).
 *
 * T2 (#144): task registry core — schedule model (interval /
 * fixed_time / once; webhook/event schema-reserved →
 * `unsupported_schedule`), CRUD (`create`/`list`/`get`/`update`/
 * `set-enabled`/`delete`), manual runs (`run-now`/`runs`), lazy
 * missed-run derivation on reads, and `reconcile` materialization.
 * T3 (#145): time-based firing — `fire`/`tick`/`watch` drivers and
 * `schedule install|uninstall|status` OS adapters (ADR-0022), run
 * delivery via `agent.prompt`/`agent.start` (ADR-0023), and honest
 * driver reporting. Event schedules land in #146; webhook in #147.
 *
 * Output contract (same shape as other plugins): one JSON document on
 * stdout for success, one JSON error object on stderr, exit 0 / 1 /
 * 2 (usage). The plugin holds no clock and no daemon — every command
 * takes the wall clock at invocation; occurrence math is deterministic
 * (ADR-0022).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSocketPath } from "../../../packages/herdr-client/src/socket";
import { deliverRun, herdrTransport } from "./execute";
import {
  AutomationsError,
  CONTRACT,
  type MisfirePolicy,
  nextOccurrenceAfter,
  PLUGIN_ID,
  RUN_STATUSES,
  type RunStatus,
} from "./model";
import {
  createTask,
  deleteTask,
  finalizeRun,
  listRuns,
  listTaskViews,
  materializeMissed,
  prepareFire,
  prepareTick,
  removeDriver,
  runNow,
  setTaskEnabled,
  startRun,
  taskView,
  updateTask,
  upsertDriver,
} from "./registry";
import {
  type AdapterResult,
  productionSchedulerDeps,
  type SchedulerAdapter,
  type ScheduleStatus,
  schedulerAdapterFor,
  type TickCommand,
} from "./scheduler";
import {
  type AutomationsState,
  loadState,
  type SessionRegistry,
  sessionKeyFor,
  sessionRegistry,
  updateState,
} from "./state";

export { CONTRACT, PLUGIN_ID };
export const PLUGIN_VERSION = "0.3.0";

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
      "fire",
      "tick",
      "watch",
      "schedule",
    ],
    planned_commands: ["hook", "serve"],
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

// ---------------------------------------------------------------------------
// Run execution plumbing (#145)
// ---------------------------------------------------------------------------

function transportFor(options: CliOptions) {
  const call: {
    session?: string;
    socketPath?: string;
    timeoutMs?: number;
  } = {};
  if (options.session !== undefined) call.session = options.session;
  if (options.socketPath !== undefined) call.socketPath = options.socketPath;
  if (options.timeoutMs !== undefined) call.timeoutMs = options.timeoutMs;
  return herdrTransport(call);
}

/**
 * Connectivity preflight (contract §Missed-run): an unreachable herdr
 * is a transport error — exit non-zero, NO run record fabricated; the
 * occurrence resolves as `missed` on the next read.
 */
async function preflightTransport(options: CliOptions): Promise<void> {
  try {
    await transportFor(options).sessionSnapshot();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitError("socket_unavailable", `herdr unreachable: ${message}`);
  }
}

interface DeliveryReport {
  run_id: string;
  task_id: string;
  status: string;
}

/**
 * Deliver a `running` run outside the state lock, then finalize the
 * record. Delivery failures are captured INTO the run (`failed` +
 * honest error) — they never escape as exceptions here.
 */
async function deliverAndFinalize(options: CliOptions, runId: string): Promise<DeliveryReport> {
  const transport = transportFor(options);
  // Fresh read: the task may have been updated between prepare and now.
  const state = await loadState();
  const registry = state.sessions[sessionKey(options)];
  const run = registry?.runs[runId];
  if (!registry || !run) {
    emitError("error", `run '${runId}' disappeared before delivery`);
  }
  const task = registry.tasks[run.task_id];
  if (!task) {
    emitError("task_not_found", `task '${run.task_id}' missing before delivery`, run.task_id);
  }
  const outcome = await deliverRun(task, run, transport);
  const finished = await updateState((s) =>
    finalizeRun(registryFor(s, options), runId, {
      status: outcome.status,
      finishedAtMs: Date.now(),
      result: outcome.result,
      error: outcome.error,
      destinationSnapshot: outcome.destinationSnapshot,
    }),
  );
  return { run_id: finished.run_id, task_id: finished.task_id, status: finished.status };
}

// ---------------------------------------------------------------------------
// fire / tick / watch / schedule (#145)
// ---------------------------------------------------------------------------

async function cmdFire(options: CliOptions): Promise<void> {
  const { taskId, rest } = requireTaskId(options.args, "fire");
  const scheduledFor = takeFlag(rest, "--scheduled-for");
  if (scheduledFor.rest.length > 0) usage(`fire: unexpected argument '${scheduledFor.rest[0]}'`);
  if (scheduledFor.value === undefined) usage("fire requires --scheduled-for <iso8601>");
  await preflightTransport(options);
  const nowMs = Date.now();
  const prep = await updateState((state) =>
    prepareFire(registryFor(state, options), taskId, scheduledFor.value as string, nowMs),
  );
  if (prep.action === "existing") {
    emit({ run: prep.run, deduplicated: true });
    return;
  }
  const delivered = await deliverAndFinalize(options, prep.run.run_id);
  emit({ run: delivered, deduplicated: false });
}

interface TickSummary {
  tasks_scanned: number;
  fired: DeliveryReport[];
  missed_materialized: number;
}

/** One tick pass: prepare under the lock, deliver each pending run. */
async function runTickOnce(options: CliOptions): Promise<TickSummary> {
  await preflightTransport(options);
  const nowMs = Date.now();
  const prep = await updateState((state) => prepareTick(registryFor(state, options), nowMs));
  const fired: DeliveryReport[] = [];
  for (const run of prep.pending) {
    fired.push(await deliverAndFinalize(options, run.run_id));
  }
  return {
    tasks_scanned: prep.tasksScanned,
    fired,
    missed_materialized: prep.missedMaterialized,
  };
}

async function cmdTick(options: CliOptions): Promise<void> {
  if (options.args.length > 0) usage(`tick: unexpected argument '${options.args[0]}'`);
  const summary = await runTickOnce(options);
  emit({ ...summary });
}

function emitLine(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Opt-in foreground driver (ADR-0022 §2): registers a `watch` driver
 * record (pid-checked by `driver.state`), then loops — each pass runs
 * the same `tick` logic as the OS entrypoint, sleeping until the next
 * due occurrence capped at `--interval` seconds (default 60, matching
 * the OS tick floor so registry changes are noticed promptly).
 * JSONL events on stdout; SIGINT/SIGTERM stop cleanly and remove the
 * driver record.
 */
async function cmdWatch(options: CliOptions): Promise<void> {
  let args = options.args;
  const intervalFlag = takeFlag(args, "--interval");
  args = intervalFlag.rest;
  if (args.length > 0) usage(`watch: unexpected argument '${args[0]}'`);
  const intervalSec = Number(intervalFlag.value ?? "60");
  const capMs = (Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 60) * 1000;

  await updateState((state) =>
    upsertDriver(registryFor(state, options), {
      contract: CONTRACT,
      driver_id: "watch",
      kind: "watch",
      status: "active",
      detail: `watch process pid ${process.pid}`,
      pid: process.pid,
      platform: process.platform,
      entry: null,
      installed_at: null,
      updated_at: new Date().toISOString(),
    }),
  );
  emitLine({
    contract: CONTRACT,
    type: "watch.started",
    pid: process.pid,
    interval_ms: capMs,
    at: new Date().toISOString(),
  });

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    for (;;) {
      if (stopping) break;
      try {
        const summary = await runTickOnce(options);
        emitLine({
          contract: CONTRACT,
          type: "watch.tick",
          ...summary,
          at: new Date().toISOString(),
        });
      } catch (err) {
        emitLine({
          contract: CONTRACT,
          type: "watch.error",
          error: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        });
      }
      if (stopping) break;
      // Sleep until the next due occurrence, capped at --interval so
      // newly created/edited tasks are noticed within one period.
      let sleepMs = capMs;
      try {
        const state = await loadState();
        const registry = state.sessions[sessionKey(options)];
        if (registry) {
          const now = Date.now();
          let nextDue = Number.POSITIVE_INFINITY;
          for (const task of Object.values(registry.tasks)) {
            if (!task.enabled) continue;
            const next = nextOccurrenceAfter(task, now);
            if (next !== null && next < nextDue) nextDue = next;
          }
          if (Number.isFinite(nextDue)) {
            sleepMs = Math.max(1_000, Math.min(nextDue - now, capMs));
          }
        }
      } catch {
        // State read failure → fall back to the cap interval.
      }
      // Refresh the driver heartbeat each loop.
      await updateState((state) =>
        upsertDriver(registryFor(state, options), {
          contract: CONTRACT,
          driver_id: "watch",
          kind: "watch",
          status: "active",
          detail: `watch process pid ${process.pid}`,
          pid: process.pid,
          platform: process.platform,
          entry: null,
          installed_at: null,
          updated_at: new Date().toISOString(),
        }),
      ).catch(() => {});
      await sleep(sleepMs);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      await updateState((state) => removeDriver(registryFor(state, options), "watch"));
    } catch {
      // Best-effort cleanup; a stale record reports honestly via pid check.
    }
    emitLine({
      contract: CONTRACT,
      type: "watch.stopped",
      reason: stopping ? "signal" : "error",
      at: new Date().toISOString(),
    });
  }
}

function tickCommandFor(options: CliOptions): TickCommand {
  return {
    bun: process.execPath,
    cli: fileURLToPath(import.meta.url),
    socketPath: path.resolve(options.socketPath ?? resolveSocketPath({ session: options.session })),
  };
}

function driverRecordFor(
  platform: string,
  entry: string | null,
  status: "installed" | "error" | "stale",
  detail: string,
): Parameters<typeof upsertDriver>[1] {
  return {
    contract: CONTRACT,
    driver_id: "os-scheduler",
    kind: "os-scheduler",
    status,
    detail,
    pid: null,
    platform,
    entry,
    installed_at: status === "installed" ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
}

async function cmdSchedule(options: CliOptions): Promise<void> {
  const sub = options.args[0];
  const rest = options.args.slice(1);
  if (sub === undefined || !["install", "uninstall", "status"].includes(sub)) {
    usage("schedule requires install|uninstall|status");
  }
  if (rest.length > 0) usage(`schedule ${sub}: unexpected argument '${rest[0]}'`);
  const adapter: SchedulerAdapter = schedulerAdapterFor(
    process.platform,
    productionSchedulerDeps(),
  );
  const entryLabel = "rebuildup.automations.tick";

  if (sub === "install") {
    const result: AdapterResult = await adapter.install(tickCommandFor(options));
    await updateState((state) =>
      upsertDriver(
        registryFor(state, options),
        driverRecordFor(
          adapter.platform,
          entryLabel,
          result.ok ? "installed" : "error",
          result.detail,
        ),
      ),
    );
    if (!result.ok) emitError("error", result.detail);
    emit({ driver: "os-scheduler", platform: adapter.platform, detail: result.detail });
    return;
  }
  if (sub === "uninstall") {
    const result = await adapter.uninstall();
    await updateState((state) => removeDriver(registryFor(state, options), "os-scheduler"));
    if (!result.ok) emitError("error", result.detail);
    emit({ driver: "os-scheduler", platform: adapter.platform, detail: result.detail });
    return;
  }
  // status
  const st = await adapter.status();
  const recordStatus =
    st.state === "installed" ? "installed" : st.state === "error" ? "error" : "stale";
  await updateState((state) =>
    upsertDriver(
      registryFor(state, options),
      driverRecordFor(adapter.platform, entryLabel, recordStatus, st.detail),
    ),
  );
  emit({
    schedule: { platform: adapter.platform, state: st.state as ScheduleStatus, detail: st.detail },
  });
}

async function cmdRunNow(options: CliOptions): Promise<void> {
  const { taskId, rest } = requireTaskId(options.args, "run-now");
  if (rest.length > 0) usage(`run-now: unexpected argument '${rest[0]}'`);
  await preflightTransport(options);
  const nowMs = Date.now();
  const run = await updateState((state) => runNow(registryFor(state, options), taskId, nowMs));
  await updateState((state) => startRun(registryFor(state, options), run.run_id, Date.now()));
  const delivered = await deliverAndFinalize(options, run.run_id);
  emit({ run: delivered });
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
    "  fire <task_id> --scheduled-for <iso8601>\n" +
    "  tick\n" +
    "  watch [--interval SEC]\n" +
    "  schedule install|uninstall|status\n" +
    "global flags: --session NAME --socket PATH --timeout MS\n" +
    "planned (#146/#147): hook/serve\n" +
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
      case "fire":
        await cmdFire(options);
        return;
      case "tick":
        await cmdTick(options);
        return;
      case "watch":
        await cmdWatch(options);
        return;
      case "schedule":
        await cmdSchedule(options);
        return;
      default:
        usage(
          `unknown command '${options.command}' — see 'help' (registry: create/list/get/update/set-enabled/delete/run-now/runs/reconcile; drivers: fire/tick/watch/schedule)`,
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
