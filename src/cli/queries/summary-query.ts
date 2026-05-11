/**
 * Summary query: aggregates token usage, cost, session count, and files touched
 * across a rolling time window (default 7 days).
 *
 * Queries three tables: sessions, token_usage, files_touched.
 */

import type { Database } from "bun:sqlite";

export interface SummaryResult {
  periodDays: number;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  totalTokens: number;
  estimatedCostUsd: number;
  filesTouched: number;
  editOps: number;
  oldestSession: string | null;
  newestSession: string | null;
}

interface TokenRow {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  cost_usd: number | null;
}

interface SessionCountRow {
  n: number;
  oldest: string | null;
  newest: string | null;
}

interface FilesRow {
  files_touched: number;
  edit_ops: number;
}

/**
 * Aggregate usage stats for the last `days` days.
 *
 * @param db    Open database with migrations applied.
 * @param days  Rolling window in days (default 7).
 */
export function getSummary(db: Database, days = 7): SummaryResult {
  const cutoff = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();

  // Session counts in window
  const sessionRow = db
    .query<SessionCountRow, [string]>(
      `SELECT COUNT(*) AS n,
              MIN(started_at) AS oldest,
              MAX(started_at) AS newest
       FROM sessions
       WHERE started_at >= ? OR started_at IS NULL`
    )
    .get(cutoff) ?? { n: 0, oldest: null, newest: null };

  // Token totals joined through sessions for date filter
  const tokenRow = db
    .query<TokenRow, [string]>(
      `SELECT
         COALESCE(SUM(tu.input), 0)        AS input,
         COALESCE(SUM(tu.output), 0)       AS output,
         COALESCE(SUM(tu.cache_read), 0)   AS cache_read,
         COALESCE(SUM(tu.cache_create), 0) AS cache_create,
         COALESCE(SUM(tu.cost_usd), 0)     AS cost_usd
       FROM token_usage tu
       JOIN sessions s ON s.id = tu.session_id
       WHERE s.started_at >= ? OR s.started_at IS NULL`
    )
    .get(cutoff) ?? { input: 0, output: 0, cache_read: 0, cache_create: 0, cost_usd: 0 };

  // Files touched in window
  const filesRow = db
    .query<FilesRow, [string]>(
      `SELECT
         COUNT(DISTINCT ft.path)  AS files_touched,
         COUNT(*)                 AS edit_ops
       FROM files_touched ft
       JOIN sessions s ON s.id = ft.session_id
       WHERE s.started_at >= ? OR s.started_at IS NULL`
    )
    .get(cutoff) ?? { files_touched: 0, edit_ops: 0 };

  const totalTokens =
    (tokenRow.input ?? 0) +
    (tokenRow.output ?? 0) +
    (tokenRow.cache_read ?? 0) +
    (tokenRow.cache_create ?? 0);

  return {
    periodDays: days,
    sessionCount: sessionRow.n ?? 0,
    totalInputTokens: tokenRow.input ?? 0,
    totalOutputTokens: tokenRow.output ?? 0,
    totalCacheRead: tokenRow.cache_read ?? 0,
    totalCacheCreate: tokenRow.cache_create ?? 0,
    totalTokens,
    estimatedCostUsd: tokenRow.cost_usd ?? 0,
    filesTouched: filesRow.files_touched ?? 0,
    editOps: filesRow.edit_ops ?? 0,
    oldestSession: sessionRow.oldest ?? null,
    newestSession: sessionRow.newest ?? null,
  };
}
