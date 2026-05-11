/**
 * Effectiveness analyzer: compares sessions where a skill was used vs sessions
 * where a similar pattern existed but no skill was invoked.
 *
 * Metric: average tool-call count per session (proxy for effort/complexity).
 * Relative effectiveness score = clamp(0, 100,
 *   round(100 × (1 − used_avg / unused_avg)))
 *
 * If unused_avg ≤ 0 or no unused sessions exist → score = 50 (unknown).
 */

import type { Database } from "bun:sqlite";
import type { SkillEffectivenessReport } from "./types.ts";

// ── DB queries ─────────────────────────────────────────────────────────────────

interface SessionToolCallRow {
  session_id: string;
  tool_calls: number;
}

/**
 * Count tool_use blocks per session using the events table.
 * Only assistant events with type='assistant' carry tool_use content.
 */
function getSessionToolCallCounts(db: Database): Map<string, number> {
  // Sum tool_use occurrences by counting them in raw_json via LIKE heuristic.
  // Exact count: count occurrences of '"type":"tool_use"' in raw_json per session.
  interface Row { session_id: string; cnt: number }
  const rows = db
    .query<Row, []>(
      `SELECT session_id,
              SUM(
                (LENGTH(raw_json) - LENGTH(REPLACE(raw_json, '"tool_use"', '')))
                / LENGTH('"tool_use"')
              ) AS cnt
       FROM events
       WHERE type = 'assistant'
       GROUP BY session_id`
    )
    .all();

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.session_id, r.cnt ?? 0);
  }
  return map;
}

/**
 * Get all sessions that used a specific skill.
 */
function getSessionsUsingSkill(db: Database, skillName: string): Set<string> {
  interface Row { session_id: string }
  const rows = db
    .query<Row, [string]>(
      "SELECT DISTINCT session_id FROM skill_usage WHERE skill_name = ?"
    )
    .all(skillName);
  return new Set(rows.map((r) => r.session_id));
}

/**
 * Get all session IDs in the database.
 */
function getAllSessionIds(db: Database): string[] {
  interface Row { id: string }
  return db
    .query<Row, []>("SELECT id FROM sessions")
    .all()
    .map((r) => r.id);
}

// ── Score computation ─────────────────────────────────────────────────────────

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function effectivenessScore(usedAvg: number, unusedAvg: number): number {
  if (unusedAvg <= 0) return 50; // unknown baseline
  const ratio = usedAvg / unusedAvg;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - ratio))));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze effectiveness for a single skill across all sessions.
 */
export function analyzeSkillEffectiveness(
  db: Database,
  skillName: string
): SkillEffectivenessReport {
  const toolCallCounts = getSessionToolCallCounts(db);
  const usedSessions = getSessionsUsingSkill(db, skillName);
  const allIds = getAllSessionIds(db);

  const usedCounts: number[] = [];
  const unusedCounts: number[] = [];

  for (const id of allIds) {
    const count = toolCallCounts.get(id) ?? 0;
    if (usedSessions.has(id)) {
      usedCounts.push(count);
    } else {
      unusedCounts.push(count);
    }
  }

  const usedAvg = average(usedCounts);
  const unusedAvg = average(unusedCounts);

  return {
    skillName,
    usedSessions: usedCounts.length,
    unusedSessions: unusedCounts.length,
    avgToolCallsWithSkill: Math.round(usedAvg),
    avgToolCallsWithout: Math.round(unusedAvg),
    effectivenessScore: effectivenessScore(usedAvg, unusedAvg),
  };
}

/**
 * Analyze effectiveness for multiple skills at once.
 * Shares DB query cost for tool-call counts.
 */
export function analyzeMultipleSkills(
  db: Database,
  skillNames: string[]
): SkillEffectivenessReport[] {
  if (skillNames.length === 0) return [];

  const toolCallCounts = getSessionToolCallCounts(db);
  const allIds = getAllSessionIds(db);

  return skillNames.map((skillName) => {
    const usedSessions = getSessionsUsingSkill(db, skillName);
    const usedCounts: number[] = [];
    const unusedCounts: number[] = [];

    for (const id of allIds) {
      const count = toolCallCounts.get(id) ?? 0;
      if (usedSessions.has(id)) {
        usedCounts.push(count);
      } else {
        unusedCounts.push(count);
      }
    }

    const usedAvg = average(usedCounts);
    const unusedAvg = average(unusedCounts);

    return {
      skillName,
      usedSessions: usedCounts.length,
      unusedSessions: unusedCounts.length,
      avgToolCallsWithSkill: Math.round(usedAvg),
      avgToolCallsWithout: Math.round(unusedAvg),
      effectivenessScore: effectivenessScore(usedAvg, unusedAvg),
    };
  });
}
