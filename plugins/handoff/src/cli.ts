/**
 * rebuildup.handoff CLI — the versioned structured interface for the
 * handoff/delegation plugin (contract `herdr-plugins.handoff/v1`,
 * issue #103 / parent #6 T1).
 *
 * T1 scope: payload contract + state + read-side commands. `create`
 * records a handoff (source identity + reference payload + strategy +
 * optional target hint); `list`/`status` enumerate and inspect records
 * with honest staleness and missing_ref reporting. Execution
 * (workspace/pane creation, agent.start, status transitions) is T2
 * (#104) and deliberately absent here.
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

function emitError(message: string, code: number): never {
  const error = {
    contract: CONTRACT,
    ok: false,
    error: { code: code === 2 ? "usage" : "error", message },
  };
  process.stderr.write(`${JSON.stringify(error)}\n`);
  process.exit(code);
}

function fail(message: string, code = 1): never {
  emitError(message, code);
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
  "--note",
  "--conversation",
  "--checkpoint",
  "--external",
  "--requirement",
  "--target-pane",
  "--target-workspace",
  "--status",
  "--limit",
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

async function cmdStatus(options: CliOptions, deps: RefDeps = {}): Promise<void> {
  const pos = positional(options.args);
  if (pos.length !== 1) fail("status requires exactly one <handoff-id>", 2);
  const id = pos[0] as string;

  const state = await loadState();
  const record = state.handoffs[id];
  if (record === undefined) {
    fail(`handoff not found: ${id}`, 1);
  }

  const resolveRefs = !hasFlag(options.args, "--no-resolve-refs");
  const snapshot = await snapshotOrNull(options);
  const currentKey = snapshot !== null ? sessionKeyFor(options) : null;
  const transferCheck = checkTransfer(record, snapshot, currentKey ?? undefined);
  const resolved = resolveRefs ? await resolvePayloadRefs(record.payload, deps) : null;

  emit({
    contract: CONTRACT,
    command: "status",
    handoff: record,
    transfer_check: transferCheck,
    payload_resolution: resolved,
    missing_refs: resolved === null ? null : missingRefCount(resolved),
    state_file: stateFilePath(),
    generated_at: new Date().toISOString(),
  });
}

// --- capability / help ---------------------------------------------------------

async function cmdCapability(options: CliOptions): Promise<void> {
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: "0.1.0",
    commands: ["create", "list", "status", "capability"],
    actions: [],
    events: [],
    startup: [],
    state_file: stateFilePath(),
    config_dir: pluginDirs(PLUGIN_ID).configDir,
    socket: options.socketPath ?? null,
    execution: "not_implemented", // T2 (#104) adds execute/status transitions
    limits: {
      max_excerpt_chars: MAX_EXCERPT_CHARS,
      max_payload_refs: MAX_PAYLOAD_REFS,
      max_requirements: MAX_REQUIREMENTS,
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
  handoff status <handoff-id> [--no-resolve-refs] [--session NAME]
  handoff capability [--session NAME]

Strategies: ${HANDOFF_STRATEGIES.join(" | ")}
Statuses:   ${HANDOFF_STATUSES.join(" | ")}
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
