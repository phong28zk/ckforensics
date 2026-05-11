/**
 * Scoring helpers for pattern-to-skill matching.
 * Extracted from pattern-skill-matcher.ts to keep that file under 200 lines.
 *
 * Exports:
 *   INVOCATION_HINTS — copy-pastable /ck: invocations per skill name
 *   keywordOverlapScore — 0-50 score from keyword set overlap
 *   heuristicBonus — 0-50 bonus from primary skill name table
 *   buildEvidence — builds MatchEvidence[] from a Pattern
 */

import type { Pattern, MatchEvidence } from "./types.ts";
import type { SkillCatalogEntry } from "./types.ts";

// ── Heuristic tables ──────────────────────────────────────────────────────────

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
export const INVOCATION_HINTS: Record<string, string> = {
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

// ── Scoring functions ─────────────────────────────────────────────────────────

/**
 * Compute keyword overlap score (0-50) between pattern keywords and skill keywords.
 * Normalized to 0-50 range to leave room for heuristic bonus.
 */
export function keywordOverlapScore(
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
export function heuristicBonus(patternType: string, skillName: string): number {
  const hints = PATTERN_SKILL_HINTS[patternType] ?? [];
  const idx = hints.indexOf(skillName);
  if (idx === -1) return 0;
  // First match = 50, second = 35, third = 20, rest = 10
  return [50, 35, 20, 10][idx] ?? 10;
}

/** Build MatchEvidence array from a pattern (up to 2 entries). */
export function buildEvidence(pattern: Pattern): MatchEvidence[] {
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
