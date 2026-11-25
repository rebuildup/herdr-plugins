/**
 * Estimated API-cost pricing for rebuildup.usage (Issue #93 /
 * parent #28 T4).
 *
 * The rate table mirrors T3 Code's `apps/server/src/usage/
 * usagePricing.ts` approach: a LiteLLM `model_prices_and_context_window`
 * snapshot fetched at runtime, cached under the plugin state dir, and
 * applied to aggregated token buckets. Two honesty rules from #93:
 *
 * - The result is an **estimate** (list-price math over standard
 *   rates), never a bill. Speed premiums, context-tier repricing,
 *   provider discounts, taxes, and subscription quota consumption are
 *   all out of scope — the contract labels this explicitly.
 * - An unknown model yields `null`, never a guessed price. Models the
 *   table cannot price are listed as unpriced so partial totals are
 *   never mistaken for complete ones.
 *
 * Credential boundary: the pricing fetch is unauthenticated public
 * data; no credential material is involved (ADR-0014/0015 unaffected).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import type { BreakdownEntry, ModelPriceOverride, PricingInfo, PricingStatus } from "./model";
import { asRecord, type FetchImpl, fetchJson } from "./quota";
import { gcPluginStateCache } from "./state";

/** LiteLLM community price list — the same upstream T3 Code prices from. */
export const PRICING_SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Fresh-cache TTL for the pricing table (seconds). */
export const PRICING_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Hard retention for cached pricing data; older entries are GC'd. */
export const PRICING_CACHE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const DEFAULT_TIMEOUT_MS = 10_000;

/** USD-per-token rates for the four canonical token buckets. */
export interface TokenRates {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, TokenRates>;

// --- parsing ------------------------------------------------------------------

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Parse a LiteLLM `model_prices_and_context_window` document into a
 * rate table. Entries missing input or output pricing are dropped —
 * a partial rate would understate cost, which is worse than
 * reporting the model unpriced. Speed variants (`_priority`,
 * `_ultrafast`) and context tiers are ignored: aggregated totals
 * carry no per-request speed/prompt-size signal, so only standard
 * rates can be applied honestly. 1-hour cache writes are priced at
 * the standard cache-creation rate (the 5-minute rate) because the
 * index does not record the TTL split.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, TokenRates>();
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return table;
  }
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    const key = normalizeRateKey(name);
    if (key === "") continue;
    table.set(key, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    });
  }
  return table;
}

/**
 * Build a rate table from user-supplied `modelPrices` overrides.
 * Keys are normalized the same way as LiteLLM keys; malformed entries
 * are dropped, never guessed.
 */
export function createOverrideRateTable(
  overrides: Readonly<Record<string, ModelPriceOverride>> | undefined,
): RateTable {
  const table = new Map<string, TokenRates>();
  if (typeof overrides !== "object" || overrides === null) return table;
  for (const [model, prices] of Object.entries(overrides)) {
    if (typeof prices !== "object" || prices === null) continue;
    const input = finiteNumber(
      typeof prices.inputCostPerMillionTokens === "number"
        ? prices.inputCostPerMillionTokens / 1_000_000
        : null,
    );
    const output = finiteNumber(
      typeof prices.outputCostPerMillionTokens === "number"
        ? prices.outputCostPerMillionTokens / 1_000_000
        : null,
    );
    if (input === null || output === null) continue;
    const key = normalizeRateKey(model);
    if (key === "") continue;
    const cacheRead =
      typeof prices.cacheReadCostPerMillionTokens === "number" &&
      Number.isFinite(prices.cacheReadCostPerMillionTokens) &&
      prices.cacheReadCostPerMillionTokens >= 0
        ? prices.cacheReadCostPerMillionTokens / 1_000_000
        : input;
    const cacheWrite =
      typeof prices.cacheWriteCostPerMillionTokens === "number" &&
      Number.isFinite(prices.cacheWriteCostPerMillionTokens) &&
      prices.cacheWriteCostPerMillionTokens >= 0
        ? prices.cacheWriteCostPerMillionTokens / 1_000_000
        : input;
    table.set(key, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: cacheRead,
      cacheCreationCostPerToken: cacheWrite,
    });
  }
  return table;
}

// --- model lookup ---------------------------------------------------------------

/** Strip a trailing `[...]` variant suffix (e.g. `[1m]` context tags). */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

/** Strip a trailing provider date stamp: `-20251101` or `-2025-11-01`. */
function stripDateSuffix(key: string): string {
  return key.replace(/-20\d{2}(?:-\d{2}-\d{2}|\d{4})$/, "");
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Resolve a transcript `model` string to a rate-table entry.
 * Candidate order: exact normalized key → bare name (provider prefix
 * dropped) → date-suffix-stripped variants of both. First hit wins;
 * no fuzzy/substring matching — a wrong price is worse than none.
 * Returns null for empty/unpriceable names; callers report the model
 * unpriced rather than guessing.
 */
export function lookupRate(table: RateTable, model: string): TokenRates | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bare = bareModelName(key);
  if (bare === "") return null;
  const candidates = [key, bare, stripDateSuffix(key), stripDateSuffix(bare)];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const rate = table.get(candidate);
    if (rate !== undefined) return rate;
  }
  return null;
}

// --- cost estimation -------------------------------------------------------------

/**
 * Estimated USD cost of one aggregated bucket under `rates`.
 * `thinking_tokens` is intentionally absent: providers report it
 * inside `output_tokens`, so charging it again would double-count.
 */
export function estimateBucketCostUsd(
  rates: TokenRates,
  bucket: Pick<
    BreakdownEntry,
    "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
  >,
): number {
  return (
    bucket.input_tokens * rates.inputCostPerToken +
    bucket.output_tokens * rates.outputCostPerToken +
    bucket.cache_read_input_tokens * rates.cacheReadCostPerToken +
    bucket.cache_creation_input_tokens * rates.cacheCreationCostPerToken
  );
}

// --- table loading (fetch + cache + GC) --------------------------------------------

export interface PricingTable {
  info: PricingInfo;
  /** LiteLLM-derived rates (empty when unavailable). */
  rates: RateTable;
  /** User override rates — consulted before `rates`. */
  overrides: RateTable;
}

interface PricingCachePayload {
  fetched_at: string;
  source: string;
  /** Compact rows: [input, output, cacheRead, cacheCreation] per token. */
  rates: Record<string, [number, number, number, number]>;
}

function pricingCacheFile(stateDir: string): string {
  return path.join(stateDir, "pricing-cache", "litellm.json");
}

function ratesToPayload(rates: RateTable, fetchedAt: string, source: string): string {
  const rows: PricingCachePayload["rates"] = {};
  for (const [model, r] of rates) {
    rows[model] = [
      r.inputCostPerToken,
      r.outputCostPerToken,
      r.cacheReadCostPerToken,
      r.cacheCreationCostPerToken,
    ];
  }
  return `${JSON.stringify({ fetched_at: fetchedAt, source, rates: rows } satisfies PricingCachePayload)}\n`;
}

function payloadToRates(payload: PricingCachePayload): RateTable {
  const table = new Map<string, TokenRates>();
  for (const [model, row] of Object.entries(payload.rates)) {
    if (!Array.isArray(row) || row.length !== 4) continue;
    const [i, o, cr, cc] = row as [number, number, number, number];
    if (![i, o, cr, cc].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      continue;
    }
    table.set(model, {
      inputCostPerToken: i,
      outputCostPerToken: o,
      cacheReadCostPerToken: cr,
      cacheCreationCostPerToken: cc,
    });
  }
  return table;
}

async function readPricingCache(
  stateDir: string,
): Promise<{ rates: RateTable; fetchedAt: string; ageSeconds: number } | null> {
  try {
    const raw = await readFile(pricingCacheFile(stateDir), "utf8");
    const parsed = asRecord(JSON.parse(raw));
    if (parsed === null) return null;
    const fetchedAt = typeof parsed.fetched_at === "string" ? parsed.fetched_at : null;
    const rows = asRecord(parsed.rates);
    if (fetchedAt === null || rows === null) return null;
    const ageMs = Date.now() - Date.parse(fetchedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0) return null;
    const rates = payloadToRates({
      fetched_at: fetchedAt,
      source: typeof parsed.source === "string" ? parsed.source : "",
      rates: rows as PricingCachePayload["rates"],
    });
    if (rates.size === 0) return null;
    return { rates, fetchedAt, ageSeconds: Math.floor(ageMs / 1000) };
  } catch {
    return null;
  }
}

async function writePricingCache(
  stateDir: string,
  rates: RateTable,
  fetchedAt: string,
  source: string,
): Promise<void> {
  try {
    const dir = path.join(stateDir, "pricing-cache");
    await mkdir(dir, { recursive: true });
    const file = pricingCacheFile(stateDir);
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, ratesToPayload(rates, fetchedAt, source), "utf8");
    await rename(tmp, file);
  } catch {
    /* cache is best-effort; a write failure must not fail the report */
  }
}

export interface PricingOptions {
  /** Bypass the fresh-cache read (still writes on success). */
  refresh?: boolean | undefined;
  timeoutMs?: number | undefined;
  /** Plugin state dir override (tests); default HERDR_PLUGIN_STATE_DIR layout. */
  stateDir?: string | undefined;
  /** Source URL override (test/proxy hook); env HERDR_USAGE_PRICING_URL also applies upstream. */
  sourceUrl?: string | undefined;
  /** Cache TTL override in seconds (config `pricingCacheTtlSeconds`). */
  ttlSeconds?: number | undefined;
  /** User price overrides from config.json `modelPrices`. */
  modelPrices?: Readonly<Record<string, ModelPriceOverride>> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: FetchImpl | undefined;
  now?: (() => number) | undefined;
}

function emptyTable(
  source: string,
  status: PricingStatus,
  detail: string | null,
  ttl: number,
  overrides: RateTable,
): PricingTable {
  return {
    info: {
      status,
      source,
      fetched_at: null,
      cache: { hit: false, age_seconds: null, ttl_seconds: ttl },
      known_models: 0,
      user_overrides: overrides.size,
      detail,
    },
    rates: new Map(),
    overrides,
  };
}

/**
 * Load the model rate table: fresh cache → fetch → stale cache →
 * unavailable. Never throws for fetch/parse failures — every outcome
 * is a structured `PricingInfo.status`. Stale cache is served only
 * within the shared retention window; `gcPluginStateCache` removes
 * older entries.
 */
export async function collectPricing(options: PricingOptions = {}): Promise<PricingTable> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttl = options.ttlSeconds ?? PRICING_CACHE_TTL_SECONDS;
  const stateDir = options.stateDir ?? pluginStateDir();
  const source = options.sourceUrl ?? env.HERDR_USAGE_PRICING_URL ?? PRICING_SOURCE_URL;
  const overrides = createOverrideRateTable(options.modelPrices);

  // Best-effort retention GC before reading — never fails the report.
  await gcPluginStateCache(stateDir);

  const now = options.now ?? (() => Date.now());
  const cached = await readPricingCache(stateDir);
  const fresh = cached !== null && cached.ageSeconds < ttl;
  const withinRetention = cached !== null && cached.ageSeconds < PRICING_CACHE_RETENTION_SECONDS;

  if (options.refresh !== true && fresh && cached !== null) {
    return {
      info: {
        status: "ok",
        source,
        fetched_at: cached.fetchedAt,
        cache: { hit: true, age_seconds: cached.ageSeconds, ttl_seconds: ttl },
        known_models: cached.rates.size,
        user_overrides: overrides.size,
        detail: null,
      },
      rates: cached.rates,
      overrides,
    };
  }

  const res = await fetchJson(source, { accept: "application/json" }, timeoutMs, fetchImpl);
  if (res.ok) {
    const rates = parseRateTable(res.json);
    if (rates.size > 0) {
      const fetchedAt = new Date(now()).toISOString();
      await writePricingCache(stateDir, rates, fetchedAt, source);
      return {
        info: {
          status: "ok",
          source,
          fetched_at: fetchedAt,
          cache: { hit: false, age_seconds: null, ttl_seconds: ttl },
          known_models: rates.size,
          user_overrides: overrides.size,
          detail: null,
        },
        rates,
        overrides,
      };
    }
  }

  // Fetch failed or empty: serve the last good table, explicitly
  // stale, within retention — never fabricate an empty-price zero.
  const detail = res.ok
    ? "pricing source returned no usable rate entries"
    : (res.detail ?? "request failed");
  if (withinRetention && cached !== null) {
    return {
      info: {
        status: "stale",
        source,
        fetched_at: cached.fetchedAt,
        cache: { hit: true, age_seconds: cached.ageSeconds, ttl_seconds: ttl },
        known_models: cached.rates.size,
        user_overrides: overrides.size,
        detail: `pricing refresh failed (${detail}); serving cached table`,
      },
      rates: cached.rates,
      overrides,
    };
  }
  return emptyTable(source, "unavailable", detail, ttl, overrides);
}

/** Lookup that consults user overrides before the fetched table. */
export function lookupPricedRate(
  table: PricingTable,
  model: string,
): { rates: TokenRates; via: "override" | "table" } | null {
  const override = lookupRate(table.overrides, model);
  if (override !== null) return { rates: override, via: "override" };
  const rate = lookupRate(table.rates, model);
  if (rate !== null) return { rates: rate, via: "table" };
  return null;
}

const PLUGIN_ID = "rebuildup.usage";
function pluginStateDir(): string {
  return pluginDirs(PLUGIN_ID).stateDir;
}
