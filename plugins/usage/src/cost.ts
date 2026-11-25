/**
 * Estimated API-cost computation for rebuildup.usage (Issue #93 /
 * parent #28 T4).
 *
 * Pure: same `(by_model breakdown, pricing table)` input → same
 * output; unit-testable without I/O. The estimate applies standard
 * per-token list rates to the four canonical token buckets. It is
 * **not** a bill: subscription quota consumption, speed premiums,
 * context-tier repricing, provider discounts, and taxes are all
 * excluded (documented in the contract disclaimer).
 *
 * Honesty rules:
 * - `provider_reported_cost_usd` stays a separate field — provider-
 *   reported cost is never blended into the estimate.
 * - A model with no rate-table entry gets `estimated_cost_usd: null`
 *   and `cost_source: "unpriced"` — never a guessed price.
 * - `estimated_cost_usd` totals cover priced models only;
 *   `estimate_complete: false` discloses partial coverage.
 */

import type { BreakdownEntry, CostSource, ModelCostEntry, UnpricedModel } from "./model";
import { estimateBucketCostUsd, lookupPricedRate, type PricingTable } from "./pricing";

export interface CostComputation {
  by_model: ModelCostEntry[];
  /** Sum over priced models; null when nothing could be priced. */
  estimated_cost_usd: number | null;
  estimate_complete: boolean;
  priced_models: number;
  unpriced_models: UnpricedModel[];
}

/**
 * Price every `by_model` breakdown row. Rows are re-sorted: priced
 * models by estimated cost desc, then unpriced models by token volume
 * desc — the actionable rows surface first.
 */
export function computeModelCosts(
  byModel: BreakdownEntry[],
  pricing: PricingTable,
): CostComputation {
  const entries: ModelCostEntry[] = [];
  const unpriced: UnpricedModel[] = [];
  let total = 0;
  let priced = 0;
  let anyPriced = false;

  for (const bucket of byModel) {
    const key = typeof bucket.key === "string" && bucket.key !== "" ? bucket.key : null;
    const pricedRate = key === null ? null : lookupPricedRate(pricing, key);
    const estimated = pricedRate === null ? null : estimateBucketCostUsd(pricedRate.rates, bucket);
    const costSource: CostSource = estimated === null ? "unpriced" : "model_priced";
    entries.push({
      key,
      events: bucket.events,
      input_tokens: bucket.input_tokens,
      output_tokens: bucket.output_tokens,
      cache_read_input_tokens: bucket.cache_read_input_tokens,
      cache_creation_input_tokens: bucket.cache_creation_input_tokens,
      total_tokens: bucket.total_tokens,
      thinking_tokens: bucket.thinking_tokens,
      provider_reported_cost_usd: bucket.provider_reported_cost_usd,
      estimated_cost_usd: estimated,
      cost_source: costSource,
    });
    if (estimated === null) {
      unpriced.push({ key, events: bucket.events, total_tokens: bucket.total_tokens });
    } else {
      priced += 1;
      anyPriced = true;
      total += estimated;
    }
  }

  entries.sort((a, b) => {
    const aCost = a.estimated_cost_usd;
    const bCost = b.estimated_cost_usd;
    if (aCost !== null && bCost !== null && aCost !== bCost) return bCost - aCost;
    if (aCost !== null && bCost === null) return -1;
    if (aCost === null && bCost !== null) return 1;
    return b.total_tokens - a.total_tokens || b.events - a.events;
  });
  unpriced.sort((a, b) => b.total_tokens - a.total_tokens || b.events - a.events);

  return {
    by_model: entries,
    estimated_cost_usd: anyPriced ? total : null,
    estimate_complete: unpriced.length === 0,
    priced_models: priced,
    unpriced_models: unpriced,
  };
}
