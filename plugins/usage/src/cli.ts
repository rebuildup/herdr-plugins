/**
 * rebuildup.usage CLI — token usage aggregation contract
 * (`herdr-plugins.usage/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * Aggregation consumes the `rebuildup.conversations` read-only export
 * (`usage` event paging + `capability` provider matrix) — never its
 * state files, never PTY text (ADR-0013). The plugin is read-only and
 * keeps no durable state: totals are recomputed from the index on
 * every call.
 */

import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import { aggregateUsage } from "./aggregate";
import { CONTRACT, CONVERSATIONS_CONTRACT, type SourceOptions } from "./model";
import {
  type CliCallOptions,
  exportUsageEvents,
  fetchConversationsCapability,
  resolveConversationsSource,
  type UsageSelectors,
} from "./source";

const PLUGIN_ID = "rebuildup.usage";
const PLUGIN_VERSION = "0.5.0";

interface CliOptions {
  command: string;
  args: string[];
  session: string | undefined;
  socketPath: string | undefined;
  timeoutMs: number | undefined;
  offline: boolean | undefined;
  pane: string | undefined;
  sessionId: string | undefined;
  provider: string | undefined;
  from: string | undefined;
  to: string | undefined;
  conversationsRoot: string | undefined;
  conversationsStateDir: string | undefined;
  conversationsConfigDir: string | undefined;
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
    offline: undefined,
    pane: undefined,
    sessionId: undefined,
    provider: undefined,
    from: undefined,
    to: undefined,
    conversationsRoot: undefined,
    conversationsStateDir: undefined,
    conversationsConfigDir: undefined,
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const next = () => args[++i];
    if (arg === "--session") options.session = next();
    else if (arg === "--session-id") options.sessionId = next();
    else if (arg === "--pane") options.pane = next();
    else if (arg === "--provider") options.provider = next();
    else if (arg === "--from") options.from = next();
    else if (arg === "--to") options.to = next();
    else if (arg === "--socket") options.socketPath = next();
    else if (arg === "--timeout") {
      const value = Number(next());
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else if (arg === "--offline") options.offline = true;
    else if (arg === "--conversations-root") options.conversationsRoot = next();
    else if (arg === "--conversations-state-dir") options.conversationsStateDir = next();
    else if (arg === "--conversations-config-dir") options.conversationsConfigDir = next();
    else rest.push(arg);
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
  if (kind) error.kind = kind;
  if (extra) Object.assign(error, extra);
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function now(): string {
  return new Date().toISOString();
}

// --- config ------------------------------------------------------------------

interface PluginConfig {
  timeoutMs?: number;
  conversationsRoot?: string;
  conversationsStateDir?: string;
  conversationsConfigDir?: string;
}

async function loadConfig(): Promise<PluginConfig> {
  const file = path.join(pluginDirs(PLUGIN_ID).configDir, "config.json");
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(file, "utf8")) as PluginConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** CLI flag > env > config.json > default for each source override. */
function sourceOptions(
  flags: {
    conversationsRoot?: string | undefined;
    conversationsStateDir?: string | undefined;
    conversationsConfigDir?: string | undefined;
  },
  config: PluginConfig,
): SourceOptions {
  return {
    conversationsRoot:
      flags.conversationsRoot ??
      process.env.HERDR_USAGE_CONVERSATIONS_ROOT ??
      config.conversationsRoot,
    conversationsStateDir:
      flags.conversationsStateDir ??
      process.env.HERDR_USAGE_CONVERSATIONS_STATE_DIR ??
      config.conversationsStateDir,
    conversationsConfigDir:
      flags.conversationsConfigDir ??
      process.env.HERDR_USAGE_CONVERSATIONS_CONFIG_DIR ??
      config.conversationsConfigDir,
  };
}

function callOptions(options: CliOptions, config: PluginConfig): CliCallOptions {
  const call: CliCallOptions = {};
  if (options.session !== undefined) call.session = options.session;
  if (options.socketPath !== undefined) call.socketPath = options.socketPath;
  const timeout = options.timeoutMs ?? config.timeoutMs;
  if (timeout !== undefined) call.timeoutMs = timeout;
  if (options.offline === true) call.offline = true;
  return call;
}

// --- capability ---------------------------------------------------------------

async function cmdCapability(): Promise<void> {
  const config = await loadConfig();
  const resolved = await resolveConversationsSource(sourceOptions({}, config));
  // capability must never fail on source resolution — report it.
  const sourceEntry = resolved.ok
    ? {
        id: "conversations-index",
        kind: "normalized-events",
        contract: CONVERSATIONS_CONTRACT,
        status: "available",
        plugin_root: resolved.source.plugin_root,
        resolved_via: resolved.source.resolved_via,
        freshness:
          "as of the last `rebuildup.conversations index`/`refresh` run; run it to pick up new transcripts",
      }
    : {
        id: "conversations-index",
        kind: "normalized-events",
        contract: CONVERSATIONS_CONTRACT,
        status: "unavailable",
        detail: resolved.error,
      };

  emit({
    contract: CONTRACT,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    read_only: true,
    mutation_commands: [],
    commands: ["capability", "usage"],
    sources: [
      sourceEntry,
      {
        id: "subscription-quota-api",
        kind: "provider-quota",
        status: "unsupported",
        planned_in: "#91",
        detail:
          "Provider subscription quota/reset endpoints require credential access; boundary ADR lands in T2 (#91).",
      },
      {
        id: "provider-cli-billing",
        kind: "cli-billing-endpoint",
        status: "unsupported",
        planned_in: "#92",
        detail:
          "CLI billing endpoints and HTTP quota sources land in T3 (#92) on top of the T2 credential boundary.",
      },
    ],
    aggregation: {
      dimensions: ["provider", "model", "host", "project", "session", "pane"],
      window: "--from/--to ISO-8601 bounds on event timestamps (inclusive)",
      dedup: "(session_key, event_id); index rewrites are flagged, never hidden",
      honesty:
        "missing usage is never zero-fabricated; provider_reported_cost_usd is not a billing amount",
    },
    generated_at: now(),
  });
}

// --- usage --------------------------------------------------------------------

function parseWindow(options: CliOptions): { from_ms: number | null; to_ms: number | null } {
  let fromMs: number | null = null;
  let toMs: number | null = null;
  if (options.from !== undefined) {
    fromMs = Date.parse(options.from);
    if (Number.isNaN(fromMs)) fail(`invalid --from timestamp: ${options.from}`, 2);
  }
  if (options.to !== undefined) {
    toMs = Date.parse(options.to);
    if (Number.isNaN(toMs)) fail(`invalid --to timestamp: ${options.to}`, 2);
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    fail(`--from (${options.from}) is after --to (${options.to})`, 2);
  }
  return { from_ms: fromMs, to_ms: toMs };
}

async function cmdUsage(options: CliOptions): Promise<void> {
  const config = await loadConfig();
  const window = parseWindow(options);
  const resolved = await resolveConversationsSource(sourceOptions(options, config));
  if (!resolved.ok) {
    fail(resolved.error, 1, resolved.kind, {
      hint: "install rebuildup.conversations or set conversationsRoot in config.json",
    });
  }
  const source = resolved.source;
  const call = callOptions(options, config);
  const selectors: UsageSelectors = {
    pane: options.pane,
    sessionId: options.sessionId,
    provider: options.provider,
  };

  const exported = await exportUsageEvents(source, call, selectors);
  if ("error" in exported) {
    fail(exported.error, 1, exported.kind);
  }

  const capability = await fetchConversationsCapability(source, call);
  const providerStatus: Record<string, string> = {};
  for (const p of capability?.providers ?? []) providerStatus[p.id] = p.status;

  const aggregate = aggregateUsage({
    events: exported.events,
    sessions: exported.sessions,
    window,
    providerStatus,
  });

  // Providers declared by conversations but with zero indexed sessions
  // still belong in coverage — "supported but nothing indexed" is a
  // different state from "unsupported".
  const seenProviders = new Set(aggregate.coverage.providers.map((p) => p.provider));
  for (const p of capability?.providers ?? []) {
    if (seenProviders.has(p.id)) continue;
    aggregate.coverage.providers.push({
      provider: p.id,
      provider_status: p.status,
      sessions: 0,
      sessions_ok: 0,
      sessions_with_issues: 0,
      usage_events: 0,
    });
  }
  aggregate.coverage.providers.sort(
    (a, b) => b.usage_events - a.usage_events || a.provider.localeCompare(b.provider),
  );

  const warnings: string[] = [];
  if (!exported.complete) warnings.push("export_incomplete_page_limit");
  if (exported.malformed_lines > 0) warnings.push("index_malformed_lines");
  if (exported.duplicates_skipped > 0) warnings.push("index_duplicate_events_skipped");
  if (exported.restarted_sessions.length > 0) warnings.push("index_sessions_restarted");
  if (aggregate.totals.excluded_untimestamped_events > 0) {
    warnings.push("untimestamped_events_excluded_by_window");
  }
  if (aggregate.totals.duplicate_events_skipped > 0) warnings.push("duplicate_events_skipped");
  if (aggregate.totals.events_without_event_id > 0) warnings.push("events_without_event_id");

  emit({
    contract: CONTRACT,
    command: "usage",
    window:
      window.from_ms === null && window.to_ms === null
        ? null
        : {
            from: options.from ?? null,
            to: options.to ?? null,
          },
    filters: {
      pane_id: options.pane ?? null,
      session_id: options.sessionId ?? null,
      provider: options.provider ?? null,
    },
    totals: aggregate.totals,
    breakdowns: aggregate.breakdowns,
    coverage: aggregate.coverage,
    sessions: aggregate.sessions,
    source: {
      plugin: "rebuildup.conversations",
      contract: exported.contract ?? CONVERSATIONS_CONTRACT,
      plugin_root: source.plugin_root,
      resolved_via: source.resolved_via,
      pages: exported.pages,
      complete: exported.complete,
    },
    warnings,
    ...(aggregate.totals.events === 0 && aggregate.coverage.sessions_total === 0
      ? {
          hint: "no indexed sessions; run `rebuildup.conversations index` to build the transcript index",
        }
      : {}),
    generated_at: now(),
  });
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "capability":
      return cmdCapability();
    case "usage":
      return cmdUsage(options);
    case "help":
    case "--help":
    case "-h":
      emit({
        contract: CONTRACT,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        usage:
          "bun run src/cli.ts <capability|usage> [--pane PANE] [--session-id ID] [--provider ID] [--from ISO] [--to ISO] [--session NAME] [--socket PATH] [--timeout MS] [--offline] [--conversations-root DIR] [--conversations-state-dir DIR]",
      });
      return;
    default:
      fail(`unknown command: ${options.command}`, 2);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
