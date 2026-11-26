/**
 * rebuildup.inbox CLI — the versioned structured interface shared by the
 * herdr TUI (via manifest actions), agents, and external clients such as
 * herdr-t3. All commands emit a single JSON document on stdout; diagnostics
 * go to stderr. Exit code 0 on success, 1 on handled errors, 2 on usage
 * errors.
 *
 * Pane selection: explicit <pane_id> argument, else HERDR_PANE_ID, else
 * HERDR_PLUGIN_CONTEXT_JSON.focused_pane_id (manifest action context).
 * Ambient pane ids are verified against the resolved session's snapshot
 * (workspace/tab consistency); session/socket targeting follows
 * `resolveTarget` — explicit flags beat ambient HERDR_* and contradictions
 * fail closed (see docs/contracts/inbox-v1.md → Target selection).
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ghChildEnv } from "../../../packages/git-core/src/git-env";
import {
  type AmbientIdentity,
  ambientIdentity,
  assertAmbientPaneIdentity,
  type CallOptions,
  type PaneInfo,
  pluginDirs,
  reportPaneMetadata,
  resolveTarget,
  type SessionSnapshot,
  sessionSnapshot,
  subscribeAgentEvents,
  TargetResolutionError,
} from "../../../packages/herdr-client/src/index";
import {
  applyInboxFilters,
  archivePane,
  buildInbox,
  computeOrderRanks,
  type InboxFilters,
  linkPane,
  type OrderPlacement,
  pinPane,
  pruneState,
  resolveState,
  restorePane,
  settlePane,
  snoozePane,
  toPublicLink,
  unarchivePane,
  unlinkPane,
  unpinPane,
  upsertEntry,
} from "./model";
import { resolvePluginRoot, runPluginCli } from "./pluginroot";
import {
  type InboxEntry,
  type InboxTransition,
  type LinkKind,
  type LinkWatch,
  type LinkWatchObservation,
  loadState,
  type PaneLink,
  PLUGIN_ID,
  removeWatchLink,
  sessionEntries,
  sessionKeyFor,
  stateFilePath,
  updateState,
} from "./state";
import {
  appendClearedTransitions,
  appendOrganizeTransition,
  appendTransition,
  MAX_TRANSITIONS_PER_SESSION,
  type TransitionContext,
} from "./transitions";
import {
  buildObservation,
  collectWatchTargets,
  diffObservation,
  pollBackoffMs,
  pruneWatchSession,
  type WatchDiff,
  type WatchTarget,
} from "./watchpr";

const CONTRACT = "herdr-plugins.inbox/v1";
const DEFAULT_SNOOZE_CONFIG = "config.json";

interface CliOptions extends CallOptions {
  command: string;
  args: string[];
  session: string | undefined;
}

function takeGlobalValue(args: string[], i: number, flag: string): string {
  const value = args[i + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    fail(`option ${flag} requires a value`, 2);
  }
  return value;
}

function parseGlobalTimeout(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    fail(`invalid --timeout: ${raw} (expected a positive number of milliseconds)`, 2);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = { command, args, session: undefined };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--session") {
      options.session = takeGlobalValue(args, i, "--session");
      i += 1;
    } else if (arg.startsWith("--session=")) {
      options.session = arg.slice("--session=".length);
      if (options.session.length === 0) fail("option --session requires a value", 2);
    } else if (arg === "--socket") {
      options.socketPath = takeGlobalValue(args, i, "--socket");
      i += 1;
    } else if (arg.startsWith("--socket=")) {
      options.socketPath = arg.slice("--socket=".length);
      if (!options.socketPath) fail("option --socket requires a value", 2);
    } else if (arg === "--timeout") {
      options.timeoutMs = parseGlobalTimeout(takeGlobalValue(args, i, "--timeout"));
      i += 1;
    } else if (arg.startsWith("--timeout=")) {
      options.timeoutMs = parseGlobalTimeout(arg.slice("--timeout=".length));
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

/**
 * First value of a flag, in either `--name value` or `--name=value` form.
 * Tokens after a `--` separator are positional and never match.
 */
function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") break;
    if (arg === name) return args[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

type FlagKind = "boolean" | "value";

/**
 * Strict option check: every `-`-prefixed token before a `--` separator
 * must be a whitelisted flag for this command (`--name=value` counts as
 * `--name`). Unknown options, `--flag=value` on boolean flags, and value
 * flags with a missing/option-like value are usage errors (exit 2).
 * A lone `-` is a positional, not an option.
 */
function validateFlags(args: string[], spec: Record<string, FlagKind>): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") break;
    if (arg === "-" || !arg.startsWith("-")) continue;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const kind = spec[name];
    if (!kind) fail(`unknown option: ${arg}`, 2);
    if (kind === "boolean") {
      if (eq !== -1) fail(`option ${name} does not take a value`, 2);
      continue;
    }
    if (eq !== -1) continue;
    const next = args[i + 1];
    if (
      next === undefined ||
      next === "--" ||
      next.startsWith("--") ||
      (next.length > 1 && next.startsWith("-") && next in spec)
    ) {
      fail(`option ${name} requires a value`, 2);
    }
    i += 1;
  }
}

/** Positional args, skipping flag values. Everything after `--` counts. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  let afterSeparator = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (afterSeparator) {
      out.push(arg);
      continue;
    }
    if (arg === "--") {
      afterSeparator = true;
      continue;
    }
    if (valueFlags.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.length > 1 && arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

/** More positionals than the command accepts is a usage error. */
function assertMaxPositionals(
  args: string[],
  valueFlags: string[],
  max: number,
  usage: string,
): void {
  const pos = positionals(args, valueFlags);
  if (pos.length > max) {
    fail(`${usage}: unexpected argument ${JSON.stringify(pos[max])}`, 2);
  }
}

interface PaneSelection {
  paneId: string;
  /** Non-null when the pane id came from ambient env/context (not positional). */
  ambient: AmbientIdentity | null;
}

/**
 * Resolve the target pane. An explicit positional wins; otherwise the
 * ambient identity bundle (HERDR_PANE_ID / context focused_pane_id) is
 * used and kept for the post-snapshot consistency check — ambient
 * workspace/tab ids that disagree with the resolved pane fail closed.
 */
function resolvePaneSelection(args: string[], valueFlags: string[] = []): PaneSelection {
  const positional = positionals(args, valueFlags)[0];
  if (positional) return { paneId: positional, ambient: null };
  const identity = ambientIdentity();
  if (!identity.paneId) {
    fail("pane id required (argument, HERDR_PANE_ID, or plugin context)", 2);
  }
  return { paneId: identity.paneId as string, ambient: identity };
}

async function loadConfig(): Promise<{
  defaultSnooze?: string | undefined;
  gitPluginRoot?: string | undefined;
}> {
  const file = path.join(pluginDirs(PLUGIN_ID).configDir, DEFAULT_SNOOZE_CONFIG);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      defaultSnooze?: string;
      gitPluginRoot?: string;
    };
    return {
      defaultSnooze: parsed.defaultSnooze,
      gitPluginRoot: parsed.gitPluginRoot,
    };
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
        inbox_pinned: entry.pinned ? "true" : null,
      }
    : entry?.settled
      ? {
          inbox_state: "settled",
          inbox_snoozed_until: null,
          inbox_pinned: entry.pinned ? "true" : null,
        }
      : entry?.archived
        ? {
            inbox_state: "archived",
            inbox_snoozed_until: null,
            inbox_pinned: entry.pinned ? "true" : null,
          }
        : { inbox_state: null, inbox_snoozed_until: null, inbox_pinned: null };
  try {
    await reportPaneMetadata(paneId, tokens, options);
  } catch (err) {
    warnings.push(`metadata projection failed: ${String(err)}`);
  }
  return warnings;
}

const ORGANIZE_FILTERS = new Set(["settled", "snoozed", "archived", "none"]);

/** Parse read-side `list` filters; unknown --organize values are usage errors. */
function parseListFilters(args: string[]): InboxFilters {
  const filters: InboxFilters = {};
  if (args.includes("--attention")) filters.attention = true;
  const organize = flagValue(args, "--organize");
  if (organize !== undefined) {
    if (!ORGANIZE_FILTERS.has(organize)) {
      fail(`invalid --organize value (expected settled|snoozed|archived|none): ${organize}`, 2);
    }
    filters.organize = organize as NonNullable<InboxFilters["organize"]>;
  }
  const search = flagValue(args, "--search");
  if (search !== undefined) filters.search = search;
  const workspace = flagValue(args, "--workspace");
  if (workspace !== undefined) filters.workspace = workspace;
  return filters;
}

const LIST_FLAGS: Record<string, FlagKind> = {
  "--attention": "boolean",
  "--organize": "value",
  "--search": "value",
  "--workspace": "value",
};
const LIST_VALUE_FLAGS = ["--organize", "--search", "--workspace"];

async function cmdList(options: CliOptions): Promise<void> {
  validateFlags(options.args, LIST_FLAGS);
  assertMaxPositionals(options.args, LIST_VALUE_FLAGS, 0, "list");
  const now = new Date();
  const target = resolveTarget({ session: options.session, socketPath: options.socketPath });
  const snapshot = await sessionSnapshot(options);
  const state = await loadState();
  const entries = state.sessions[sessionKeyFor(options)] ?? {};
  resolveState(entries, snapshot.agents ?? {}, now);
  const filters = parseListFilters(options.args);
  const items = applyInboxFilters(
    buildInbox(snapshot.panes ?? [], snapshot.agents ?? {}, entries, now),
    filters,
  );
  const inbox = items.filter((item) => item.in_inbox);
  emit({
    contract: CONTRACT,
    generated_at: now.toISOString(),
    session: {
      name: target.session,
      socket: options.socketPath ?? process.env.HERDR_SOCKET_PATH ?? null,
    },
    state_file: stateFilePath(),
    filters: {
      attention: filters.attention === true,
      organize: filters.organize ?? null,
      search: filters.search ?? null,
      workspace: filters.workspace ?? null,
    },
    counts: {
      total: items.length,
      inbox: inbox.length,
      attention: items.filter((i) => i.attention).length,
      organized: items.filter((i) => i.organize).length,
      pinned: items.filter((i) => i.pinned).length,
      archived: items.filter((i) => i.organize?.kind === "archived").length,
      linked: items.filter((i) => i.links.length > 0).length,
    },
    items,
  });
}

type OrganizeCommand = "settle" | "snooze" | "restore" | "pin" | "unpin" | "archive" | "unarchive";

async function cmdOrganize(options: CliOptions, kind: OrganizeCommand): Promise<void> {
  // Every organize command mutates plugin state and pane metadata: the
  // target must be explicit or a consistent ambient context, never the
  // implicit default socket.
  options.mutation = true;
  const snoozeFlags: Record<string, FlagKind> = { "--until": "value", "--for": "value" };
  const valueFlags = kind === "snooze" ? ["--until", "--for"] : [];
  validateFlags(options.args, kind === "snooze" ? snoozeFlags : {});
  assertMaxPositionals(options.args, valueFlags, 1, `${kind} <pane_id>`);
  const selection = resolvePaneSelection(options.args, valueFlags);
  const paneId = selection.paneId;
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  if (selection.ambient) assertAmbientPaneIdentity(pane, selection.ambient);
  const agent = snapshot.agents?.[paneId];

  // Resolve the snooze deadline before taking the state lock: parse failures
  // exit the process and would strand the lock file until it goes stale.
  let until: Date | undefined;
  if (kind === "snooze") {
    const untilSpec = flagValue(options.args, "--until") ?? flagValue(options.args, "--for");
    if (untilSpec) {
      until = parseUntilSpec(untilSpec, now);
    } else {
      const config = await loadConfig();
      if (!config.defaultSnooze) {
        fail("snooze requires --until <iso|+duration> or config.json defaultSnooze", 2);
      }
      until = parseUntilSpec(config.defaultSnooze as string, now);
    }
  }

  const warnings: string[] = [];
  const sessionKey = sessionKeyFor(options);
  const transitionCtx: TransitionContext = {
    pane,
    agent,
    at: now.toISOString(),
  };
  const entry = await updateState(async (state) => {
    const entries = sessionEntries(state, sessionKey);
    switch (kind) {
      case "settle":
        appendOrganizeTransition(state, sessionKey, "settled", paneId, transitionCtx);
        return settlePane(entries, pane, agent, now);
      case "snooze":
        appendOrganizeTransition(state, sessionKey, "snoozed", paneId, transitionCtx);
        return snoozePane(entries, pane, agent, until as Date, now);
      case "restore": {
        // Record `restored` only when the command actually removed
        // organize state — a no-op restore is not a transition.
        const before = entries[paneId];
        const hadState =
          before !== undefined &&
          (before.settled !== undefined ||
            before.snoozed !== undefined ||
            before.archived !== undefined ||
            before.pinned !== undefined ||
            before.order !== undefined);
        restorePane(entries, paneId);
        if (hadState) {
          appendOrganizeTransition(state, sessionKey, "restored", paneId, {
            ...transitionCtx,
            workspaceId: before?.workspace_id,
          });
        }
        return undefined;
      }
      case "pin":
        return pinPane(entries, pane, agent, now);
      case "unpin":
        unpinPane(entries, paneId, now);
        return entries[paneId];
      case "archive":
        return archivePane(entries, pane, agent, now);
      case "unarchive":
        unarchivePane(entries, paneId, now);
        return entries[paneId];
    }
  });

  warnings.push(...(await projectMetadata(paneId, entry, options)));

  if (kind === "snooze" && until) {
    const wakeWarning = spawnSnoozeWake(options, until);
    if (wakeWarning) warnings.push(wakeWarning);
  }

  const fresh = await loadState();
  const resolvedEntry = fresh.sessions[sessionKey]?.[paneId];
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
        : resolvedEntry?.archived
          ? { kind: "archived", since: resolvedEntry.archived.at }
          : null,
    pinned: resolvedEntry?.pinned !== undefined,
    order: resolvedEntry?.order ?? null,
    warnings,
  });
}

interface ReconcileResult {
  resolved_at: string;
  cleared: string[];
  pruned: string[];
  /** Pane ids whose metadata tokens were (re)projected. */
  projected: string[];
  warnings: string[];
}

/**
 * Single reconcile pass: resolve marks against the live snapshot, prune
 * stale entries, then repair pane metadata for every organized pane and
 * clear tokens for panes whose organize state was just removed. Metadata
 * projection is best-effort per pane; failures are collected as warnings so
 * a later reconcile can repair them.
 */
async function reconcileOnce(options: CliOptions): Promise<ReconcileResult> {
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const agents = snapshot.agents ?? {};
  const livePaneIds = new Set((snapshot.panes ?? []).map((p) => p.pane_id));

  const sessionKey = sessionKeyFor(options);
  const mutation = await updateState((state) => {
    const entries = sessionEntries(state, sessionKey);
    // Snapshot hide-kind/workspace info BEFORE resolution deletes marks
    // and entries — cleared/pruned transitions still need honest context.
    const hideKindBefore = new Map<string, boolean>();
    const workspaceBefore = new Map<string, string | undefined>();
    for (const [paneId, e] of Object.entries(entries)) {
      hideKindBefore.set(
        paneId,
        e.settled !== undefined || e.snoozed !== undefined || e.archived !== undefined,
      );
      workspaceBefore.set(paneId, e.workspace_id);
    }
    const resolved = resolveState(entries, agents, now);
    const cleared = resolved.clearedPaneIds;
    const pruned = pruneState(entries, livePaneIds, now);

    // Organize-transition log (#182): record hide-kind clears caused by
    // expiry/generation resolution and retention pruning. Pin/order-only
    // clears are layout hints, not organize transitions.
    const at = now.toISOString();
    const paneById = new Map((snapshot.panes ?? []).map((p) => [p.pane_id, p]));
    const clearedByPane = new Map<
      string,
      Array<{ field: string; cause: "expired" | "generation" | "session_mismatch" }>
    >();
    for (const cm of resolved.clearedMarks) {
      if (cm.field === "pinned") continue;
      const list = clearedByPane.get(cm.pane_id) ?? [];
      list.push(cm);
      clearedByPane.set(cm.pane_id, list);
    }
    for (const [paneId, marks] of clearedByPane) {
      appendClearedTransitions(state, sessionKey, paneId, marks, {
        pane: paneById.get(paneId),
        agent: agents[paneId],
        workspaceId: workspaceBefore.get(paneId),
        at,
      });
    }
    for (const paneId of pruned) {
      if (hideKindBefore.get(paneId) !== true) continue;
      appendTransition(state, sessionKey, {
        kind: "cleared",
        paneId,
        ctx: { workspaceId: workspaceBefore.get(paneId), at },
        cause: "pruned",
      });
    }
    // A pane can lose one mark while keeping others (e.g. settle expired but
    // pin survives); project the post-resolution entry, not a blanket clear.
    const clearedEntries = cleared
      .filter((paneId) => livePaneIds.has(paneId))
      .map((paneId) => ({ pane_id: paneId, entry: entries[paneId] }));
    const organized = Object.values(entries)
      .filter(
        (entry) =>
          livePaneIds.has(entry.pane_id) &&
          (entry.settled !== undefined ||
            entry.snoozed !== undefined ||
            entry.archived !== undefined ||
            entry.pinned !== undefined),
      )
      .map((entry) => ({ pane_id: entry.pane_id, entry }));
    return { cleared, pruned, clearedEntries, organized };
  });

  const warnings: string[] = [];
  const projected: string[] = [];
  // Only live panes can carry metadata tokens; cleared marks on absent panes
  // need no projection (and would only produce spurious warnings).
  for (const { pane_id: paneId, entry } of mutation.clearedEntries) {
    warnings.push(...(await projectMetadata(paneId, entry, options)));
    projected.push(paneId);
  }
  for (const { pane_id: paneId, entry } of mutation.organized) {
    warnings.push(...(await projectMetadata(paneId, entry, options)));
    projected.push(paneId);
  }

  return {
    resolved_at: now.toISOString(),
    cleared: mutation.cleared,
    pruned: mutation.pruned,
    projected,
    warnings,
  };
}

/**
 * Deadline-driven wake: `snooze` detaches a one-shot `_wake` process that
 * sleeps until the deadline, then runs one reconcile pass (expiry resolution
 * + metadata re-projection) and exits. It is bounded (lifetime = remaining
 * snooze), does no polling, and is redundant with lazy read-side resolution
 * and the startup reconcile — see ADR-0005.
 *
 * Explicit --socket/--session flags are forwarded because the child does not
 * inherit argv; HERDR_SOCKET_PATH/HERDR_SESSION env vars propagate naturally.
 * Both paths stay consistent under `resolveTarget`: a contradictory ambient
 * env + explicit flag combination fails closed in the parent before spawn.
 */
function spawnSnoozeWake(options: CliOptions, until: Date): string | null {
  try {
    const script = path.join(import.meta.dir, "cli.ts");
    const args = [process.execPath, "run", script, "_wake", "--until", until.toISOString()];
    if (options.socketPath) args.push("--socket", options.socketPath);
    if (options.session) args.push("--session", options.session);
    const child = spawn(args[0] as string, args.slice(1), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return null;
  } catch (err) {
    return `snooze wake scheduler failed: ${String(err)}`;
  }
}

const WAKE_MAX_SLEEP_MS = 2_000_000_000;

/** Internal `_wake` command: sleep until the deadline, then reconcile once. */
async function cmdWake(options: CliOptions): Promise<void> {
  options.mutation = true;
  validateFlags(options.args, { "--until": "value" });
  assertMaxPositionals(options.args, ["--until"], 0, "_wake");
  const untilSpec = flagValue(options.args, "--until");
  if (!untilSpec) fail("_wake requires --until <iso8601>", 2);
  const until = parseUntilSpec(untilSpec, new Date());
  let remaining = until.getTime() - Date.now();
  while (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, WAKE_MAX_SLEEP_MS)));
    remaining = until.getTime() - Date.now();
  }
  await reconcileOnce(options);
}

async function cmdReconcile(options: CliOptions): Promise<void> {
  options.mutation = true;
  validateFlags(options.args, {});
  assertMaxPositionals(options.args, [], 0, "reconcile");
  const result = await reconcileOnce(options);
  emit({ contract: CONTRACT, command: "reconcile", ...result });
}

function parseOrderPlacement(args: string[]): OrderPlacement {
  const before = flagValue(args, "--before");
  const after = flagValue(args, "--after");
  const first = args.includes("--first");
  const last = args.includes("--last");
  const modes = [before !== undefined, after !== undefined, first, last].filter(Boolean).length;
  if (modes !== 1) {
    fail("order requires exactly one of --before <pane> | --after <pane> | --first | --last", 2);
  }
  if (before !== undefined) return { kind: "before", paneId: before };
  if (after !== undefined) return { kind: "after", paneId: after };
  return { kind: first ? "first" : "last" };
}

/**
 * Manual ordering: rewrite dense `order` ranks for the moved pane's display
 * group (same attention/pinned flags). Only visible inbox panes participate;
 * hidden panes keep whatever rank they had and rejoin as unordered/ordered
 * items when they resurface. Ordering never hides or mutates execution
 * state — it is a layout hint only.
 */
async function cmdOrder(options: CliOptions): Promise<void> {
  // order rewrites plugin state ranks and is a mutation of herdr-visible
  // layout state: explicit or consistent ambient target required.
  options.mutation = true;
  const orderFlags: Record<string, FlagKind> = {
    "--before": "value",
    "--after": "value",
    "--first": "boolean",
    "--last": "boolean",
  };
  const orderValueFlags = ["--before", "--after"];
  validateFlags(options.args, orderFlags);
  assertMaxPositionals(options.args, orderValueFlags, 1, "order <pane_id>");
  const selection = resolvePaneSelection(options.args, orderValueFlags);
  const paneId = selection.paneId;
  const placement = parseOrderPlacement(options.args);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  if (selection.ambient) {
    assertAmbientPaneIdentity(await findPane(snapshot, paneId), selection.ambient);
  }
  const state = await loadState();
  const sessionKey = sessionKeyFor(options);
  const entries = state.sessions[sessionKey] ?? {};
  resolveState(entries, snapshot.agents ?? {}, now);
  const items = buildInbox(snapshot.panes ?? [], snapshot.agents ?? {}, entries, now);

  const moved = items.find((item) => item.in_inbox && item.pane_id === paneId);
  if (!moved) fail(`pane is not in the inbox (hidden panes cannot be ordered): ${paneId}`);
  const siblings = items.filter(
    (item) => item.in_inbox && item.attention === moved.attention && item.pinned === moved.pinned,
  );
  const ranks = computeOrderRanks(siblings, paneId, placement);
  if ("error" in ranks) fail(ranks.error, 2);

  const paneById = new Map((snapshot.panes ?? []).map((pane) => [pane.pane_id, pane]));
  await updateState((stateDoc) => {
    const sessionEntriesMap = sessionEntries(stateDoc, sessionKey);
    for (const [id, rank] of ranks) {
      const pane = paneById.get(id);
      if (!pane) continue;
      const entry = upsertEntry(sessionEntriesMap, pane, now.toISOString());
      entry.order = rank;
    }
  });

  emit({
    contract: CONTRACT,
    command: "order",
    pane_id: paneId,
    order: ranks.get(paneId) ?? null,
    placement,
    warnings: [],
  });
}

const TRACKER_REF_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+)#([1-9][0-9]*)$/;

/** Parse "<repo>#<number>" where repo is a forge path like "owner/name". */
export function parseTrackerRef(spec: string): { repo: string; number: number } {
  const match = TRACKER_REF_PATTERN.exec(spec);
  if (!match) {
    fail(`invalid tracker ref (expected <owner>/<repo>#<number>): ${spec}`, 2);
  }
  return { repo: match[1] as string, number: Number(match[2]) };
}

/** Exactly one of --pr/--issue must carry the tracker ref. */
function trackerKindAndRef(args: string[]): { kind: LinkKind; ref: string } {
  const pr = flagValue(args, "--pr");
  const issue = flagValue(args, "--issue");
  if ((pr === undefined) === (issue === undefined)) {
    fail("requires exactly one of --pr <repo>#<n> or --issue <repo>#<n>", 2);
  }
  return pr !== undefined ? { kind: "pr", ref: pr } : { kind: "issue", ref: issue as string };
}

const GH_VERIFY_TIMEOUT_MS = 15_000;

/**
 * Opt-in existence check via `gh`. Any failure (missing gh, auth, offline,
 * timeout, not found) is a warning — the user-declared link is still
 * recorded, per docs/specs/inbox.md (no event-driven auto-linking).
 *
 * Env hygiene (#216): the child gets `ghChildEnv` (git-core, shared with
 * the git plugin) — ambient `GH_DEBUG`/`GH_REPO`/`GH_FORCE_TTY` and every
 * repo-redirecting `GIT_*` are stripped so debug logs (which can carry
 * auth headers) or env retargeting can never reach the verify call.
 * gh's stderr is untrusted child output and is never copied into
 * `warnings[]` verbatim — a fake/malicious `gh` on PATH could otherwise
 * smuggle credential markers into the JSON result.
 */
async function verifyTrackerRef(
  kind: LinkKind,
  repo: string,
  number: number,
): Promise<string | null> {
  const ref = `${repo}#${number}`;
  return await new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("gh", [kind, "view", String(number), "--repo", repo, "--json", "number"], {
        env: ghChildEnv(),
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch (err) {
      resolve(`link verification unavailable (gh spawn failed): ${String(err)}; recorded anyway`);
      return;
    }
    let settled = false;
    const done = (message: string | null) => {
      if (!settled) {
        settled = true;
        resolve(message);
      }
    };
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
      done(`link verification timed out for ${ref}; recorded without verification`);
    }, GH_VERIFY_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      done(`link verification unavailable: ${String(err)}; recorded anyway`);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done(null);
      } else {
        done(`link verification failed for ${ref} (gh exit ${code}); recorded anyway`);
      }
    });
  });
}

function linkViews(links: PaneLink[] | undefined) {
  return (links ?? []).map(toPublicLink);
}

/**
 * Declare a user-owned tracker link (PR/Issue) on a pane. Links are explicit
 * references stored in plugin state — never derived from forge events — and
 * follow the same identity discipline as organize marks minus timed expiry
 * (agent-session fingerprint + seq regression). The pane must exist in the
 * session snapshot; re-linking the same ref re-validates its fingerprint.
 */
async function cmdLink(options: CliOptions): Promise<void> {
  // link writes plugin state: explicit or consistent ambient target required.
  options.mutation = true;
  const linkFlags: Record<string, FlagKind> = {
    "--pr": "value",
    "--issue": "value",
    "--verify": "boolean",
  };
  const linkValueFlags = ["--pr", "--issue"];
  validateFlags(options.args, linkFlags);
  assertMaxPositionals(options.args, linkValueFlags, 1, "link <pane_id>");
  const selection = resolvePaneSelection(options.args, linkValueFlags);
  const paneId = selection.paneId;
  const { kind, ref } = trackerKindAndRef(options.args);
  const { repo, number } = parseTrackerRef(ref);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  if (selection.ambient) assertAmbientPaneIdentity(pane, selection.ambient);
  const agent = snapshot.agents?.[paneId];

  const warnings: string[] = [];
  if (options.args.includes("--verify")) {
    const problem = await verifyTrackerRef(kind, repo, number);
    if (problem) warnings.push(problem);
  }

  const sessionKey = sessionKeyFor(options);
  await updateState((state) => {
    const entries = sessionEntries(state, sessionKey);
    linkPane(entries, pane, agent, { kind, repo, number, ref: `${repo}#${number}` }, now);
  });

  const fresh = await loadState();
  emit({
    contract: CONTRACT,
    command: "link",
    pane_id: paneId,
    link: { kind, repo, number, ref: `${repo}#${number}` },
    links: linkViews(fresh.sessions[sessionKey]?.[paneId]?.links),
    warnings,
  });
}

/** Remove one declared link; the pane must still exist in the snapshot. */
async function cmdUnlink(options: CliOptions): Promise<void> {
  // unlink writes plugin state: explicit or consistent ambient target required.
  options.mutation = true;
  const unlinkFlags: Record<string, FlagKind> = { "--pr": "value", "--issue": "value" };
  const unlinkValueFlags = ["--pr", "--issue"];
  validateFlags(options.args, unlinkFlags);
  assertMaxPositionals(options.args, unlinkValueFlags, 1, "unlink <pane_id>");
  const selection = resolvePaneSelection(options.args, unlinkValueFlags);
  const paneId = selection.paneId;
  const { kind, ref } = trackerKindAndRef(options.args);
  const { repo, number } = parseTrackerRef(ref);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
  if (selection.ambient) assertAmbientPaneIdentity(pane, selection.ambient);

  const sessionKey = sessionKeyFor(options);
  const removed = await updateState((state) => {
    const entries = sessionEntries(state, sessionKey);
    // An unlinked PR stops being watched: drop its poll baseline too.
    removeWatchLink(state, sessionKey, paneId, `${repo}#${number}`);
    return unlinkPane(entries, paneId, kind, repo, number, now);
  });
  if (!removed) {
    fail(`no matching ${kind} link on pane ${paneId}: ${repo}#${number}`);
  }

  const fresh = await loadState();
  emit({
    contract: CONTRACT,
    command: "unlink",
    pane_id: paneId,
    removed: toPublicLink(removed),
    links: linkViews(fresh.sessions[sessionKey]?.[paneId]?.links),
    warnings: [],
  });
}

/** Read the declared links stored for a pane (staleness already resolved). */
async function cmdLinks(options: CliOptions): Promise<void> {
  validateFlags(options.args, {});
  assertMaxPositionals(options.args, [], 1, "links <pane_id>");
  const selection = resolvePaneSelection(options.args);
  const paneId = selection.paneId;
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  if (selection.ambient) {
    assertAmbientPaneIdentity(await findPane(snapshot, paneId), selection.ambient);
  }
  const state = await loadState();
  const entries = state.sessions[sessionKeyFor(options)] ?? {};
  resolveState(entries, snapshot.agents ?? {}, now);
  const entry = entries[paneId];
  if (!entry) fail(`no inbox state for pane: ${paneId}`);
  emit({
    contract: CONTRACT,
    command: "links",
    pane_id: paneId,
    links: linkViews(entry.links),
    warnings: [],
  });
}

function emitLine(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Long-running reconciler. stdout is JSONL:
 *   {"contract","type":"watch.started"|"watch.reconcile"|"watch.stopped",...}
 * Stops on SIGINT/SIGTERM (exit 0) or unexpected stream end (exit 1).
 */
async function cmdWatch(options: CliOptions): Promise<void> {
  // watch reconciles (state writes + metadata projection) on every tick.
  options.mutation = true;
  validateFlags(options.args, { "--interval": "value" });
  assertMaxPositionals(options.args, ["--interval"], 0, "watch");
  const intervalRaw = flagValue(options.args, "--interval");
  const intervalSec = intervalRaw === undefined ? 60 : Number(intervalRaw);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    fail(`invalid --interval: ${intervalRaw} (expected a positive number of seconds)`, 2);
  }
  const intervalMs = intervalSec * 1000;

  const subscription = subscribeAgentEvents(options);
  await subscription.started;
  emitLine({ contract: CONTRACT, type: "watch.started", at: new Date().toISOString() });

  let stopping = false;
  const stop = () => {
    stopping = true;
    subscription.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const tick = async (trigger: "event" | "interval", event?: unknown) => {
    try {
      const result = await reconcileOnce(options);
      emitLine({
        contract: CONTRACT,
        type: "watch.reconcile",
        trigger,
        ...(event !== undefined ? { event } : {}),
        ...result,
      });
    } catch (err) {
      emitLine({
        contract: CONTRACT,
        type: "watch.error",
        trigger,
        error: String(err),
      });
    }
  };

  const ticker = setInterval(() => void tick("interval"), intervalMs);
  try {
    for await (const event of subscription.events) {
      if (stopping) break;
      await tick("event", event);
    }
  } finally {
    clearInterval(ticker);
    subscription.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  emitLine({
    contract: CONTRACT,
    type: "watch.stopped",
    reason: stopping ? "signal" : "stream_end",
    at: new Date().toISOString(),
  });
  if (!stopping) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// watch-pr: opt-in PR-update attention watcher (Issue #178)
// ---------------------------------------------------------------------------

const GIT_PLUGIN_ID = "rebuildup.git";
const WATCH_PR_DEFAULT_INTERVAL_SEC = 120;
/** Per git-plugin CLI call budget (covers ensureGh + the gh request). */
const WATCH_PR_CALL_TIMEOUT_MS = 30_000;
const WATCH_PR_FLAGS: Record<string, FlagKind> = {
  "--interval": "value",
  "--once": "boolean",
  "--git-root": "value",
};
const WATCH_PR_VALUE_FLAGS = ["--interval", "--git-root"];

interface PollOutcome {
  target: WatchTarget;
  ok: boolean;
  observation?: LinkWatchObservation;
  error?: string;
  diff?: WatchDiff;
  /** True when this poll established the baseline (no prior observation). */
  baseline: boolean;
  /** Committed watch record (set inside the state commit). */
  record?: LinkWatch;
}

function cliErrorMessage(result: { status: number; stderr: string }): string {
  const trimmed = result.stderr.trim();
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not a JSON error document
  }
  return trimmed.slice(0, 200) || `exit ${result.status}`;
}

/**
 * Poll one linked PR through the git plugin's public CLI — three reads per
 * tick: `pr view` (lifecycle/merge state/reviews), `pr comments`
 * (conversation + line comments), `pr checks` (per-check buckets). Any
 * failure fails the whole poll honestly; partial observations are never
 * diffed. gh itself is only ever reached inside the git plugin — this
 * plugin never spawns gh or handles tokens for watching.
 */
async function pollPrLink(
  gitRoot: string,
  target: WatchTarget,
  options: CliOptions,
): Promise<PollOutcome> {
  const { paneId, link } = target;
  const call = {
    session: options.session,
    socketPath: options.socketPath,
    timeoutMs: WATCH_PR_CALL_TIMEOUT_MS,
  };
  const run = async (action: string) =>
    runPluginCli(
      gitRoot,
      GIT_PLUGIN_ID,
      ["pr", action, paneId, String(link.number), "--repo", link.repo],
      call,
    );

  try {
    const view = await run("view");
    if (view.status !== 0 || view.json === null) {
      return {
        target,
        ok: false,
        error: `git pr view failed for ${link.ref}: ${cliErrorMessage(view)}`,
        baseline: target.baseline?.observation === undefined,
      };
    }
    const comments = await run("comments");
    if (comments.status !== 0 || comments.json === null) {
      return {
        target,
        ok: false,
        error: `git pr comments failed for ${link.ref}: ${cliErrorMessage(comments)}`,
        baseline: target.baseline?.observation === undefined,
      };
    }
    const checks = await run("checks");
    if (checks.status !== 0 || checks.json === null) {
      return {
        target,
        ok: false,
        error: `git pr checks failed for ${link.ref}: ${cliErrorMessage(checks)}`,
        baseline: target.baseline?.observation === undefined,
      };
    }
    const built = buildObservation(view.json, comments.json, checks.json);
    if ("error" in built) {
      return { target, ok: false, error: `${link.ref}: ${built.error}`, baseline: false };
    }
    return {
      target,
      ok: true,
      observation: built,
      baseline: target.baseline?.observation === undefined,
    };
  } catch (err) {
    return {
      target,
      ok: false,
      error: `git plugin invocation failed for ${link.ref}: ${String(err)}`,
      baseline: target.baseline?.observation === undefined,
    };
  }
}

interface AttentionRecord {
  paneId: string;
  ref: string;
  triggers: WatchDiff["triggers"];
  details: WatchDiff & { cleared: string[] };
}

/**
 * One watch-pr pass: snapshot → resolve links → poll each live non-terminal
 * PR link via the git plugin CLI → commit baselines/organize clears under
 * the state lock → project metadata → emit JSONL events. Returns the stop
 * reason when nothing watchable remains, else null.
 */
async function watchPrTick(
  options: CliOptions,
  ctx: {
    sessionKey: string;
    intervalMs: number;
    paneFilter: string | undefined;
    gitRoot: () => Promise<{ root: string | null; error: string | null; via: string | null }>;
  },
): Promise<string | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const snapshot = await sessionSnapshot(options);
  const agents = snapshot.agents ?? {};
  const panes = snapshot.panes ?? [];
  const livePaneIds = new Set(panes.map((pane) => pane.pane_id));

  const state0 = await loadState();
  const entries0 = state0.sessions[ctx.sessionKey] ?? {};
  resolveState(entries0, agents, now);
  const scan = collectWatchTargets(
    entries0,
    state0.watch?.[ctx.sessionKey],
    livePaneIds,
    ctx.paneFilter,
  );

  const git = await ctx.gitRoot();
  const outcomes: PollOutcome[] = [];
  for (const target of scan.targets) {
    if (target.baseline?.terminal !== undefined) continue;
    if (
      target.baseline?.next_poll_at !== undefined &&
      target.baseline.next_poll_at > now.getTime()
    ) {
      continue; // failure backoff — deferred, not polled
    }
    if (git.root === null) {
      outcomes.push({
        target,
        ok: false,
        error: `git plugin unavailable: ${git.error ?? "unknown"}`,
        baseline: target.baseline?.observation === undefined,
      });
      continue;
    }
    outcomes.push(await pollPrLink(git.root, target, options));
  }

  // Single commit: baselines, failure backoff, terminal marks, organize
  // clears for attention return, and baseline pruning — one lock, one write.
  const attention = new Map<string, AttentionRecord[]>();
  const committed = await updateState((state) => {
    const entries = sessionEntries(state, ctx.sessionKey);
    resolveState(entries, agents, now);
    pruneWatchSession(state, ctx.sessionKey, entries, agents, panes, now);
    // Only materialize the watch map when this pass has poll outcomes or a
    // pre-existing session map — an idle tick writes nothing new.
    const watch = state.watch?.[ctx.sessionKey] ?? (outcomes.length > 0 ? {} : undefined);
    if (watch === undefined) return outcomes;
    state.watch = { ...state.watch, [ctx.sessionKey]: watch };

    for (const outcome of outcomes) {
      const { paneId, ref } = outcome.target;
      const paneWatch = watch[paneId] ?? {};
      watch[paneId] = paneWatch;
      const record = paneWatch[ref] ?? { first_seen_at: nowIso, consecutive_failures: 0 };
      paneWatch[ref] = record;
      if (!outcome.ok) {
        record.consecutive_failures += 1;
        record.last_error = outcome.error ?? "unknown poll error";
        record.next_poll_at =
          now.getTime() + pollBackoffMs(ctx.intervalMs, record.consecutive_failures);
        outcome.record = record;
        continue;
      }
      const prev = record.observation;
      const diff = diffObservation(prev, outcome.observation as LinkWatchObservation);
      outcome.baseline = prev === undefined;
      record.observation = outcome.observation;
      outcome.record = record;
      record.last_checked_at = nowIso;
      delete record.last_error;
      record.consecutive_failures = 0;
      delete record.next_poll_at;
      if (diff.terminal !== undefined) record.terminal = diff.terminal;

      if (diff.triggers.length > 0) {
        // Attention return = clear hide-kind organize marks only. Pin,
        // order, and declared links survive; agent execution state is
        // never touched (attention is never hidden — this only un-hides).
        const entry = entries[paneId];
        const cleared: string[] = [];
        if (entry?.settled) {
          delete entry.settled;
          cleared.push("settled");
        }
        if (entry?.snoozed) {
          delete entry.snoozed;
          cleared.push("snoozed");
        }
        if (entry?.archived) {
          delete entry.archived;
          cleared.push("archived");
        }
        if (cleared.length > 0 && entry) entry.updated_at = nowIso;
        const list = attention.get(paneId) ?? [];
        list.push({
          paneId,
          ref,
          triggers: diff.triggers,
          details: { ...diff, cleared },
        });
        attention.set(paneId, list);
      }
      outcome.diff = diff;
    }
    return outcomes;
  });

  // Metadata projection + event emission happen after the commit so a
  // projection failure can never roll back or fabricate state.
  const fresh = await loadState();
  for (const [paneId, records] of attention) {
    const entry = fresh.sessions[ctx.sessionKey]?.[paneId];
    const paneWarnings = await projectMetadata(paneId, entry, options);
    emitLine({
      contract: CONTRACT,
      type: "watch-pr.attention",
      at: nowIso,
      pane_id: paneId,
      triggers: [...new Set(records.flatMap((r) => r.triggers))],
      links: records.map((r) => ({
        ref: r.ref,
        triggers: r.triggers,
        new_failing_checks: r.details.newFailingChecks,
        new_review_count: r.details.newReviewCount,
        new_comment_count: r.details.newCommentCount,
      })),
      cleared: [...new Set(records.flatMap((r) => r.details.cleared))],
      warnings: paneWarnings,
    });
  }

  let polled = 0;
  let failed = 0;
  let triggered = 0;
  for (const outcome of committed) {
    if (outcome.ok) {
      polled += 1;
      if ((outcome.diff?.triggers.length ?? 0) > 0) triggered += 1;
      const obs = outcome.observation;
      emitLine({
        contract: CONTRACT,
        type: "watch-pr.poll",
        at: nowIso,
        pane_id: outcome.target.paneId,
        ref: outcome.target.ref,
        ok: true,
        baseline: outcome.baseline,
        triggers: outcome.diff?.triggers ?? [],
        new_failing_checks: outcome.diff?.newFailingChecks ?? [],
        new_review_count: outcome.diff?.newReviewCount ?? 0,
        new_comment_count: outcome.diff?.newCommentCount ?? 0,
        terminal: outcome.diff?.terminal ?? null,
        observation: obs
          ? {
              state: obs.state,
              is_draft: obs.isDraft,
              merge_state_status: obs.mergeStateStatus,
              mergeable: obs.mergeable,
              updated_at: obs.updatedAt,
              failing_checks: obs.failingChecks,
              review_count: obs.reviewKeys.length,
              comment_count: obs.commentKeys.length,
            }
          : null,
        last_checked_at: nowIso,
      });
    } else {
      failed += 1;
      // Freshness honesty: report the committed backoff state and the age
      // of the last good observation — a failed poll is data, not silence.
      emitLine({
        contract: CONTRACT,
        type: "watch-pr.error",
        at: nowIso,
        pane_id: outcome.target.paneId,
        ref: outcome.target.ref,
        ok: false,
        error: outcome.error ?? "unknown",
        consecutive_failures: outcome.record?.consecutive_failures ?? 1,
        next_poll_at: outcome.record?.next_poll_at ?? null,
        last_checked_at: outcome.record?.last_checked_at ?? null,
      });
    }
  }

  // Deferred/terminal counts come from the committed records so they
  // reflect this tick's writes, not the pre-tick snapshot.
  let deferred = 0;
  let terminal = 0;
  const freshWatch = fresh.watch?.[ctx.sessionKey] ?? {};
  for (const target of scan.targets) {
    const record = freshWatch[target.paneId]?.[target.ref];
    if (record?.terminal !== undefined) {
      terminal += 1;
    } else if (record?.next_poll_at !== undefined && record.next_poll_at > now.getTime()) {
      deferred += 1;
    }
  }

  emitLine({
    contract: CONTRACT,
    type: "watch-pr.tick",
    at: nowIso,
    interval_ms: ctx.intervalMs,
    pane_filter: ctx.paneFilter ?? null,
    git_root: git.root,
    git_root_via: git.via,
    targets: scan.targets.length,
    absent_panes: scan.absentPaneIds,
    polled,
    deferred,
    failed,
    triggered,
    terminal,
  });

  // Stop conditions (opt-in process, no resident daemon): nothing declared,
  // or every declared PR link reached a terminal state. Absent-pane links
  // still count as pending — a temporarily missing pane may return.
  // Terminal status is read from the committed records so a PR that just
  // merged/closed this tick stops the watch immediately.
  const pendingLinks =
    scan.absentPaneIds.length +
    scan.targets.filter((t) => freshWatch[t.paneId]?.[t.ref]?.terminal === undefined).length;
  if (scan.totalPrLinks === 0) return "no_links";
  if (pendingLinks === 0) return "all_terminal";
  return null;
}

/**
 * `watch-pr [pane_id] [--interval SEC] [--once] [--git-root PATH]` —
 * opt-in JSONL watcher that polls declared PR links through the git
 * plugin's public CLI and restores attention (clears hide-kind organize
 * marks) on qualifying transitions. No resident daemon, no webhook
 * (ADR-0026); when not running, PR updates are simply not observed.
 */
async function cmdWatchPr(options: CliOptions): Promise<void> {
  // watch-pr clears hide-kind organize marks and rewrites pane metadata
  // tokens: a mutation of herdr-visible state, so the target must be
  // explicit or a consistent ambient context — never the implicit
  // default socket.
  options.mutation = true;
  validateFlags(options.args, WATCH_PR_FLAGS);
  assertMaxPositionals(options.args, WATCH_PR_VALUE_FLAGS, 1, "watch-pr [pane_id]");
  const intervalSec = Number(flagValue(options.args, "--interval") ?? "120");
  const intervalMs =
    (Number.isFinite(intervalSec) && intervalSec > 0
      ? intervalSec
      : WATCH_PR_DEFAULT_INTERVAL_SEC) * 1000;
  const once = options.args.includes("--once");
  const paneFilter = positionals(options.args, WATCH_PR_VALUE_FLAGS)[0];
  const gitRootFlag = flagValue(options.args, "--git-root");

  const sessionKey = sessionKeyFor(options);
  const config = await loadConfig();
  let resolved: { root: string | null; error: string | null; via: string | null } | undefined;
  const gitRoot = async () => {
    if (resolved !== undefined) return resolved;
    const result = await resolvePluginRoot(GIT_PLUGIN_ID, gitRootFlag ?? config.gitPluginRoot);
    resolved = result.ok
      ? { root: result.root, error: null, via: result.via }
      : { root: null, error: result.error, via: null };
    return resolved;
  };

  // Resolve up front so `watch-pr.started` reports the real discovery path.
  const git = await gitRoot();
  emitLine({
    contract: CONTRACT,
    type: "watch-pr.started",
    at: new Date().toISOString(),
    interval_ms: intervalMs,
    pane_filter: paneFilter ?? null,
    once,
    git_root: git.root,
    git_root_via: git.via,
    git_error: git.error,
  });

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const sleep = (ms: number) =>
    new Promise<void>((resolveSleep) => {
      const timer = setTimeout(() => {
        process.off("SIGINT", wake);
        process.off("SIGTERM", wake);
        resolveSleep();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        process.off("SIGINT", wake);
        process.off("SIGTERM", wake);
        resolveSleep();
      };
      process.on("SIGINT", wake);
      process.on("SIGTERM", wake);
    });

  let stopReason: string | null = null;
  try {
    for (;;) {
      try {
        const reason = await watchPrTick(options, {
          sessionKey,
          intervalMs,
          paneFilter,
          gitRoot,
        });
        // --once still reports the real stop evaluation when nothing is
        // watchable; "once" means a single pass completed with work pending.
        if (once) {
          stopReason = reason ?? "once";
          break;
        }
        if (reason !== null) {
          stopReason = reason;
          break;
        }
      } catch (err) {
        emitLine({
          contract: CONTRACT,
          type: "watch-pr.error",
          at: new Date().toISOString(),
          error: `tick failed: ${String(err)}`,
        });
      }
      if (stopping) {
        stopReason = "signal";
        break;
      }
      await sleep(intervalMs);
      if (stopping) {
        stopReason = "signal";
        break;
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  emitLine({
    contract: CONTRACT,
    type: "watch-pr.stopped",
    reason: stopReason ?? "signal",
    at: new Date().toISOString(),
  });
}

/**
 * `transitions` — read-only page over the per-session organize-transition
 * log (#182, ADR-0029). Consumers (rebuildup.projects settle triggers)
 * drain it via `--after <seq>`; `head_seq`/`oldest_seq`/`dropped` let a
 * consumer detect a cursor older than retention (`cursor_expired`)
 * instead of silently missing transitions.
 *
 * Read-only: expirations resolve through the same in-memory `resolveState`
 * path as `list` — nothing is persisted that `list` would not already
 * resolve identically on its own reads.
 */
async function cmdTransitions(options: CliOptions): Promise<void> {
  // Read-only: same in-memory resolve path as `list`; no mutation gating.
  validateFlags(options.args, { "--after": "value", "--limit": "value" });
  assertMaxPositionals(options.args, ["--after", "--limit"], 0, "transitions");
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const state = await loadState();
  const sessionKey = sessionKeyFor(options);
  const entries = state.sessions[sessionKey] ?? {};
  resolveState(entries, snapshot.agents ?? {}, now);

  const log = state.transitions?.[sessionKey];
  const items = log?.items ?? [];
  const headSeq = log?.seq ?? 0;
  const oldestSeq = items.length > 0 ? (items[0] as InboxTransition).seq : null;

  const afterRaw = flagValue(options.args, "--after");
  let after: number | null = null;
  if (afterRaw !== undefined) {
    after = Number(afterRaw);
    if (!Number.isInteger(after) || after < 0) {
      fail("--after must be a non-negative integer seq", 2);
    }
  }
  const limitRaw = flagValue(options.args, "--limit");
  const limit = limitRaw === undefined ? 200 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSITIONS_PER_SESSION) {
    fail(`--limit must be an integer between 1 and ${MAX_TRANSITIONS_PER_SESSION}`, 2);
  }

  // `--after` is exclusive. Without it the newest page is returned;
  // consumers always pass their stored cursor.
  const page =
    after === null ? items.slice(-limit) : items.filter((t) => t.seq > after).slice(0, limit);

  emit({
    contract: CONTRACT,
    command: "transitions",
    generated_at: now.toISOString(),
    session_key: sessionKey,
    head_seq: headSeq,
    oldest_seq: oldestSeq,
    dropped: log?.dropped ?? 0,
    transitions: page,
  });
}

async function cmdCapability(options: CliOptions): Promise<void> {
  validateFlags(options.args, {});
  assertMaxPositionals(options.args, [], 0, "capability");
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: "0.5.0",
    commands: [
      "list",
      "settle",
      "snooze",
      "restore",
      "pin",
      "unpin",
      "archive",
      "unarchive",
      "order",
      "link",
      "unlink",
      "links",
      "reconcile",
      "transitions",
      "watch",
      "watch-pr",
      "capability",
    ],
    actions: ["settle", "restore", "snooze", "pin", "unpin", "archive", "unarchive"],
    events: ["pane.agent_status_changed", "pane.closed"],
    startup: ["reconcile"],
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
  inbox pin <pane_id> [--session NAME]
  inbox unpin <pane_id> [--session NAME]
  inbox archive <pane_id> [--session NAME]
  inbox unarchive <pane_id> [--session NAME]
  inbox order <pane_id> (--first | --last | --before <pane_id> | --after <pane_id>) [--session NAME]
  inbox link <pane_id> (--pr <owner>/<repo>#<n> | --issue <owner>/<repo>#<n>) [--verify] [--session NAME]
  inbox unlink <pane_id> (--pr <owner>/<repo>#<n> | --issue <owner>/<repo>#<n>) [--session NAME]
  inbox links <pane_id> [--session NAME]
  inbox list [--attention] [--organize settled|snoozed|archived|none] [--search <text>] [--workspace <id>]
  inbox reconcile [--session NAME]
  inbox transitions [--after <seq>] [--limit <n>] [--session NAME]
  inbox watch [--interval SECONDS] [--session NAME]
  inbox watch-pr [pane_id] [--interval SECONDS] [--once] [--git-root PATH] [--session NAME]
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
    case "pin":
    case "unpin":
    case "archive":
    case "unarchive":
      return cmdOrganize(options, options.command);
    case "order":
      return cmdOrder(options);
    case "link":
      return cmdLink(options);
    case "unlink":
      return cmdUnlink(options);
    case "links":
      return cmdLinks(options);
    case "reconcile":
      return cmdReconcile(options);
    case "transitions":
      return cmdTransitions(options);
    case "_wake":
      return cmdWake(options);
    case "watch":
      return cmdWatch(options);
    case "watch-pr":
      return cmdWatchPr(options);
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
    if (err instanceof TargetResolutionError) {
      process.stderr.write(
        `${JSON.stringify({
          contract: CONTRACT,
          ok: false,
          error: { code: err.code, message: err.message },
        })}\n`,
      );
      process.exit(err.usage ? 2 : 1);
    }
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
