/**
 * Sessions query: lists recent sessions with metadata.
 *
 * Supports filtering by project slug and limiting result count.
 * Returns rows from the sessions table joined with token_usage aggregates.
 */

import type { Database } from "bun:sqlite";

export interface SessionRow {
  id: string;
  projectSlug: string;
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  totalEvents: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  durationMs: number | null;
}

export interface ListSessionsOptions {
  projectSlug?: string;
  limit?: number;
}

interface DbSessionRow {
  id: string;
  project_slug: string;
  cwd: string | null;
  started_at: string | null;
  ended_at: string | null;
  model: string | null;
  total_events: number;
  input: number;
  output: number;
  cost_usd: number | null;
}

/**
 * List recent sessions ordered by started_at DESC.
 *
 * @param db    Open database with migrations applied.
 * @param opts  Optional project filter and result limit.
 */
export function listSessions(
  db: Database,
  opts: ListSessionsOptions = {}
): SessionRow[] {
  const limit = opts.limit ?? 20;

  // Build WHERE clause based on optional project filter
  const hasFilter = !!opts.projectSlug;
  const sql = `
    SELECT
      s.id,
      s.project_slug,
      s.cwd,
      s.started_at,
      s.ended_at,
      s.model,
      s.total_events,
      COALESCE(SUM(tu.input), 0)    AS input,
      COALESCE(SUM(tu.output), 0)   AS output,
      COALESCE(SUM(tu.cost_usd), 0) AS cost_usd
    FROM sessions s
    LEFT JOIN token_usage tu ON tu.session_id = s.id
    ${hasFilter ? "WHERE s.project_slug = ?" : ""}
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT ?
  `;

  const rows = hasFilter
    ? db.query<DbSessionRow, [string, number]>(sql).all(opts.projectSlug!, limit)
    : db.query<DbSessionRow, [number]>(sql).all(limit);

  return rows.map((r) => ({
    id: r.id,
    projectSlug: r.project_slug,
    cwd: r.cwd ?? null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    model: r.model,
    totalEvents: r.total_events,
    inputTokens: r.input ?? 0,
    outputTokens: r.output ?? 0,
    estimatedCostUsd: r.cost_usd ?? null,
    durationMs: computeDurationMs(r.started_at, r.ended_at),
  }));
}

function computeDurationMs(
  start: string | null,
  end: string | null
): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return isNaN(ms) || ms < 0 ? null : ms;
}
