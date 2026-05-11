/**
 * Session-level signal aggregation for the suggest pipeline.
 *
 * Queries the DB to compute aggregate metrics for a single session:
 *   - durationMs: wall-clock duration from sessions table
 *   - totalCacheReadTokens: SUM(cache_read) from token_usage
 *   - maxBashCallsPerTurn: peak Bash count across any single assistant event
 *   - totalToolCalls: COUNT(*) from tool_calls
 *
 * These signals feed SESSION_PROMPT_ADVICE to emit session-level PromptRecommendations.
 */

import type { Database } from "bun:sqlite";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionSignals {
  sessionId: string;
  /** Wall-clock ms; null if started_at or ended_at missing. */
  durationMs: number | null;
  /** SUM(token_usage.cache_read) for this session. */
  totalCacheReadTokens: number;
  /** Peak Bash tool_call count in any single assistant event. */
  maxBashCallsPerTurn: number;
  /** Total tool calls in the session. */
  totalToolCalls: number;
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface SessionRow {
  started_at: string | null;
  ended_at: string | null;
}

interface CacheReadRow {
  total: number;
}

interface BashCountRow {
  event_id: string;
  bash_count: number;
}

interface ToolCountRow {
  total: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute session-level signals from the DB for the given sessionId.
 * Returns zeros/null on missing data rather than throwing.
 */
export function computeSessionSignals(db: Database, sessionId: string): SessionSignals {
  // Duration from sessions table
  const sessionRow = db
    .query<SessionRow, [string]>(
      "SELECT started_at, ended_at FROM sessions WHERE id = ?"
    )
    .get(sessionId);

  let durationMs: number | null = null;
  if (sessionRow?.started_at && sessionRow?.ended_at) {
    const start = Date.parse(sessionRow.started_at);
    const end = Date.parse(sessionRow.ended_at);
    if (!isNaN(start) && !isNaN(end) && end >= start) {
      durationMs = end - start;
    }
  }

  // Total cache read tokens
  const cacheRow = db
    .query<CacheReadRow, [string]>(
      "SELECT COALESCE(SUM(cache_read), 0) AS total FROM token_usage WHERE session_id = ?"
    )
    .get(sessionId);
  const totalCacheReadTokens = cacheRow?.total ?? 0;

  // Max Bash calls per event (proxy for "per turn")
  const bashRows = db
    .query<BashCountRow, [string, string]>(
      `SELECT event_id, COUNT(*) AS bash_count
       FROM tool_calls
       WHERE session_id = ? AND tool_name = ?
       GROUP BY event_id`
    )
    .all(sessionId, "Bash");

  const maxBashCallsPerTurn =
    bashRows.length === 0 ? 0 : Math.max(...bashRows.map((r) => r.bash_count));

  // Total tool calls
  const toolCountRow = db
    .query<ToolCountRow, [string]>(
      "SELECT COUNT(*) AS total FROM tool_calls WHERE session_id = ?"
    )
    .get(sessionId);
  const totalToolCalls = toolCountRow?.total ?? 0;

  return {
    sessionId,
    durationMs,
    totalCacheReadTokens,
    maxBashCallsPerTurn,
    totalToolCalls,
  };
}
