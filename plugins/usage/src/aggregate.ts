/**
 * Pure aggregation core for rebuildup.usage.
 *
 * Consumes the raw usage-carrying events exported by
 * `rebuildup.conversations usage` plus the session registry entries the
 * same command reports, and produces totals + dimension breakdowns +
 * honest coverage. No I/O lives here — every rule that can fabricate a
 * number is decided in this file and unit-tested directly.
 *
 * Honesty rules (contract `herdr-plugins.usage/v1`):
 * - Only provider-reported `usage` objects are summed; a session with
 *   no usage events contributes zero events, not zeroed "measurement".
 * - Duplicate `(session_key, event_id)` pairs are skipped and counted —
 *   index rewrites (opencode rescan) can replay events mid-scan.
 * - Events without a usable timestamp are excluded when a `--from`/`--to`
 *   window is set (counted), included otherwise (counted separately).
 * - `thinking_tokens` / `provider_reported_cost_usd` stay `null` unless
 *   at least one contributing event reported them — missing is never
 *   folded into a fabricated zero.
 */

import type {
  BreakdownEntry,
  CacheTokenProviderEntry,
  CacheTokenStatus,
  ProviderCoverage,
  SessionCoverageEntry,
  UsageAggregate,
  UsageBreakdowns,
  UsageCacheTokens,
  UsageEventRecord,
  UsageTotals,
  UsageWindow,
} from "./model";

interface MutableBucket {
  key: string | null;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  thinking_tokens: number;
  thinking_seen: boolean;
  total_tokens: number;
  cost_usd: number;
  cost_seen: boolean;
}

function newBucket(key: string | null): MutableBucket {
  return {
    key,
    events: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    thinking_tokens: 0,
    thinking_seen: false,
    total_tokens: 0,
    cost_usd: 0,
    cost_seen: false,
  };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Parse the provider `usage` object; null when absent/malformed. */
function usageFields(raw: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  thinking: number | null;
} | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const input = tokenCount(u.input_tokens);
  const output = tokenCount(u.output_tokens);
  const cacheRead = tokenCount(u.cache_read_input_tokens);
  const cacheCreate = tokenCount(u.cache_creation_input_tokens);
  const thinkingRaw = u.thinking_tokens;
  const thinking =
    typeof thinkingRaw === "number" && Number.isFinite(thinkingRaw) && thinkingRaw > 0
      ? Math.floor(thinkingRaw)
      : null;
  if (input + output + cacheRead + cacheCreate + (thinking ?? 0) === 0) return null;
  return { input, output, cacheRead, cacheCreate, thinking };
}

function eventTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function inWindow(tsMs: number, window: UsageWindow): boolean {
  if (window.from_ms !== null && tsMs < window.from_ms) return false;
  if (window.to_ms !== null && tsMs > window.to_ms) return false;
  return true;
}

function asIdentity(raw: unknown): {
  host: string | null;
  pane_id: string | null;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { host: null, pane_id: null };
  }
  const i = raw as Record<string, unknown>;
  return {
    host: typeof i.host === "string" && i.host !== "" ? i.host : null,
    pane_id: typeof i.pane_id === "string" && i.pane_id !== "" ? i.pane_id : null,
  };
}

function addToBucket(
  bucket: MutableBucket,
  fields: NonNullable<ReturnType<typeof usageFields>>,
  cost: number | null,
): void {
  bucket.events += 1;
  bucket.input_tokens += fields.input;
  bucket.output_tokens += fields.output;
  bucket.cache_read_input_tokens += fields.cacheRead;
  bucket.cache_creation_input_tokens += fields.cacheCreate;
  bucket.total_tokens += fields.input + fields.output + fields.cacheRead + fields.cacheCreate;
  if (fields.thinking !== null) {
    bucket.thinking_tokens += fields.thinking;
    bucket.thinking_seen = true;
  }
  if (cost !== null) {
    bucket.cost_usd += cost;
    bucket.cost_seen = true;
  }
}

function freezeBucket(bucket: MutableBucket): BreakdownEntry {
  return {
    key: bucket.key,
    events: bucket.events,
    input_tokens: bucket.input_tokens,
    output_tokens: bucket.output_tokens,
    cache_read_input_tokens: bucket.cache_read_input_tokens,
    cache_creation_input_tokens: bucket.cache_creation_input_tokens,
    thinking_tokens: bucket.thinking_seen ? bucket.thinking_tokens : null,
    total_tokens: bucket.total_tokens,
    provider_reported_cost_usd: bucket.cost_seen ? bucket.cost_usd : null,
  };
}

function sortBuckets(buckets: Map<string, MutableBucket>): BreakdownEntry[] {
  return [...buckets.values()]
    .map(freezeBucket)
    .sort((a, b) => b.total_tokens - a.total_tokens || b.events - a.events);
}

function bucketKey(map: Map<string, MutableBucket>, key: string | null): MutableBucket {
  const mapKey = key ?? "";
  let bucket = map.get(mapKey);
  if (!bucket) {
    bucket = newBucket(key);
    map.set(mapKey, bucket);
  }
  return bucket;
}

export interface AggregateInput {
  events: UsageEventRecord[];
  sessions: SessionCoverageEntry[];
  window: UsageWindow;
  /** Provider support status per provider id (from conversations capability). */
  providerStatus?: Record<string, string>;
}

/**
 * Aggregate exported usage events into totals, breakdowns, and coverage.
 * Pure: same input → same output; safe to unit test without I/O.
 */
export function aggregateUsage(input: AggregateInput): UsageAggregate {
  const { events, sessions, window } = input;
  const providerStatus = input.providerStatus ?? {};

  const seen = new Set<string>();
  const totals: UsageTotals = {
    events: 0,
    sessions_with_usage: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    thinking_tokens: null,
    thinking_token_events: 0,
    total_tokens: 0,
    provider_reported_cost_usd: null,
    provider_reported_cost_events: 0,
    excluded_untimestamped_events: 0,
    duplicate_events_skipped: 0,
    events_without_event_id: 0,
  };

  const byProvider = new Map<string, MutableBucket>();
  const byModel = new Map<string, MutableBucket>();
  const byHost = new Map<string, MutableBucket>();
  const byProject = new Map<string, MutableBucket>();
  const bySession = new Map<string, MutableBucket>();
  const byPane = new Map<string, MutableBucket>();
  const sessionsWithUsage = new Set<string>();
  const sessionByKey = new Map(sessions.map((s) => [s.key, s]));

  for (const record of events) {
    const event = record.event ?? {};
    const fields = usageFields(event.usage);
    if (fields === null) continue; // defensive: source already filters

    // Dedup on (session_key, event_id); missing ids cannot be deduped.
    const eventId =
      typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : null;
    if (eventId === null) {
      totals.events_without_event_id += 1;
    } else {
      const dedupKey = `${record.session_key} ${eventId}`;
      if (seen.has(dedupKey)) {
        totals.duplicate_events_skipped += 1;
        continue;
      }
      seen.add(dedupKey);
    }

    // Time window: untimestamped events cannot be placed — excluded
    // (counted) when a window is set, included otherwise.
    const ts = eventTimestamp(event.timestamp);
    const windowed = window.from_ms !== null || window.to_ms !== null;
    if (ts === null) {
      if (windowed) {
        totals.excluded_untimestamped_events += 1;
        continue;
      }
    } else if (windowed && !inWindow(ts, window)) {
      continue;
    }

    const identity = asIdentity(event.identity);
    const model = typeof event.model === "string" && event.model !== "" ? event.model : null;
    const provider = record.session_key.includes(":")
      ? (record.session_key.split(":", 1)[0] ?? null)
      : null;
    const sessionEntry = sessionByKey.get(record.session_key);
    const project = sessionEntry?.cwd ?? null;
    const cost =
      typeof event.cost_usd === "number" && Number.isFinite(event.cost_usd) && event.cost_usd >= 0
        ? event.cost_usd
        : null;

    totals.events += 1;
    totals.input_tokens += fields.input;
    totals.output_tokens += fields.output;
    totals.cache_read_input_tokens += fields.cacheRead;
    totals.cache_creation_input_tokens += fields.cacheCreate;
    totals.total_tokens += fields.input + fields.output + fields.cacheRead + fields.cacheCreate;
    if (fields.thinking !== null) {
      totals.thinking_token_events += 1;
      totals.thinking_tokens = (totals.thinking_tokens ?? 0) + fields.thinking;
    }
    if (cost !== null) {
      totals.provider_reported_cost_events += 1;
      totals.provider_reported_cost_usd = (totals.provider_reported_cost_usd ?? 0) + cost;
    }
    sessionsWithUsage.add(record.session_key);

    addToBucket(bucketKey(byProvider, provider), fields, cost);
    addToBucket(bucketKey(byModel, model), fields, cost);
    addToBucket(bucketKey(byHost, identity.host), fields, cost);
    addToBucket(bucketKey(byProject, project), fields, cost);
    addToBucket(bucketKey(bySession, record.session_key), fields, cost);
    addToBucket(bucketKey(byPane, identity.pane_id), fields, cost);
  }

  totals.sessions_with_usage = sessionsWithUsage.size;

  // Coverage: registry truth, not measured truth. A session with no
  // usage events is still listed — "no measured usage" is not "zero".
  const providerMap = new Map<string, ProviderCoverage>();
  let ok = 0;
  let issues = 0;
  let stale = 0;
  let eventsMissing = 0;
  const contributing = sessions.filter((s) => sessionsWithUsage.has(s.key));

  for (const session of sessions) {
    const status = session.status ?? "unknown";
    const hasIssue = status !== "ok" || session.events_present === false || session.error != null;
    if (hasIssue) issues += 1;
    else ok += 1;
    if (session.stale === true) stale += 1;
    if (session.events_present === false) eventsMissing += 1;

    const provider = session.provider ?? "unknown";
    let entry = providerMap.get(provider);
    if (!entry) {
      entry = {
        provider,
        provider_status: providerStatus[provider] ?? session.provider_status ?? "unknown",
        sessions: 0,
        sessions_ok: 0,
        sessions_with_issues: 0,
        usage_events: 0,
      };
      providerMap.set(provider, entry);
    }
    entry.sessions += 1;
    if (hasIssue) entry.sessions_with_issues += 1;
    else entry.sessions_ok += 1;
  }
  for (const key of sessionsWithUsage) {
    const provider = key.includes(":") ? (key.split(":", 1)[0] ?? "unknown") : "unknown";
    const entry = providerMap.get(provider);
    if (entry) entry.usage_events += 1;
  }

  const breakdowns: UsageBreakdowns = {
    by_provider: sortBuckets(byProvider),
    by_model: sortBuckets(byModel),
    by_host: sortBuckets(byHost),
    by_project: sortBuckets(byProject),
    by_session: sortBuckets(bySession),
    by_pane: sortBuckets(byPane),
  };

  return {
    totals,
    breakdowns,
    coverage: {
      sessions_total: sessions.length,
      sessions_ok: ok,
      sessions_with_issues: issues,
      sessions_stale: stale,
      sessions_events_missing: eventsMissing,
      providers: [...providerMap.values()].sort(
        (a, b) => b.usage_events - a.usage_events || a.provider.localeCompare(b.provider),
      ),
    },
    sessions: contributing,
  };
}

// --- cache token breakdown (T3 / #92) -------------------------------------------

export interface CacheTokenInput {
  /** Provider rows from `coverage.providers` (includes zero-usage rows). */
  providers: { provider: string; provider_status?: string | null }[];
  /** Measured per-provider sums (`breakdowns.by_provider`). */
  measured: BreakdownEntry[];
  /**
   * Adapter-declared cache capability per provider id — the
   * conversations `capability.providers[].usage.cache_tokens` value.
   * Absent/unknown ids yield `unknown`, never a guessed `reported`.
   */
  cacheCapability?: Record<string, string> | undefined;
}

function cacheStatusFor(
  provider: string,
  providerStatus: string | null | undefined,
  capability: string | undefined,
): { status: CacheTokenStatus; detail: string | null } {
  if (providerStatus === "unsupported") {
    return {
      status: "unsupported",
      detail: "provider adapter is unsupported; no usage events can be indexed",
    };
  }
  if (capability === "unsupported") {
    return {
      status: "unsupported",
      detail: "provider adapter declares no cache-token accounting",
    };
  }
  if (providerStatus === "supported" && capability === "reported") {
    return { status: "reported", detail: null };
  }
  return {
    status: "unknown",
    detail: `cache-token capability not verified for provider "${provider}"`,
  };
}

/**
 * Per-provider cache-token view. Token sums come from the measured
 * breakdown; `status` comes from the adapter capability matrix — a
 * provider that does not account for cache tokens is `unsupported`
 * explicitly, and an unverifiable one is `unknown`. Zero sums on a
 * `reported` provider mean "no cache tokens measured", which is a
 * measurement, not a fabricated zero.
 */
export function buildCacheTokens(input: CacheTokenInput): UsageCacheTokens {
  const measuredByProvider = new Map(input.measured.map((b) => [b.key, b]));
  const providers: CacheTokenProviderEntry[] = input.providers.map((p) => {
    const measured = measuredByProvider.get(p.provider);
    const verdict = cacheStatusFor(
      p.provider,
      p.provider_status,
      input.cacheCapability?.[p.provider],
    );
    return {
      provider: p.provider,
      status: verdict.status,
      events: measured?.events ?? 0,
      cache_read_input_tokens: measured?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: measured?.cache_creation_input_tokens ?? 0,
      detail: verdict.detail,
    };
  });
  providers.sort((a, b) => b.events - a.events || a.provider.localeCompare(b.provider));
  return { providers };
}
