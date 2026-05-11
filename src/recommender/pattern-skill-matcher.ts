/**
 * Pattern-to-skill matcher: scores candidate skills for each detected pattern.
 *
 * Strategy:
 *   1. Each pattern type maps to a primary skill name heuristic table.
 *   2. Keyword overlap between pattern metadata and skill.keywords boosts score.
 *   3. Confidence 0-100; threshold enforcement is the caller's responsibility.
 */

import type { Pattern, SkillCatalogEntry, Recommendation, MatchEvidence } from "./types.ts";

// ── Heuristic table ────────────────────────────────────────────────────────────

/** Primary expected skill names per pattern type (highest priority). */
const PATTERN_SKILL_HINTS: Record<string, string[]> = {
  "read-fanout":       ["scout", "repomix", "gkg", "graphify"],
  "test-loop":         ["test", "web-testing"],
  "manual-diff-cycle": ["code-review", "fix", "debug"],
  "grep-walk":         ["scout", "gkg", "repomix"],
  "subagent-skip":     ["cook", "plan", "sequential-thinking"],
};

/** Keywords associated with each pattern type for catalog matching. */
const PATTERN_KEYWORDS: Record<string, string[]> = {
  "read-fanout":       ["read", "explore", "discover", "codebase", "files", "search", "scout"],
  "test-loop":         ["test", "bun", "jest", "vitest", "pytest", "coverage", "tdd"],
  "manual-diff-cycle": ["diff", "review", "edit", "patch", "fix", "code-review"],
  "grep-walk":         ["grep", "search", "find", "explore", "discover", "codebase"],
  "subagent-skip":     ["plan", "subagent", "delegate", "orchestrate", "cook", "agent"],
};

/** Copy-pastable invocation hints per skill name. */
const INVOCATION_HINTS: Record<string, string> = {
  scout:               "/ck:scout",
  repomix:             "/ck:repomix",
  gkg:                 "/ck:gkg",
  graphify:            "/ck:graphify",
  test:                "/ck:test",
  "web-testing":       "/ck:web-testing",
  "code-review":       "/ck:code-review",
  fix:                 "/ck:fix",
  debug:               "/ck:debug",
  cook:                "/ck:cook",
  plan:                "/ck:plan",
  "sequential-thinking": "/ck:sequential-thinking",
};

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Compute keyword overlap score (0-50) between pattern keywords and skill keywords.
 * Normalized to 0-50 range to leave room for heuristic bonus.
 */
function keywordOverlapScore(
  patternType: string,
  skill: SkillCatalogEntry
): number {
  const patternKws = new Set(
    (PATTERN_KEYWORDS[patternType] ?? []).map((k) => k.toLowerCase())
  );
  const skillKws = [
    ...skill.keywords.map((k) => k.toLowerCase()),
    ...skill.name.toLowerCase().split(/[-_]/),
  ];

  let matches = 0;
  for (const kw of skillKws) {
    if (patternKws.has(kw)) matches++;
  }

  // Also check description words
  const descWords = skill.description.toLowerCase().split(/\W+/);
  for (const w of descWords) {
    if (w.length > 3 && patternKws.has(w)) matches++;
  }

  return Math.min(50, matches * 12);
}

/**
 * Compute heuristic bonus (0-50) based on primary skill name table.
 */
function heuristicBonus(patternType: string, skillName: string): number {
  const hints = PATTERN_SKILL_HINTS[patternType] ?? [];
  const idx = hints.indexOf(skillName);
  if (idx === -1) return 0;
  // First match = 50, second = 35, third = 20, rest = 10
  return [50, 35, 20, 10][idx] ?? 10;
}

/** Build MatchEvidence array from pattern (up to 2 entries). */
function buildEvidence(pattern: Pattern): MatchEvidence[] {
  const evidence: MatchEvidence[] = [];
  const limit = Math.min(2, pattern.turnIndices.length);

  for (let i = 0; i < limit; i++) {
    const ts = pattern.timestamps[i] ?? "";
    const idx = pattern.turnIndices[i] ?? 0;
    let summary: string;

    switch (pattern.type) {
      case "read-fanout":
        summary = `Read ×${pattern.count} in ${pattern.dir}`;
        break;
      case "test-loop":
        summary = `Bash test: ${pattern.commands[i] ?? "test runner"}`;
        break;
      case "manual-diff-cycle":
        summary = `Read→Edit→Read cycle on ${pattern.filePath}`;
        break;
      case "grep-walk":
        summary = `Grep+Read pair #${i + 1}`;
        break;
      case "subagent-skip":
        summary = `${pattern.toolCallCount} tool calls without subagent delegation`;
        break;
    }

    evidence.push({ timestamp: ts, toolCallSummary: summary, turnIndex: idx });
  }

  return evidence;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface MatchOptions {
  /** Minimum confidence threshold 0-100. Default 0 (caller filters). */
  minConfidence?: number;
  /** Max recommendations per pattern. Default 3. */
  topK?: number;
}

/**
 * Score all catalog skills against a detected pattern and return ranked candidates.
 *
 * @param pattern   Detected behavioral pattern.
 * @param catalog   All skill entries from skill_catalog.
 * @param model     Model name for cost estimates (passed to savings estimator).
 * @param opts      Filtering options.
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
 * Incorporates savings data provided by caller (savings-estimator).
 */
export function buildRecommendations(
  pattern: Pattern,
  catalog: SkillCatalogEntry[],
  savingsMap: Map<string, { tokens: number; usd: number }>,
  opts: MatchOptions = {}
): Recommendation[] {
  const matches = matchSkillsForPattern(pattern, catalog, opts);
  const catalogByName = new Map(catalog.map((e) => [e.name, e]));

  return matches.map((m) => {
    const entry = catalogByName.get(m.skillName);
    const savings = savingsMap.get(m.skillName) ?? { tokens: 0, usd: 0 };
    const hint = INVOCATION_HINTS[m.skillName] ?? `/ck:${m.skillName}`;

    return {
      skillName: m.skillName,
      description: entry?.description ?? "",
      confidence: m.confidence,
      pattern,
      evidence: m.evidence,
      estimatedTokensSaved: savings.tokens,
      estimatedUsdSaved: savings.usd,
      invocationHint: hint,
    } satisfies Recommendation;
  });
}
