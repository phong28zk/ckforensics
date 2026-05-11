/**
 * Pattern-to-skill matcher: scores candidate skills for each detected pattern.
 *
 * Strategy:
 *   1. Each pattern type maps to a primary skill name heuristic table (scorer).
 *   2. Keyword overlap between pattern metadata and skill.keywords boosts score.
 *   3. Process/prompt advice from advice bank is always appended (no catalog needed).
 *   4. Confidence 0-100; threshold enforcement is the caller's responsibility.
 *
 * Scoring helpers live in pattern-skill-scorer.ts.
 * Advice bank data lives in process-advice-bank.ts.
 */

import type {
  Pattern,
  SkillCatalogEntry,
  Recommendation,
  SkillRecommendation,
  ProcessRecommendation,
  PromptRecommendation,
  MatchEvidence,
} from "./types.ts";
import {
  INVOCATION_HINTS,
  keywordOverlapScore,
  heuristicBonus,
  buildEvidence,
} from "./pattern-skill-scorer.ts";
import { ADVICE_BANK } from "./process-advice-bank.ts";

// ── Public API ────────────────────────────────────────────────────────────────

export interface MatchOptions {
  /** Minimum confidence threshold 0-100. Default 0 (caller filters). */
  minConfidence?: number;
  /** Max skill recommendations per pattern. Default 3. */
  topK?: number;
}

/**
 * Score all catalog skills against a detected pattern and return ranked candidates.
 *
 * @param pattern  Detected behavioral pattern.
 * @param catalog  All skill entries from skill_catalog.
 * @param opts     Filtering options.
 */
export function matchSkillsForPattern(
  pattern: Pattern,
  catalog: SkillCatalogEntry[],
  opts: MatchOptions = {}
): Array<{ skillName: string; confidence: number; evidence: MatchEvidence[] }> {
  const { minConfidence = 0, topK = 3 } = opts;

  const scored = catalog.map((skill) => {
    const overlap = keywordOverlapScore(pattern.type, skill);
    const bonus = heuristicBonus(pattern.type, skill.name);
    const confidence = Math.min(100, overlap + bonus);
    return { skill, confidence };
  });

  return scored
    .filter((s) => s.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, topK)
    .map((s) => ({
      skillName: s.skill.name,
      confidence: s.confidence,
      evidence: buildEvidence(pattern),
    }));
}

/**
 * Build full Recommendation objects from a pattern + catalog.
 *
 * Returns a mixed list: SkillRecommendation (catalog hits) + ProcessRecommendation
 * + PromptRecommendation (advice bank — always populated, no catalog required).
 *
 * Non-ClaudeKit users with an empty catalog still receive process/prompt advice.
 */
export function buildRecommendations(
  pattern: Pattern,
  catalog: SkillCatalogEntry[],
  savingsMap: Map<string, { tokens: number; usd: number }>,
  opts: MatchOptions = {}
): Recommendation[] {
  const { minConfidence = 0 } = opts;
  const matches = matchSkillsForPattern(pattern, catalog, opts);
  const catalogByName = new Map(catalog.map((e) => [e.name, e]));

  // ── Skill recommendations ──────────────────────────────────────────────────
  const skillRecs: SkillRecommendation[] = matches.map((m) => {
    const entry = catalogByName.get(m.skillName);
    const savings = savingsMap.get(m.skillName) ?? { tokens: 0, usd: 0 };
    // Strip any "ck:" prefix to avoid double prefix "/ck:ck:foo".
    const bareName = m.skillName.replace(/^ckm?:/, "");
    const hint =
      INVOCATION_HINTS[m.skillName] ??
      INVOCATION_HINTS[bareName] ??
      `/ck:${bareName}`;

    return {
      type: "skill",
      skillName: m.skillName,
      description: entry?.description ?? "",
      confidence: m.confidence,
      pattern,
      evidence: m.evidence,
      estimatedTokensSaved: savings.tokens,
      estimatedUsdSaved: savings.usd,
      invocationHint: hint,
    } satisfies SkillRecommendation;
  });

  // ── Process + prompt advice from bank ─────────────────────────────────────
  const bankEntries = ADVICE_BANK[pattern.type] ?? [];
  const evidence = buildEvidence(pattern);

  // Scale baseline confidence by pattern "strength" (token cost as proxy).
  // Patterns with >10k tokens consumed get a small boost (up to +8).
  const strengthBoost =
    pattern.tokensConsumed > 10_000 ? 8
    : pattern.tokensConsumed > 5_000 ? 4
    : 0;

  const adviceRecs: Array<ProcessRecommendation | PromptRecommendation> = bankEntries
    .map((entry) => {
      const confidence = Math.min(100, entry.baseConfidence + strengthBoost);
      if (confidence < minConfidence) return null;

      if (entry.adviceType === "process") {
        return {
          type: "process",
          pattern,
          title: entry.title,
          description: entry.description,
          confidence,
          evidence,
        } satisfies ProcessRecommendation;
      }
      return {
        type: "prompt",
        pattern,
        title: entry.title,
        description: entry.description,
        confidence,
        evidence,
      } satisfies PromptRecommendation;
    })
    .filter((r): r is ProcessRecommendation | PromptRecommendation => r !== null);

  return [...skillRecs, ...adviceRecs];
}
