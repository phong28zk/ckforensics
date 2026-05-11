/**
 * Core discriminated-union types for the Context Map feature.
 *
 * A ContextItem represents one logical entry in Claude Code's context window.
 * Token counts are heuristic (±20% attribution margin — see token-attribution.ts).
 *
 * Attribution confidence levels:
 *   high   — derived directly from cache_creation_input_tokens delta
 *   medium — proportional distribution across multiple items in same turn
 *   low    — character-count fallback (no cache token data available)
 */

// ── Item source discriminated union ───────────────────────────────────────────

/** Source of a context item — exhaustive discriminated union. */
export type ItemSource =
  | { type: "tool_result"; toolName: string; toolCallId: string; preview: string }
  | { type: "assistant_message"; messageId: string; preview: string }
  | { type: "user_message"; messageId: string; preview: string }
  | { type: "system_prompt" }
  | { type: "memory"; entry: string }
  | { type: "skill_load"; skillName: string }
  | { type: "unknown"; raw: string };

/** Confidence level for token attribution heuristic. */
export type AttributionConfidence = "high" | "medium" | "low";

// ── Core item ─────────────────────────────────────────────────────────────────

/** One logical item occupying space in the context window. */
export interface ContextItem {
  /** Deterministic hash of source content (used as stable ID). */
  id: string;
  /** Discriminated source descriptor. */
  source: ItemSource;
  /** Estimated token count (heuristic — see attribution margin notes). */
  tokens: number;
  /** 0-based index of the conversation turn this item was added. */
  turnIndex: number;
  /** ISO-8601 timestamp of the event that introduced this item. */
  timestamp: string;
  /** Token attribution confidence level. */
  attributionConfidence: AttributionConfidence;
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/** A persisted snapshot of context items at a point in time. */
export interface ContextSnapshot {
  /** Unique identifier (UUID or deterministic hash). */
  id: string;
  /** Session this snapshot was captured from. */
  sessionId: string;
  /** User-given name (optional). */
  name?: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** Sum of all item tokens (may differ from actual window size ±20%). */
  totalTokens: number;
  /** Ordered context items (typically token DESC). */
  items: ContextItem[];
  /** IDs of items marked as must-keep by the user. */
  pinnedIds: string[];
}

/** Lightweight metadata returned by listSnapshots(). */
export interface SnapshotMetadata {
  id: string;
  sessionId: string;
  name?: string;
  createdAt: string;
  totalTokens: number;
  itemCount: number;
}

// ── Diff ──────────────────────────────────────────────────────────────────────

/** Category-level token delta between two snapshots. */
export interface CategoryDelta {
  category: string;
  tokensBefore: number;
  tokensAfter: number;
  delta: number;
}

/** Result of comparing two context snapshots. */
export interface SnapshotDiff {
  snapshotIdA: string;
  snapshotIdB: string;
  addedItems: ContextItem[];
  droppedItems: ContextItem[];
  netTokenDelta: number;
  categoryDeltas: CategoryDelta[];
  /** Warning emitted when snapshots come from different sessions. */
  crossSessionWarning?: string;
}

// ── Compaction simulation ─────────────────────────────────────────────────────

/** Result of simulating Claude Code's context compaction algorithm. */
export interface CompactionResult {
  /** Items projected to remain after compaction. */
  kept: ContextItem[];
  /** Items projected to be dropped during compaction. */
  dropped: ContextItem[];
  /** Token total of kept items. */
  keptTokens: number;
  /** Token total of dropped items. */
  droppedTokens: number;
  /** Target occupancy percentage used (default 50). */
  targetPct: number;
  /** Assumed total context window size in tokens. */
  contextWindowTokens: number;
  /**
   * Simulator version tag — include in output so users can track
   * divergence as CC's algorithm evolves.
   */
  simulatorVersion: string;
}

// ── Heatmap row ───────────────────────────────────────────────────────────────

/** Aggregated row for heatmap / table display. */
export interface HeatmapRow {
  category: string;
  itemCount: number;
  tokens: number;
  pct: number;
  bar: string;
}
