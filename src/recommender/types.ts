/**
 * Discriminated union types for the ckforensics skill recommender.
 *
 * Pattern: detected behavioral fingerprint in a session.
 * Recommendation: ranked skill suggestion with evidence.
 * SkillCatalogEntry: persisted row from skill_catalog table.
 * MatchEvidence: turn-level quote supporting a recommendation.
 */

// ── Pattern types ─────────────────────────────────────────────────────────────

export type PatternType =
  | "read-fanout"
  | "test-loop"
  | "manual-diff-cycle"
  | "grep-walk"
  | "subagent-skip";

export interface ReadFanoutPattern {
  type: "read-fanout";
  /** Parent directory where reads were concentrated. */
  dir: string;
  /** Number of Read calls detected. */
  count: number;
  /** Turn indices (0-based) where the pattern occurred. */
  turnIndices: number[];
  /** ISO timestamps of the turns. */
  timestamps: string[];
  /** Approximate input tokens consumed. */
  tokensConsumed: number;
}

export interface TestLoopPattern {
  type: "test-loop";
  /** Number of test runner invocations. */
  count: number;
  turnIndices: number[];
  timestamps: string[];
  /** Sample commands detected. */
  commands: string[];
  tokensConsumed: number;
}

export interface ManualDiffCyclePattern {
  type: "manual-diff-cycle";
  /** File path being repeatedly read+edited. */
  filePath: string;
  /** Number of read→edit→read cycles. */
  cycles: number;
  turnIndices: number[];
  timestamps: string[];
  tokensConsumed: number;
}

export interface GrepWalkPattern {
  type: "grep-walk";
  /** Number of Grep+Read pairs. */
  pairCount: number;
  turnIndices: number[];
  timestamps: string[];
  tokensConsumed: number;
}

export interface SubagentSkipPattern {
  type: "subagent-skip";
  /** Total tool_use calls in the span. */
  toolCallCount: number;
  turnIndices: number[];
  timestamps: string[];
  tokensConsumed: number;
}

export type Pattern =
  | ReadFanoutPattern
  | TestLoopPattern
  | ManualDiffCyclePattern
  | GrepWalkPattern
  | SubagentSkipPattern;

// ── Match evidence ─────────────────────────────────────────────────────────────

/** One turn-level evidence citation supporting a recommendation. */
export interface MatchEvidence {
  /** ISO-8601 timestamp of the turn. */
  timestamp: string;
  /** Human-readable summary of the tool call(s) at that turn. */
  toolCallSummary: string;
  /** Turn index within the session (0-based). */
  turnIndex: number;
}

// ── Skill catalog entry ────────────────────────────────────────────────────────

export interface SkillCatalogEntry {
  name: string;
  description: string;
  keywords: string[];
  path: string;
  mtime: number;
}

// ── Recommendation ─────────────────────────────────────────────────────────────

export interface Recommendation {
  /** Skill name, e.g. "scout". */
  skillName: string;
  /** One-line skill description. */
  description: string;
  /** Confidence 0-100. */
  confidence: number;
  /** Pattern that triggered this recommendation. */
  pattern: Pattern;
  /** 1-2 turn evidence quotes. */
  evidence: MatchEvidence[];
  /** Estimated token savings if skill had been used. */
  estimatedTokensSaved: number;
  /** Estimated USD savings. */
  estimatedUsdSaved: number;
  /** Copy-pastable invocation hint. */
  invocationHint: string;
}

// ── Skill usage record ─────────────────────────────────────────────────────────

export interface SkillUsageRecord {
  id: number;
  sessionId: string;
  skillName: string;
  activatedAt: string | null;
}

// ── Effectiveness data ─────────────────────────────────────────────────────────

export interface SkillEffectivenessReport {
  skillName: string;
  /** Sessions where this skill was used. */
  usedSessions: number;
  /** Sessions with similar pattern but no skill usage. */
  unusedSessions: number;
  /** Average tool-call count with skill. */
  avgToolCallsWithSkill: number;
  /** Average tool-call count without skill. */
  avgToolCallsWithout: number;
  /** Relative effectiveness score 0-100. */
  effectivenessScore: number;
}
