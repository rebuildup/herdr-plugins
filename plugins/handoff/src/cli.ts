/**
 * rebuildup.handoff CLI — the versioned structured interface for the
 * handoff/delegation plugin (contract `herdr-plugins.handoff/v1`,
 * issues #103/#104/#105 / parent #6 T1–T3).
 *
 * T1 scope (#103): `create` records a handoff (source identity +
 * reference payload + strategy + optional target hint); `list`/`status`
 * enumerate and inspect records with honest staleness and missing_ref
 * reporting. T2 (#104) adds `execute` (same-host target surface creation
 * via herdr API + `agent.start` + payload prompt injection + status
 * transitions) and `resume-info` (provider native-resume capability).
 * T3 (#105) adds cross-machine execution: `execute --remote` /
 * `status --remote` over herdr saved machines (`herdr --machine` SSH
 * bridge) plus the portable bundle, and `remote-probe` for capability
 * detection.
 *
 * All commands emit a single JSON document on stdout; diagnostics go to
 * stderr. Exit code 0 on success, 1 on handled errors, 2 on usage.
 */

import os from "node:os";
import {
  type CallOptions,
  pluginDirs,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import {
  checkTarget,
  type ExecuteFlags,
  type ExecuteResult,
  executeHandoff,
  HandoffExecError,
  type HandoffTransport,
  herdrTransport,
  MAX_PROMPT_CHARS,
  reconcileDelivered,
  reconcileRemoteDelivered,
} from "./execute";
import {
  boundedExcerpt,
  buildTransferIdentity,
  CONTRACT,
  checkTransfer,
  createRecord,
  guessExternalTarget,
  HANDOFF_STATUSES,
  HANDOFF_STRATEGIES,
  type HandoffPayload,
  type HandoffStrategy,
  MAX_EXCERPT_CHARS,
  MAX_EXTERNAL_VALUE_CHARS,
  MAX_PAYLOAD_REFS,
  MAX_REQUIREMENT_CHARS,
  MAX_REQUIREMENTS,
  type PayloadRef,
  type TargetSpec,
} from "./model";
import { missingRefCount, type RefDeps, resolvePayloadRefs } from "./refs";
import {
  type HerdrRunner,
  listMachines,
  probeRemote,
  RemoteError,
  type RemoteProbe,
  remoteCliTransport,
  type SavedMachine,
} from "./remote";
import { listResumeProviders, resumeInfo } from "./resume";
import { loadState, PLUGIN_ID, sessionKeyFor, stateFilePath, updateState } from "./state";

interface CliOptions extends CallOptions {
  command: string;
  args: string[];
  session: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = { command, args, session: undefined };
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

/** Repeatable value flags: --name v1 --name v2. */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`missing value for ${name}`, 2);
      out.push(value as string);
      i += 1;
    }
  }
  return out;
}

function flagValue(args: string[], name: string): string | undefined {
  return flagValues(args, name)[0];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

const VALUE_FLAGS = new Set([
  "--strategy",
  "--provider",
  "--model",
  "--note",
  "--conversation",
  "--checkpoint",
  "--external",
  "--requirement",
  "--target-pane",
  "--target-workspace",
  "--wait-ms",
  "--status",
  "--limit",
  "--remote",
]);

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

async function snapshotOrNull(options: CliOptions): Promise<SessionSnapshot | null> {
  try {
    return await sessionSnapshot(options);
  } catch {
    return null;
  }
}

// --- create -------------------------------------------------------------------

function buildPayload(args: string[]): HandoffPayload {
  const refs: PayloadRef[] = [];
  for (const key of flagValues(args, "--conversation")) {
    refs.push({
      kind: "conversation_session",
      plugin: "rebuildup.conversations",
      session_key: key,
    });
  }
  for (const id of flagValues(args, "--checkpoint")) {
    refs.push({ kind: "checkpoint", plugin: "rebuildup.checkpoints", id });
  }
  for (const value of flagValues(args, "--external")) {
    if (value.length > MAX_EXTERNAL_VALUE_CHARS) {
      fail(`--external value exceeds ${MAX_EXTERNAL_VALUE_CHARS} chars`, 2);
    }
    refs.push({ kind: "external", target: guessExternalTarget(value), value });
  }
  if (refs.length > MAX_PAYLOAD_REFS) {
    fail(`payload exceeds ${MAX_PAYLOAD_REFS} refs`, 2);
  }

  const payload: HandoffPayload = { refs };

  const note = flagValue(args, "--note");
  if (note !== undefined) {
    if (note.length === 0) fail("--note must not be empty", 2);
    payload.excerpt = boundedExcerpt(note, "note");
  }

  const requirements = flagValues(args, "--requirement");
  if (requirements.length > 0) {
    if (requirements.length > MAX_REQUIREMENTS) {
      fail(`payload exceeds ${MAX_REQUIREMENTS} requirements`, 2);
    }
    payload.requirements = requirements.map((r) => {
      if (r.length > MAX_REQUIREMENT_CHARS) {
        fail(`requirement exceeds ${MAX_REQUIREMENT_CHARS} chars`, 2);
      }
      return r;
    });
  }
  return payload;
}

function buildTarget(args: string[]): TargetSpec | null {
  const target: TargetSpec = {};
  const paneId = flagValue(args, "--target-pane");
  const workspaceId = flagValue(args, "--target-workspace");
  const providerHint = flagValue(args, "--provider");
  if (paneId !== undefined) target.pane_id = paneId;
  if (workspaceId !== undefined) target.workspace_id = workspaceId;
  if (providerHint !== undefined) target.provider_hint = providerHint;
  return Object.keys(target).length > 0 ? target : null;
}

async function cmdCreate(options: CliOptions): Promise<void> {
  const pos = positional(options.args);
  if (pos.length !== 1) fail("create requires exactly one <pane_id>", 2);
  const paneId = pos[0] as string;

  const strategyRaw = flagValue(options.args, "--strategy") ?? "portable_context";
  if (!(HANDOFF_STRATEGIES as readonly string[]).includes(strategyRaw)) {
    fail(`invalid --strategy: ${strategyRaw} (one of ${HANDOFF_STRATEGIES.join(", ")})`, 2);
  }
  const strategy = strategyRaw as HandoffStrategy;

  // The source identity comes from the live snapshot — a handoff can only
  // be created against a pane herdr actually reports. Unreachable socket
  // is a hard error here (unlike `status`, which degrades honestly).
  const snapshot = await sessionSnapshot(options);
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
  if (!pane) fail(`pane not found in session snapshot: ${paneId}`);
  const agent = snapshot.agents?.[paneId];

  const keyFor = sessionKeyFor(options);
  const herdrSession =
    options.session ?? process.env.HERDR_SESSION ?? snapshot.session?.name ?? null;
  const transfer = buildTransferIdentity({
    host: os.hostname(),
    herdrSession: typeof herdrSession === "string" ? herdrSession : null,
    sessionKey: keyFor,
    pane,
    agent,
  });

  const payload = buildPayload(options.args);
  const target = buildTarget(options.args);
  const record = createRecord({ transfer, strategy, target: target ?? undefined, payload });

  if (hasFlag(options.args, "--dry-run")) {
    emit({
      contract: CONTRACT,
      command: "create",
      dry_run: true,
      handoff: record,
      excerpt_budget: { max_excerpt_chars: MAX_EXCERPT_CHARS },
    });
    return;
  }

  const pruned = await updateState((state) => {
    state.handoffs[record.id] = record;
    return Object.keys(state.handoffs).length;
  });
  void pruned;

  emit({
    contract: CONTRACT,
    command: "create",
    dry_run: false,
    handoff: record,
    state_file: stateFilePath(),
  });
}

// --- list ---------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

async function cmdList(options: CliOptions): Promise<void> {
  const statusFilter = flagValue(options.args, "--status");
  if (
    statusFilter !== undefined &&
    !(HANDOFF_STATUSES as readonly string[]).includes(statusFilter)
  ) {
    fail(`invalid --status: ${statusFilter} (one of ${HANDOFF_STATUSES.join(", ")})`, 2);
  }
  const limitRaw = flagValue(options.args, "--limit");
  let limit = DEFAULT_LIST_LIMIT;
  if (limitRaw !== undefined) {
    const value = Number(limitRaw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
      fail(`invalid --limit: ${limitRaw}`, 2);
    }
    limit = value;
  }

  const state = await loadState();
  const snapshot = await snapshotOrNull(options);
  const currentKey = snapshot !== null ? sessionKeyFor(options) : null;

  let records = Object.values(state.handoffs).sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  const total = records.length;
  if (statusFilter !== undefined) {
    records = records.filter((r) => r.status === statusFilter);
  }
  const page = records.slice(0, limit);

  const items = page.map((record) => ({
    id: record.id,
    status: record.status,
    strategy: record.strategy,
    created_at: record.created_at,
    updated_at: record.updated_at,
    transfer: {
      host: record.transfer.host,
      herdr_session: record.transfer.herdr_session,
      workspace_id: record.transfer.workspace_id,
      tab_id: record.transfer.tab_id,
      pane_id: record.transfer.pane_id,
      provider_kind: record.transfer.provider_kind,
      agent_session: record.transfer.agent_session,
      state_change_seq: record.transfer.state_change_seq,
    },
    target: record.target,
    target_pane_id: record.execution?.target?.pane_id ?? null,
    ref_count: record.payload.refs.length,
    has_excerpt: record.payload.excerpt !== undefined,
    // Staleness is only meaningful against the record's own session
    // snapshot; foreign-session records are reported unchecked, never
    // guessed (pane ids repeat across sessions).
    transfer_check: checkTransfer(record, snapshot, currentKey ?? undefined),
  }));

  emit({
    contract: CONTRACT,
    command: "list",
    total,
    count: items.length,
    truncated: records.length > items.length,
    items,
    state_file: stateFilePath(),
    generated_at: new Date().toISOString(),
  });
}

// --- status -------------------------------------------------------------------

interface RemoteDeps {
  probe?: ((selector: string) => Promise<RemoteProbe>) | undefined;
  transportFor?: ((probe: RemoteProbe) => HandoffTransport) | undefined;
  machines?: (() => Promise<SavedMachine[]>) | undefined;
}

function remoteErrorExit(err: unknown): never {
  if (err instanceof RemoteError) {
    const usageKinds = new Set(["machine_not_found", "machine_ambiguous"]);
    fail(err.message, usageKinds.has(err.kind) ? 2 : 1, err.kind, err.extra);
  }
  throw err;
}

async function cmdStatus(options: CliOptions, deps: RefDeps & RemoteDeps = {}): Promise<void> {
  const pos = positional(options.args);
  if (pos.length !== 1) fail("status requires exactly one <handoff-id>", 2);
  const id = pos[0] as string;

  let state = await loadState();
  let record = state.handoffs[id];
  if (record === undefined) {
    fail(`handoff not found: ${id}`, 1);
  }

  const remoteSelector = flagValue(options.args, "--remote");
  const isRemoteRecord = record.execution?.remote !== undefined;

  // Remote status (#105): probe the saved machine, verify it matches the
  // recorded execution target, reconcile via the remote transport, and
  // evaluate target_check against the REMOTE snapshot. Without --remote
  // a remote record reports target_check unchecked — never a local
  // pane-id coincidence.
  let remoteProbe: RemoteProbe | null = null;
  let remoteTransport: HandoffTransport | null = null;
  if (remoteSelector !== undefined) {
    try {
      remoteProbe = await (deps.probe ?? probeRemote)(remoteSelector);
      remoteTransport = (deps.transportFor ?? ((p) => remoteCliTransport(p.machine)))(remoteProbe);
    } catch (err) {
      remoteErrorExit(err);
    }
  }

  const resolveRefs = !hasFlag(options.args, "--no-resolve-refs");
  const snapshot = await snapshotOrNull(options);
  const currentKey = snapshot !== null ? sessionKeyFor(options) : null;

  // Lazy delivered→done reconciliation. Local records reconcile against
  // the local snapshot; remote records need --remote and reconcile via
  // the remote transport's agent.get.
  if (record.status === "delivered" && !hasFlag(options.args, "--no-reconcile")) {
    if (isRemoteRecord) {
      if (remoteProbe !== null && remoteTransport !== null) {
        if (record.execution?.remote?.machine_id === remoteProbe.machine.id) {
          const updated = await reconcileRemoteDelivered(id, { transport: remoteTransport });
          if (updated !== null) record = updated;
        }
      }
    } else {
      const updated = await reconcileDelivered(id, {
        snapshot,
        sessionKey: currentKey ?? undefined,
      });
      if (updated !== null) record = updated;
    }
    state = await loadState();
    record = state.handoffs[id] ?? record;
  }

  const transferCheck = checkTransfer(record, snapshot, currentKey ?? undefined);
  let targetCheck: ReturnType<typeof checkTarget>;
  let remoteCheck: Record<string, unknown> | null = null;
  if (remoteProbe !== null) {
    const expected = record.execution?.remote?.machine_id ?? null;
    if (expected !== null && expected !== remoteProbe.machine.id) {
      remoteCheck = {
        state: "unchecked",
        reason: "remote_mismatch",
        expected_machine_id: expected,
        actual_machine_id: remoteProbe.machine.id,
      };
      targetCheck = {
        state: "unchecked",
        reason: "remote_mismatch",
        agent_status: null,
        pane_present: null,
        agent_session: null,
        state_change_seq: null,
      };
    } else if (isRemoteRecord) {
      remoteCheck = {
        state: "ok",
        machine_id: remoteProbe.machine.id,
        label: remoteProbe.machine.label,
        target: remoteProbe.machine.target,
        session: remoteProbe.machine.session,
        server_version: remoteProbe.server_version,
        protocol: remoteProbe.protocol,
      };
      // The remote snapshot IS the target session; machine identity was
      // verified above, so the session_key gate is satisfied by
      // construction (currentSessionKey omitted).
      targetCheck = checkTarget(record, remoteProbe.snapshot, undefined);
    } else {
      // --remote on a same-host record: probe result is informational;
      // the target still lives in the local session.
      remoteCheck = {
        state: "ok",
        machine_id: remoteProbe.machine.id,
        label: remoteProbe.machine.label,
        target: remoteProbe.machine.target,
        session: remoteProbe.machine.session,
        server_version: remoteProbe.server_version,
        protocol: remoteProbe.protocol,
        note: "record has no remote execution; target_check evaluated locally",
      };
      targetCheck = checkTarget(record, snapshot, currentKey ?? undefined);
    }
  } else if (isRemoteRecord) {
    targetCheck = {
      state: "unchecked",
      reason: "remote_target_requires_flag",
      agent_status: null,
      pane_present: null,
      agent_session: null,
      state_change_seq: null,
    };
    remoteCheck = { state: "unchecked", reason: "remote_flag_missing" };
  } else {
    targetCheck = checkTarget(record, snapshot, currentKey ?? undefined);
  }
  const resolved = resolveRefs ? await resolvePayloadRefs(record.payload, deps) : null;

  emit({
    contract: CONTRACT,
    command: "status",
    handoff: record,
    transfer_check: transferCheck,
    target_check: targetCheck,
    remote_check: remoteCheck,
    payload_resolution: resolved,
    missing_refs: resolved === null ? null : missingRefCount(resolved),
    state_file: stateFilePath(),
    generated_at: new Date().toISOString(),
  });
}

// --- execute / resume-info (T2, #104) -------------------------------------------

function parseNonNegativeMs(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    fail(`${flag} must be a non-negative number, got: ${raw}`, 2);
  }
  return value;
}

async function cmdExecute(
  options: CliOptions,
  deps: { transport?: HandoffTransport } & RemoteDeps = {},
): Promise<void> {
  const pos = positional(options.args);
  if (pos.length !== 1) fail("execute requires exactly one <handoff-id>", 2);
  const id = pos[0] as string;

  const flags: ExecuteFlags = {
    targetPane: flagValue(options.args, "--target-pane"),
    targetWorkspace: flagValue(options.args, "--target-workspace"),
    newWorkspace: hasFlag(options.args, "--new-workspace"),
    provider: flagValue(options.args, "--provider"),
    model: flagValue(options.args, "--model"),
    cleanupOnFailure: hasFlag(options.args, "--cleanup-on-failure"),
    waitMs: parseNonNegativeMs(flagValue(options.args, "--wait-ms"), "--wait-ms"),
    dryRun: hasFlag(options.args, "--dry-run"),
    remote: flagValue(options.args, "--remote"),
  };

  const transport = deps.transport ?? herdrTransport(options);
  const sessionKey = sessionKeyFor(options);

  // Cross-machine execution (#105): resolve + probe the saved machine
  // BEFORE any mutation. A failed probe is a structured pre-mutation
  // refusal — the record stays pending, success is never fabricated.
  let remote: { probe: RemoteProbe; transport: HandoffTransport } | undefined;
  if (flags.remote !== undefined) {
    let probe: RemoteProbe;
    try {
      probe = await (deps.probe ?? probeRemote)(flags.remote);
    } catch (err) {
      remoteErrorExit(err);
    }
    remote = {
      probe,
      transport: (deps.transportFor ?? ((p) => remoteCliTransport(p.machine)))(probe),
    };
  }

  let result: ExecuteResult;
  try {
    result = await executeHandoff(id, flags, {
      transport,
      sessionKey,
      ...(remote !== undefined ? { remote } : {}),
    });
  } catch (err) {
    if (err instanceof HandoffExecError) {
      fail(err.message, err.kind === "usage" ? 2 : 1, err.kind, err.extra);
    }
    throw err;
  }

  if (result.outcome === "dry_run") {
    emit({
      contract: CONTRACT,
      command: "execute",
      dry_run: true,
      handoff: result.record,
      plan: result.plan,
      decision: result.decision,
      prompt_text: result.prompt_text,
      generated_at: new Date().toISOString(),
    });
    return;
  }
  if (result.outcome === "failed") {
    fail(
      `handoff execution failed at step "${result.error?.step ?? "?"}": ${result.error?.message ?? "unknown"}`,
      1,
      "execution_failed",
      { handoff: result.record, step: result.error?.step ?? null },
    );
  }
  emit({
    contract: CONTRACT,
    command: "execute",
    outcome: result.outcome,
    handoff: result.record,
    ...(result.remote !== undefined ? { remote: result.remote } : {}),
    state_file: stateFilePath(),
    generated_at: new Date().toISOString(),
  });
}

// --- remote-probe (#105) ---------------------------------------------------------

/**
 * Remote capability probe. No selector → list saved machines. `--all` →
 * probe every enabled machine. `<selector>` → full probe (machine
 * resolution + remote `session.snapshot` through the SSH bridge).
 * Unreachable/disabled/unsupported machines are reported structurally —
 * never as reachable.
 */
async function cmdRemoteProbe(
  options: CliOptions,
  deps: {
    runner?: HerdrRunner;
    machines?: () => Promise<SavedMachine[]>;
    probe?: (s: string) => Promise<RemoteProbe>;
  } = {},
): Promise<void> {
  const pos = positional(options.args);
  if (pos.length > 1) fail("remote-probe accepts at most one [selector]", 2);
  const selector = pos[0];
  const probeAll = hasFlag(options.args, "--all");
  if (selector !== undefined && probeAll) {
    fail("remote-probe accepts either a selector or --all, not both", 2);
  }

  const machines = await (deps.machines ?? (() => listMachines(deps.runner ?? undefined)))();
  if (selector === undefined && !probeAll) {
    emit({
      contract: CONTRACT,
      command: "remote-probe",
      mode: "list",
      machines: machines.map((m) => ({
        id: m.id,
        label: m.label,
        target: m.target,
        session: m.session,
        enabled: m.enabled,
      })),
      hint: "pass a label-or-id (or --all) to probe remote herdr capability",
      generated_at: new Date().toISOString(),
    });
    return;
  }

  const targets: string[] = probeAll
    ? machines.filter((m) => m.enabled).map((m) => m.id)
    : [selector as string];
  const doProbe =
    deps.probe ??
    ((s: string) => probeRemote(s, deps.runner !== undefined ? { runner: deps.runner } : {}));

  const results = [];
  for (const target of targets) {
    try {
      const probe = await doProbe(target);
      const panes = probe.snapshot.panes?.length ?? 0;
      const agents = Object.keys(probe.snapshot.agents ?? {}).length;
      results.push({
        selector: target,
        state: "reachable",
        machine_id: probe.machine.id,
        label: probe.machine.label,
        target_host: probe.machine.target,
        session: probe.machine.session,
        server_version: probe.server_version,
        protocol: probe.protocol,
        panes,
        agents,
      });
    } catch (err) {
      if (err instanceof RemoteError) {
        results.push({
          selector: target,
          state: "error",
          kind: err.kind,
          message: err.message,
        });
      } else {
        results.push({
          selector: target,
          state: "error",
          kind: "error",
          message: String(err),
        });
      }
    }
  }

  emit({
    contract: CONTRACT,
    command: "remote-probe",
    mode: probeAll ? "probe_all" : "probe",
    results,
    generated_at: new Date().toISOString(),
  });
}

async function cmdResumeInfo(options: CliOptions): Promise<void> {
  const provider = flagValue(options.args, "--provider");
  const providers = provider !== undefined ? [resumeInfo(provider)] : listResumeProviders();
  emit({
    contract: CONTRACT,
    command: "resume-info",
    providers,
    notes: [
      "native_resume=supported means the provider CLI documents session resume via agent.start args; the session id comes from transfer.agent_session.value.",
      "unknown/unsupported providers fall back to portable_context at execute time — resume is never guessed.",
      "agent_session_path-dependent providers are a known upstream gap (#5 survey, #89); they report unsupported until the path is public.",
    ],
    generated_at: new Date().toISOString(),
  });
}

// --- capability / help ---------------------------------------------------------

async function cmdCapability(options: CliOptions): Promise<void> {
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: "0.3.0",
    commands: ["create", "list", "status", "execute", "resume-info", "remote-probe", "capability"],
    actions: [],
    events: [],
    startup: [],
    state_file: stateFilePath(),
    config_dir: pluginDirs(PLUGIN_ID).configDir,
    socket: options.socketPath ?? null,
    execution: "same_host_and_remote_saved_machines",
    remote: {
      mechanism:
        "herdr saved machines + `herdr --machine <label-or-id>` CLI bridge (SSH → remote-api-bridge)",
      machine_source: "`herdr machine list --json` profiles (id/label/target/session)",
      probe: "remote-probe [selector|--all]; execute --remote <label-or-id>",
      portable_bundle: "herdr-plugins.handoff/bundle/v1 written to <state>/bundles/<id>.json",
      unsupported:
        "herdr --remote (TUI-only) and server.ssh_agent.register (agent forwarding) are NOT remote control surfaces",
    },
    execution_surface: {
      strategies: ["native_resume", "portable_context"],
      target_selection: [
        "--target-pane",
        "--target-workspace",
        "--new-workspace",
        "--remote <machine>",
      ],
      agent_api: [
        "workspace.create",
        "tab.create",
        "agent.start",
        "agent.prompt",
        "agent.wait",
        "remote: same surface via `herdr --machine` CLI",
      ],
      failure_cleanup_flag: "--cleanup-on-failure",
      observation_flag: "--wait-ms",
      provider_hint: "opaque label; first '.'-segment is used as the agent.start kind only",
    },
    limits: {
      max_excerpt_chars: MAX_EXCERPT_CHARS,
      max_payload_refs: MAX_PAYLOAD_REFS,
      max_requirements: MAX_REQUIREMENTS,
      max_prompt_chars: MAX_PROMPT_CHARS,
    },
  });
}

const USAGE = `rebuildup.handoff — handoff/delegation records (contract ${CONTRACT})

Usage:
  handoff create <pane_id> [--strategy STRATEGY] [--provider HINT]
                 [--note TEXT] [--requirement TEXT]...
                 [--conversation KEY]... [--checkpoint ID]...
                 [--external VALUE]... [--target-pane ID]
                 [--target-workspace ID] [--dry-run]
                 [--session NAME] [--socket PATH]
  handoff list [--status STATUS] [--limit N] [--session NAME]
  handoff execute <handoff-id> [--target-pane ID | --target-workspace ID
                 | --new-workspace] [--provider HINT] [--model M]
                 [--wait-ms MS] [--cleanup-on-failure] [--dry-run]
                 [--remote MACHINE] [--session NAME] [--socket PATH]
  handoff status <handoff-id> [--no-resolve-refs] [--no-reconcile]
                 [--remote MACHINE] [--session NAME]
  handoff resume-info [--provider KIND]
  handoff remote-probe [MACHINE | --all]
  handoff capability [--session NAME]

Strategies: ${HANDOFF_STRATEGIES.join(" | ")}
Statuses:   ${HANDOFF_STATUSES.join(" | ")}

execute runs the handoff: target surface via herdr API only, agent.start,
payload prompt injection, then pending→ready→delivered→done/failed
tracking. --remote MACHINE executes on a saved SSH machine (herdr
--machine bridge): a portable bundle (bundle/v1) is written under the
state dir, plugin-state payload refs are marked non-resolvable remotely,
and unreachable/disabled/unsupported machines fail structurally before
any mutation. native_resume falls back to portable_context when the
provider cannot resume; failures persist status=failed honestly.
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  switch (options.command) {
    case "create":
      return cmdCreate(options);
    case "list":
      return cmdList(options);
    case "status":
      return cmdStatus(options);
    case "execute":
      return cmdExecute(options);
    case "resume-info":
      return cmdResumeInfo(options);
    case "remote-probe":
      return cmdRemoteProbe(options);
    case "capability":
      return cmdCapability(options);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      fail(`unknown command: ${options.command}\n\n${USAGE}`, 2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `${JSON.stringify({
        contract: CONTRACT,
        ok: false,
        error: { code: "error", message: String(err) },
      })}\n`,
    );
    process.exit(1);
  });
}
