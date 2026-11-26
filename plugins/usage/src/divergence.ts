/**
 * Quota-vs-measured divergence report for rebuildup.usage
 * (Issue #92 / parent #28 T3).
 *
 * Compares subscription-quota windows (provider-reported
 * `used_percent` + reset instants) against transcript-measured token
 * sums. These are different units from different sources covering
 * different scopes (a quota window counts every client on the
 * subscription; the transcript index covers only locally indexed
 * sessions). The report places both sides side by side and labels the
 * comparison `different_units` — it never reconciles, never picks a
 * winner, and never converts percent into tokens or vice versa.
 */

import type {
  BreakdownEntry,
  DivergenceComparison,
  DivergenceMeasured,
  DivergenceQuotaSide,
  DivergenceVerdict,
  DivergenceWindowAlignment,
  QuotaProviderResult,
  QuotaWindow,
  UsageWindow,
} from "./model";

/** Fixed honest note attached to every `different_units` comparison. */
export const DIVERGENCE_NOTE =
  "quota windows report provider-side subscription utilization (used_percent of a " +
  "resetting window, covering every client on the account); measured totals are " +
  "transcript token sums over the requested window (local index only). Different " +
  "units, scopes, and sources — the two are reported side by side and never " +
  "reconciled into each other.";

export interface DivergenceInput {
  /** Provider rows from `coverage.providers` (includes zero-usage rows). */
  providers: { provider: string; provider_status?: string | null }[];
  /** Measured per-provider sums (`breakdowns.by_provider`). */
  measured: BreakdownEntry[];
  /** Direct provider quota results (`collectQuota` output). */
  quota: QuotaProviderResult[];
  /** The aggregation window the measured side covers. */
  window: UsageWindow;
}

function measuredFrom(entry: BreakdownEntry): DivergenceMeasured {
  return {
    events: entry.events,
    input_tokens: entry.input_tokens,
    output_tokens: entry.output_tokens,
    cache_read_input_tokens: entry.cache_read_input_tokens,
    cache_creation_input_tokens: entry.cache_creation_input_tokens,
    total_tokens: entry.total_tokens,
  };
}

function quotaSideFrom(result: QuotaProviderResult): DivergenceQuotaSide {
  return {
    status: result.status,
    detail: result.detail,
    plan: result.plan,
    checked_at: result.checked_at,
    stale: result.stale,
    windows: result.windows,
  };
}

/**
 * Does the measured window's span match any reported quota window
 * duration? Only describes alignment — a match does not imply the
 * measurements cover the same traffic.
 */
function windowAlignment(
  window: UsageWindow,
  quotaWindows: QuotaWindow[],
): DivergenceWindowAlignment {
  if (window.from_ms === null && window.to_ms === null) return "unbounded";
  if (window.from_ms === null || window.to_ms === null) return "unknown";
  const spanMins = (window.to_ms - window.from_ms) / 60_000;
  if (!Number.isFinite(spanMins) || spanMins <= 0) return "unknown";
  const usable = quotaWindows.filter(
    (w): w is QuotaWindow & { window_duration_mins: number } =>
      typeof w.window_duration_mins === "number" && w.window_duration_mins > 0,
  );
  if (usable.length === 0) return "unknown";
  const tolerance = Math.max(2, spanMins * 0.05);
  return usable.some((w) => Math.abs(w.window_duration_mins - spanMins) <= tolerance)
    ? "matches_quota_window"
    : "custom_window";
}

function verdictFor(
  quotaOk: boolean,
  measured: DivergenceMeasured | null,
  quotaDetail: string | null,
): { verdict: DivergenceVerdict; detail: string | null } {
  if (!quotaOk) {
    if (measured === null) {
      return { verdict: "no_data", detail: quotaDetail };
    }
    return { verdict: "quota_unavailable", detail: quotaDetail };
  }
  if (measured === null) {
    return {
      verdict: "no_measured_usage",
      detail: "quota answered but the transcript index has no usage events for this provider",
    };
  }
  return { verdict: "different_units", detail: DIVERGENCE_NOTE };
}

/**
 * Build one comparison per provider seen on either side. Pure: same
 * input → same output; safe to unit test without I/O.
 */
export function buildDivergence(input: DivergenceInput): DivergenceComparison[] {
  const measuredByProvider = new Map(
    input.measured
      .filter((b): b is BreakdownEntry & { key: string } => typeof b.key === "string")
      .map((b) => [b.key, b]),
  );
  const quotaByProvider = new Map(input.quota.map((q) => [q.provider, q]));

  const providerIds = new Set<string>([
    ...input.providers.map((p) => p.provider),
    ...input.quota.map((q) => q.provider),
  ]);

  const comparisons: DivergenceComparison[] = [];
  for (const provider of [...providerIds].sort()) {
    const measuredEntry = measuredByProvider.get(provider);
    const measured = measuredEntry !== undefined ? measuredFrom(measuredEntry) : null;
    const quotaResult = quotaByProvider.get(provider) ?? null;
    const quota = quotaResult !== null ? quotaSideFrom(quotaResult) : null;
    const quotaOk = quotaResult?.status === "ok";
    const { verdict, detail } = verdictFor(
      quotaOk,
      measured,
      quotaResult !== null
        ? (quotaResult.detail ?? `quota status "${quotaResult.status}"`)
        : "no quota source registered for this provider",
    );
    comparisons.push({
      provider,
      verdict,
      detail,
      quota,
      measured,
      window_alignment: windowAlignment(input.window, quotaOk ? (quotaResult?.windows ?? []) : []),
    });
  }
  return comparisons;
}
