/**
 * Savings estimator: estimates token and USD savings if a skill had been used.
 *
 * Heuristic:
 *   saved_tokens = pattern.tokensConsumed − skill_invocation_prior[skill_name]
 *   saved_usd    = computeCostUsd(saved_tokens, model)
 *
 * skill_invocation_prior: estimated token cost of one skill invocation.
 * Default prior = 5_000 tokens (conservative single-turn skill call).
 * Values are per-skill overrides where known from ClaudeKit docs.
 *
 * Returns 0 savings (never negative) — skill may cost more than manual.
 */

import { computeCostUsd } from "../lib/model-pricing.ts";

// ── Skill invocation priors ───────────────────────────────────────────────────

/**
 * Estimated token cost of invoking each skill once (input + output combined).
 * Default 5_000 applies to unknown skills.
 */
const SKILL_PRIORS: Record<string, number> = {
  scout:               8_000,   // reads multiple files + summary
  repomix:             3_000,   // generates context dump
  gkg:                 4_000,   // semantic search
  graphify:            6_000,   // graph build
  test:                6_000,   // runs test suite, parses output
  "web-testing":       7_000,   // playwright + reporting
  "code-review":       5_000,   // review pass
  fix:                 8_000,   // scout + patch
  debug:               6_000,   // trace + report
  cook:               10_000,   // full implementation loop (higher but replaces much more)
  plan:                4_000,   // planning output
  "sequential-thinking": 3_000, // structured reasoning
};

const DEFAULT_PRIOR = 5_000;

// ── Token split assumption ────────────────────────────────────────────────────

/**
 * When only a combined token count is available, assume 70% input / 30% output.
 * This affects the cost calculation since input/output have different rates.
 */
const INPUT_RATIO = 0.7;

// ── Public API ────────────────────────────────────────────────────────────────

export interface SavingsEstimate {
  skillName: string;
  /** Estimated tokens saved (clamped ≥ 0). */
  tokensSaved: number;
  /** Estimated USD saved (clamped ≥ 0). */
  usdSaved: number;
  /** Tokens actually consumed by the detected pattern. */
  patternTokens: number;
  /** Prior assumed for skill invocation cost. */
  skillPriorTokens: number;
}

/**
 * Estimate savings for a specific skill given the pattern's token consumption.
 *
 * @param skillName      Name of the candidate skill.
 * @param patternTokens  Tokens consumed by the detected pattern.
 * @param model          Model name for USD pricing (null → usdSaved = 0).
 */
export function estimateSavings(
  skillName: string,
  patternTokens: number,
  model: string | null | undefined
): SavingsEstimate {
  const prior = SKILL_PRIORS[skillName] ?? DEFAULT_PRIOR;
  const rawSaved = patternTokens - prior;
  const tokensSaved = Math.max(0, rawSaved);

  let usdSaved = 0;
  if (tokensSaved > 0 && model) {
    const inputTokens = Math.round(tokensSaved * INPUT_RATIO);
    const outputTokens = tokensSaved - inputTokens;
    const cost = computeCostUsd(
      { input: inputTokens, output: outputTokens, cacheRead: 0, cacheCreate: 0 },
      model
    );
    usdSaved = Math.max(0, cost ?? 0);
  }

  return {
    skillName,
    tokensSaved,
    usdSaved,
    patternTokens,
    skillPriorTokens: prior,
  };
}

/**
 * Build a savings map for a set of skill names against one pattern's token cost.
 * Returns Map<skillName, { tokens, usd }> for use in buildRecommendations.
 */
export function buildSavingsMap(
  skillNames: string[],
  patternTokens: number,
  model: string | null | undefined
): Map<string, { tokens: number; usd: number }> {
  const map = new Map<string, { tokens: number; usd: number }>();
  for (const name of skillNames) {
    const est = estimateSavings(name, patternTokens, model);
    map.set(name, { tokens: est.tokensSaved, usd: est.usdSaved });
  }
  return map;
}
