/**
 * Plugin state retention / GC for rebuildup.usage (Issue #93 /
 * parent #28 T4).
 *
 * The plugin's only durable state is short-lived caches under
 * `HERDR_PLUGIN_STATE_DIR`:
 *
 * | path | contents | fresh TTL | retention |
 * | --- | --- | --- | --- |
 * | `quota-cache/<provider>.json` | provider quota windows (quota numbers only — never credentials, ADR-0014) | `quotaCacheTtlSeconds` (default 300s) | `PLUGIN_CACHE_RETENTION_SECONDS` |
 * | `quota-cache/hub-<id>.json` | hub account quota windows (ADR-0015) | same | same |
 * | `pricing-cache/litellm.json` | parsed LiteLLM rate table (public prices, no secrets) | `pricingCacheTtlSeconds` (default 24h) | same |
 *
 * `usage` itself keeps **no** aggregate index — totals are recomputed
 * from the conversations index on every call, so there is nothing
 * usage-side to retain or collect. The conversations event index is
 * owned (and retained) by `rebuildup.conversations`.
 *
 * Retention rule: a cache entry is a *referenced* reading while its
 * payload timestamp is younger than the retention window — fresh
 * reads, in-TTL hits, and stale-serve-on-failure all qualify. GC
 * deletes only entries **older** than retention (plus orphaned
 * `*.tmp-*` write temps and unparseable files, which no reader can
 * reference). Reads additionally refuse to serve entries past
 * retention, so a failed GC can never resurrect ancient data.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Hard retention for every plugin cache entry, in seconds (30 days).
 * Bounds both disk growth and how old a "stale" reading may be.
 */
export const PLUGIN_CACHE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** Cache subdirectories owned by this plugin. */
const CACHE_DIRS = ["quota-cache", "pricing-cache"] as const;

export interface CacheGcResult {
  /** Cache files examined across all cache dirs. */
  scanned: number;
  /** Paths removed (absolute). */
  removed: string[];
}

function payloadTimestamp(parsed: unknown): number | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const raw = record.checked_at ?? record.fetched_at;
  if (typeof raw !== "string" || raw === "") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Remove expired cache entries under `<stateDir>`. Best-effort and
 * non-throwing: GC must never fail a report. Entries at or under
 * `retentionSeconds` old are always kept — referenced data is never
 * deleted.
 */
export async function gcPluginStateCache(
  stateDir: string,
  options: { retentionSeconds?: number; now?: () => number } = {},
): Promise<CacheGcResult> {
  const retentionSeconds = options.retentionSeconds ?? PLUGIN_CACHE_RETENTION_SECONDS;
  const nowMs = (options.now ?? (() => Date.now()))();
  const result: CacheGcResult = { scanned: 0, removed: [] };

  for (const dirName of CACHE_DIRS) {
    const dir = path.join(stateDir, dirName);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // cache dir absent — nothing to collect
    }
    for (const entry of entries) {
      const file = path.join(dir, entry);
      // Orphaned atomic-write temps are never referenced.
      if (entry.includes(".tmp-")) {
        result.scanned += 1;
        try {
          await rm(file, { force: true });
          result.removed.push(file);
        } catch {
          /* best-effort */
        }
        continue;
      }
      if (!entry.endsWith(".json")) continue;
      result.scanned += 1;
      let expired = true;
      try {
        const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
        const ts = payloadTimestamp(parsed);
        // Unparseable or timestamp-less files cannot be referenced by
        // any reader (readCache/readHubCache/readPricingCache all
        // reject them) — safe to collect.
        expired = ts === null || nowMs - ts > retentionSeconds * 1000;
      } catch {
        expired = true;
      }
      if (!expired) continue;
      try {
        await rm(file, { force: true });
        result.removed.push(file);
      } catch {
        /* best-effort */
      }
    }
  }
  return result;
}
