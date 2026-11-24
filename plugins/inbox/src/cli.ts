/**
 * rebuildup.inbox CLI — the versioned structured interface shared by the
 * herdr TUI (via manifest actions), agents, and external clients such as
 * herdr-t3. All commands emit a single JSON document on stdout; diagnostics
 * go to stderr. Exit code 0 on success, 1 on handled errors, 2 on usage
 * errors.
 *
 * Pane selection: explicit <pane_id> argument, else HERDR_PANE_ID, else
 * HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id (manifest action context).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CallOptions,
  type PaneInfo,
  pluginDirs,
  reportPaneMetadata,
  type SessionSnapshot,
  sessionSnapshot,
  subscribeAgentEvents,
} from "../../../packages/herdr-client/src/index";
import { buildInbox, resolveState, restorePane, settlePane, snoozePane } from "./model";
import { type InboxEntry, loadState, PLUGIN_ID, stateFilePath, updateState } from "./state";

const CONTRACT = "herdr-plugins.inbox/v1";
const DEFAULT_SNOOZE_CONFIG = "config.json";

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
      const value = args[++i];
      if (value !== undefined) options.timeoutMs = Number(value);
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

function fail(message: string, code = 1): never {
  process.stderr.write(`inbox: ${message}\n`);
  process.exit(code);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (
      arg === "--until" ||
      arg === "--for" ||
      arg === "--session" ||
      arg === "--socket" ||
      arg === "--timeout"
    ) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

interface PluginContext {
  focused_pane_id?: string;
  workspace_id?: string;
}

function invocationContext(): PluginContext {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PluginContext;
  } catch {
    return {};
  }
}

async function resolvePaneId(args: string[]): Promise<string> {
  const positionalArgs = positional(args);
  const explicit =
    positionalArgs[0] ?? process.env.HERDR_PANE_ID ?? invocationContext().focused_pane_id;
  if (!explicit) {
    fail("pane id required (argument, HERDR_PANE_ID, or plugin context)", 2);
  }
  return explicit;
}

async function loadConfig(): Promise<{ defaultSnooze?: string }> {
  const file = path.join(pluginDirs(PLUGIN_ID).configDir, DEFAULT_SNOOZE_CONFIG);
  try {
    return JSON.parse(await readFile(file, "utf8")) as { defaultSnooze?: string };
  } catch {
    return {};
  }
}

/** Parse deadline specs: ISO 8601, `+30m`/`+2h`/`+1d` (or bare `30m`). */
export function parseUntilSpec(spec: string, now: Date): Date {
  const normalized = /^\d+[mhd]$/.test(spec) ? `+${spec}` : spec;
  const duration = normalized.match(/^\+(\d+)([mhd])$/);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2];
    const ms =
      unit === "m" ? amount * 60_000 : unit === "h" ? amount * 3_600_000 : amount * 86_400_000;
    return new Date(now.getTime() + ms);
  }
  const iso = Date.parse(normalized);
  if (!Number.isNaN(iso)) return new Date(iso);
  fail(`cannot parse snooze deadline: ${spec}`, 2);
}

async function findPane(snapshot: SessionSnapshot, paneId: string): Promise<PaneInfo> {
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
  if (!pane) fail(`pane not found in session snapshot: ${paneId}`);
  return pane;
}

async function projectMetadata(
  paneId: string,
  entry: InboxEntry | undefined,
  options: CallOptions,
): Promise<string[]> {
  const warnings: string[] = [];
  // Token keys allow only [A-Za-z0-9_-]; a null value clears the token.
  const tokens: Record<string, string | null> = entry?.snoozed
    ? {
        inbox_state: "snoozed",
        inbox_snoozed_until: entry.snoozed.until,
      }
    : entry?.settled
      ? { inbox_state: "settled", inbox_snoozed_until: null }
      : { inbox_state: null, inbox_snoozed_until: null };
  try {
    await reportPaneMetadata(paneId, tokens, options);
  } catch (err) {
    warnings.push(`metadata projection failed: ${String(err)}`);
  }
  return warnings;
}

async function cmdList(options: CliOptions): Promise<void> {
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const state = await loadState();
  const { state: resolved } = resolveState(state, snapshot.agents ?? {}, now);
  const items = buildInbox(snapshot.panes ?? [], snapshot.agents ?? {}, resolved, now);
  const inbox = items.filter((item) => item.in_inbox);
  emit({
    contract: CONTRACT,
    generated_at: now.toISOString(),
    session: snapshot.session ?? null,
    state_file: stateFilePath(),
    counts: {
      total: items.length,
      inbox: inbox.length,
      attention: items.filter((i) => i.attention).length,
      organized: items.filter((i) => i.organize).length,
    },
    items,
  });
}

async function cmdOrganize(
  options: CliOptions,
  kind: "settle" | "snooze" | "restore",
): Promise<void> {
  const paneId = await resolvePaneId(options.args);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  const agent = snapshot.agents?.[paneId];

  const warnings: string[] = [];
  const entry = await updateState(async (state) => {
    if (kind === "settle") return settlePane(state, pane, agent, now);
    if (kind === "restore") {
      restorePane(state, paneId);
      return undefined;
    }
    const untilSpec = flagValue(options.args, "--until") ?? flagValue(options.args, "--for");
    let until: Date;
    if (untilSpec) {
      until = parseUntilSpec(untilSpec, now);
    } else {
      const config = await loadConfig();
      if (!config.defaultSnooze) {
        fail("snooze requires --until <iso|+duration> or config.json defaultSnooze", 2);
      }
      until = parseUntilSpec(config.defaultSnooze as string, now);
    }
    return snoozePane(state, pane, agent, until, now);
  });

  warnings.push(...(await projectMetadata(paneId, entry, options)));

  const fresh = await loadState();
  const resolvedEntry = fresh.entries[paneId];
  emit({
    contract: CONTRACT,
    command: kind,
    pane_id: paneId,
    agent_status: agent?.agent_status ?? null,
    state_change_seq: agent?.state_change_seq ?? null,
    organize: resolvedEntry?.snoozed
      ? { kind: "snoozed", since: resolvedEntry.snoozed.at, until: resolvedEntry.snoozed.until }
      : resolvedEntry?.settled
        ? { kind: "settled", since: resolvedEntry.settled.at }
        : null,
    warnings,
  });
}

async function cmdReconcile(options: CliOptions): Promise<void> {
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const agents = snapshot.agents ?? {};
  const clearedPaneIds = await updateState(
    (state) => resolveState(state, agents, now).clearedPaneIds,
  );
  const warnings: string[] = [];
  for (const paneId of clearedPaneIds) {
    warnings.push(...(await projectMetadata(paneId, undefined, options)));
  }
  emit({
    contract: CONTRACT,
    command: "reconcile",
    resolved_at: now.toISOString(),
    cleared: clearedPaneIds,
    warnings,
  });
}

async function cmdWatch(options: CliOptions): Promise<void> {
  const intervalMs = Number(flagValue(options.args, "--interval") ?? "60") * 1000;
  const subscription = subscribeAgentEvents(options);
  await subscription.started;
  process.stderr.write("inbox watch: subscribed to pane.agent_status_changed\n");

  const reconcile = async () => {
    try {
      await cmdReconcileSilent(options);
    } catch (err) {
      process.stderr.write(`inbox watch: reconcile failed: ${String(err)}\n`);
    }
  };

  const ticker = setInterval(() => void reconcile(), intervalMs);
  try {
    for await (const _event of subscription.events) {
      await reconcile();
    }
  } finally {
    clearInterval(ticker);
    subscription.close();
  }
}

async function cmdReconcileSilent(options: CliOptions): Promise<void> {
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const agents = snapshot.agents ?? {};
  const cleared = await updateState((state) => resolveState(state, agents, now).clearedPaneIds);
  for (const paneId of cleared) {
    try {
      await reportPaneMetadata(paneId, { inbox_state: null, inbox_snoozed_until: null }, options);
    } catch {
      // best-effort projection inside watch
    }
  }
}

async function cmdCapability(options: CliOptions): Promise<void> {
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    commands: ["list", "settle", "snooze", "restore", "reconcile", "watch"],
    actions: ["settle", "restore", "snooze"],
    events: ["pane.agent_status_changed"],
    state_file: stateFilePath(),
    socket: options.socketPath ?? null,
  });
}

const USAGE = `rebuildup.inbox — agent work inbox (contract ${CONTRACT})

Usage:
  inbox list [--session NAME] [--socket PATH]
  inbox settle <pane_id> [--session NAME]
  inbox snooze <pane_id> --until <iso8601|+30m|+2h|+1d> [--session NAME]
  inbox restore <pane_id> [--session NAME]
  inbox reconcile [--session NAME]
  inbox watch [--interval SECONDS] [--session NAME]
  inbox capability [--session NAME]

Pane id may be omitted inside a plugin action/hook context (HERDR_PANE_ID
or HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id).
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "list":
      return cmdList(options);
    case "settle":
    case "snooze":
    case "restore":
      return cmdOrganize(options, options.command);
    case "reconcile":
      return cmdReconcile(options);
    case "watch":
      return cmdWatch(options);
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
    process.stderr.write(`inbox: ${String(err)}\n`);
    process.exit(1);
  });
}
