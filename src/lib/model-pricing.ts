/**
 * Anthropic Claude model pricing (USD per million tokens, Nov 2025 snapshot).
 *
 * Used by audit cost estimation + ingest cost backfill. Returns null for
 * unknown models so callers can decide to display "unknown" vs assume 0.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Pricing is family + version aware. Important breakpoints:
 *  - Opus 4.5+ (4.5, 4.6, 4.7): 1/3 of prior Opus 4.0/4.1 pricing
 *  - Haiku 4.5: $1/$5 vs Haiku 3 $0.25/$1.25 (4x difference)
 *
 * Cache write multiplier assumes 5-minute TTL (default for `cache_control`).
 * 1-hour TTL writes cost 2x base input; this module returns 5m rate.
 */

export interface ModelPricing {
  /** Input tokens per million USD. */
  inputPer1M: number;
  /** Output tokens per million USD. */
  outputPer1M: number;
  /** Cache-read (hit) tokens per million USD (0.1x base input). */
  cacheReadPer1M: number;
  /** Cache-write 5-minute TTL tokens per million USD (1.25x base input). */
  cacheWritePer1M: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Look up pricing for a model string (case-insensitive).
 * Matches family + version. Returns null for unknown models.
 *
 * Match precedence: most specific to least specific.
 */
export function getModelPricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;
  const m = model.toLowerCase();

  // Opus family — 4.5+ uses new (cheaper) pricing
  if (m.includes("opus")) {
    if (/opus-?(4-?[5-9]|5)/.test(m)) {
      // Opus 4.5, 4.6, 4.7, future 4.8+, 5.x
      return { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 };
    }
    // Opus 4.0, 4.1, 3 (legacy)
    return { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 };
  }

  // Sonnet family — all 4.x share pricing
  if (m.includes("sonnet")) {
    return { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 };
  }

  // Haiku family — version-dependent
  if (m.includes("haiku")) {
    if (/haiku-?4/.test(m)) {
      // Haiku 4.5
      return { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 };
    }
    if (/haiku-?3-?5/.test(m)) {
      // Haiku 3.5
      return { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1 };
    }
    // Haiku 3 (legacy)
    return { inputPer1M: 0.25, outputPer1M: 1.25, cacheReadPer1M: 0.03, cacheWritePer1M: 0.3 };
  }

  return null;
}

/**
 * Compute estimated cost in USD given token counts and model.
 * Returns null for unknown models (caller renders as "unknown").
 *
 * Note: this is an upper-bound estimate. Claude Code's internally reported
 * `cost.total_cost_usd` may differ slightly due to:
 *  - CC excluding cache_creation_input_tokens from accounting in some modes
 *  - 1-hour cache writes priced higher than 5m (we assume 5m)
 *  - Subscription users (Pro/Max) see flat plan fee; this is API-equivalent value
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
