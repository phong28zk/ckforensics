/**
 * Anthropic Claude model pricing (USD per million tokens, May 2026 snapshot).
 *
 * Used by audit cost estimation + ingest cost backfill. Returns null for
 * unknown models so callers can decide to display "unknown" vs assume 0.
 *
 * Source: https://www.anthropic.com/pricing (cached values; refresh as needed).
 */

export interface ModelPricing {
  /** Input tokens per million USD. */
  inputPer1M: number;
  /** Output tokens per million USD. */
  outputPer1M: number;
  /** Cache-read tokens per million USD (typically 0.1x input). */
  cacheReadPer1M: number;
  /** Cache-write tokens per million USD (typically 1.25x input). */
  cacheWritePer1M: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Look up pricing for a model string (case-insensitive substring match on family).
 * Returns null if family unknown.
 */
export function getModelPricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("opus")) {
    return { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 };
  }
  if (m.includes("sonnet")) {
    return { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 };
  }
  if (m.includes("haiku")) {
    return { inputPer1M: 0.25, outputPer1M: 1.25, cacheReadPer1M: 0.03, cacheWritePer1M: 0.3 };
  }
  return null;
}

/**
 * Compute estimated cost in USD given token counts and model.
 * Returns null for unknown models (caller renders as "unknown").
 */
export function computeCostUsd(tokens: TokenCounts, model: string | null | undefined): number | null {
  const p = getModelPricing(model);
  if (!p) return null;
  const M = 1_000_000;
  return (
    (tokens.input * p.inputPer1M) / M +
    (tokens.output * p.outputPer1M) / M +
    (tokens.cacheRead * p.cacheReadPer1M) / M +
    (tokens.cacheCreate * p.cacheWritePer1M) / M
  );
}
