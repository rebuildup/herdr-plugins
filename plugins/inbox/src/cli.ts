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

import { spawn } from "node:child_process";
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
import {
  type InboxEntry,
  type LinkKind,
  loadState,
  type PaneLink,
  PLUGIN_ID,
  sessionEntries,
  sessionKeyFor,
  stateFilePath,
  updateState,
} from "./state";

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
      arg === "--before" ||
      arg === "--after" ||
      arg === "--organize" ||
      arg === "--search" ||
      arg === "--workspace" ||
      arg === "--pr" ||
      arg === "--issue" ||
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

async function cmdList(options: CliOptions): Promise<void> {
  const now = new Date();
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
      name: options.session ?? process.env.HERDR_SESSION ?? null,
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
  const paneId = await resolvePaneId(options.args);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
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
  const entry = await updateState(async (state) => {
    const entries = sessionEntries(state, sessionKey);
    switch (kind) {
      case "settle":
        return settlePane(entries, pane, agent, now);
      case "snooze":
        return snoozePane(entries, pane, agent, until as Date, now);
      case "restore":
        restorePane(entries, paneId);
        return undefined;
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
    const cleared = resolveState(entries, agents, now).clearedPaneIds;
    const pruned = pruneState(entries, livePaneIds, now);
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
  const paneId = await resolvePaneId(options.args);
  const placement = parseOrderPlacement(options.args);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
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
        stdio: ["ignore", "ignore", "pipe"],
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
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      done(`link verification unavailable: ${String(err)}; recorded anyway`);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done(null);
      } else {
        const detail = stderr.trim().slice(0, 200);
        done(
          `link verification failed for ${ref} (gh exit ${code}${detail ? `: ${detail}` : ""}); recorded anyway`,
        );
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
  const paneId = await resolvePaneId(options.args);
  const { kind, ref } = trackerKindAndRef(options.args);
  const { repo, number } = parseTrackerRef(ref);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  const pane = await findPane(snapshot, paneId);
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
  const paneId = await resolvePaneId(options.args);
  const { kind, ref } = trackerKindAndRef(options.args);
  const { repo, number } = parseTrackerRef(ref);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
  await findPane(snapshot, paneId);

  const sessionKey = sessionKeyFor(options);
  const removed = await updateState((state) => {
    const entries = sessionEntries(state, sessionKey);
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
  const paneId = await resolvePaneId(options.args);
  const now = new Date();
  const snapshot = await sessionSnapshot(options);
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
  const intervalSec = Number(flagValue(options.args, "--interval") ?? "60");
  const intervalMs = (Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 60) * 1000;

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

async function cmdCapability(options: CliOptions): Promise<void> {
  emit({
    contract: CONTRACT,
    plugin: PLUGIN_ID,
    version: "0.3.0",
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
      "watch",
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
    case "_wake":
      return cmdWake(options);
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
