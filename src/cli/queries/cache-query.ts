/**
 * Cache visibility query: aggregates cache hit/miss stats from token_usage.
 *
 * Cache hit ratio = cache_read / (cache_read + cache_create + input)
 * Estimated savings = cache_read tokens * (inputPer1M - cacheReadPer1M) / 1M
 *
 * Savings use a conservative fallback pricing (Sonnet) when the session model is unknown.
 * All callers should pass opts.days or opts.sessionId; without either, defaults to 7 days.
 */

import type { Database } from "bun:sqlite";
import { getModelPricing } from "../../lib/model-pricing.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Fallback when model is unknown: Sonnet input rate - cache-read rate per million. */
const FALLBACK_SAVINGS_PER_1M = 3 - 0.3; // $2.70 per 1M tokens read from cache

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionCacheRow {
  sessionId: string;
  projectSlug: string;
  cacheRead: number;
  cacheCreate: number;
  input: number;
  hitRatio: number;
  savingsUsd: number;
}

export interface CacheBreakdown {
  totalCacheRead: number;
  totalCacheCreate: number;
  totalInput: number;
  /** cache_read / (cache_read + cache_create + input); 0 when denominator is 0. */
  cacheHitRatio: number;
  /** Estimated USD saved vs paying raw input rates (model-aware). */
  estimatedSavingsUsd: number;
  bySession: SessionCacheRow[];
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface AggRow {
  cache_read: number;
  cache_create: number;
  input: number;
}

interface SessionAggRow {
  session_id: string;
  project_slug: string;
  model: string | null;
  cache_read: number;
  cache_create: number;
  input: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hitRatio(cacheRead: number, cacheCreate: number, input: number): number {
  const denom = cacheRead + cacheCreate + input;
  return denom === 0 ? 0 : cacheRead / denom;
}

function computeSavings(cacheRead: number, model: string | null | undefined): number {
  const p = getModelPricing(model);
  const savingsPer1M = p ? p.inputPer1M - p.cacheReadPer1M : FALLBACK_SAVINGS_PER_1M;
  // Savings = tokens that hit the cache * (what we'd have paid at input rate - cache rate)
  return (cacheRead * Math.max(0, savingsPer1M)) / 1_000_000;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface CacheQueryOpts {
  /** Filter to sessions started within the last N days. Default 7. */
  days?: number;
  /** Filter to a single session ID (overrides days). */
  sessionId?: string;
}

/**
 * Aggregate cache performance breakdown from token_usage.
 *
 * @param db    Open DB with migrations applied.
 * @param opts  Scope to specific session or time window.
 */
export function getCacheBreakdown(db: Database, opts: CacheQueryOpts = {}): CacheBreakdown {
  const { sessionId, days = 7 } = opts;

  // Build WHERE clause based on scope
  let whereClause: string;
  let params: string[];

  if (sessionId) {
    whereClause = "s.id = ?";
    params = [sessionId];
  } else {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    whereClause = "(s.started_at >= ? OR s.started_at IS NULL)";
    params = [cutoff];
  }

  // Aggregate totals
  const aggRow = db
    .query<AggRow, string[]>(
      `SELECT
         COALESCE(SUM(tu.cache_read), 0)   AS cache_read,
         COALESCE(SUM(tu.cache_create), 0) AS cache_create,
         COALESCE(SUM(tu.input), 0)        AS input
       FROM token_usage tu
       JOIN sessions s ON s.id = tu.session_id
       WHERE ${whereClause}`
    )
    .get(...params) ?? { cache_read: 0, cache_create: 0, input: 0 };

  const totalCacheRead = aggRow.cache_read;
  const totalCacheCreate = aggRow.cache_create;
  const totalInput = aggRow.input;
  const cacheHitRatio = hitRatio(totalCacheRead, totalCacheCreate, totalInput);

  // Per-session breakdown (sorted by cache_read DESC for top-N display)
  const sessionRows = db
    .query<SessionAggRow, string[]>(
      `SELECT
         s.id           AS session_id,
         s.project_slug AS project_slug,
         s.model        AS model,
         COALESCE(SUM(tu.cache_read), 0)   AS cache_read,
         COALESCE(SUM(tu.cache_create), 0) AS cache_create,
         COALESCE(SUM(tu.input), 0)        AS input
       FROM token_usage tu
       JOIN sessions s ON s.id = tu.session_id
       WHERE ${whereClause}
       GROUP BY s.id
       ORDER BY cache_read DESC`
    )
    .all(...params);

  // Sum savings across sessions (model-aware per session)
  let estimatedSavingsUsd = 0;
  const bySession: SessionCacheRow[] = sessionRows.map((row) => {
    const savings = computeSavings(row.cache_read, row.model);
    estimatedSavingsUsd += savings;
    return {
      sessionId: row.session_id,
      projectSlug: row.project_slug,
      cacheRead: row.cache_read,
      cacheCreate: row.cache_create,
      input: row.input,
      hitRatio: hitRatio(row.cache_read, row.cache_create, row.input),
      savingsUsd: savings,
    };
  });

  return {
    totalCacheRead,
    totalCacheCreate,
    totalInput,
    cacheHitRatio,
    estimatedSavingsUsd,
    bySession,
  };
}
