/**
 * Session loader: queries all events for a session from SQLite, ordered by
 * timestamp, and hydrates raw_json into typed ParsedEvent instances.
 *
 * Does NOT re-parse JSONL files — reads exclusively from the events table.
 */

import type { Database } from "bun:sqlite";
import { classifyEvent } from "../parsers/event-classifier.ts";
import type { SessionInfo, HydratedEvent } from "./manifest-types.ts";

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface EventRow {
  event_id: string;
  session_id: string;
  type: string;
  timestamp: string | null;
  raw_json: string;
}

interface SessionRow {
  id: string;
  project_slug: string;
  started_at: string | null;
  ended_at: string | null;
  model: string | null;
  total_events: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SessionWithEvents {
  session: SessionInfo;
  events: HydratedEvent[];
}

/**
 * Load and hydrate all events for a session.
 *
 * Events are ordered by timestamp ASC (NULLs last), then by rowid for
 * events sharing the same timestamp (preserves insertion order).
 *
 * @throws Error if the session ID does not exist in the database.
 */
export function loadSession(db: Database, sessionId: string): SessionWithEvents {
  const session = loadSessionMeta(db, sessionId);
  const events = loadHydratedEvents(db, sessionId);
  return { session, events };
}

/**
 * List all session IDs in the database, ordered by started_at DESC.
 * Useful for `--last` flag resolution.
 */
export function listSessionIds(db: Database): string[] {
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM sessions ORDER BY started_at DESC"
    )
    .all();
  return rows.map((r) => r.id);
}

/**
 * Return the most recent session ID, or null if the DB is empty.
 */
export function latestSessionId(db: Database): string | null {
  const row = db
    .query<{ id: string }, []>(
      "SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1"
    )
    .get();
  return row?.id ?? null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function loadSessionMeta(db: Database, sessionId: string): SessionInfo {
  const row = db
    .query<SessionRow, [string]>(
      `SELECT id, project_slug, started_at, ended_at, model, total_events
       FROM sessions WHERE id = ?`
    )
    .get(sessionId);

  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return {
    id: row.id,
    projectSlug: row.project_slug,
    startedAt: row.started_at ?? "",
    endedAt: row.ended_at ?? "",
    model: row.model ?? "",
    totalEvents: row.total_events,
  };
}

function loadHydratedEvents(db: Database, sessionId: string): HydratedEvent[] {
  const rows = db
    .query<EventRow, [string]>(
      `SELECT event_id, session_id, type, timestamp, raw_json
       FROM events
       WHERE session_id = ?
       ORDER BY
         CASE WHEN timestamp IS NULL THEN 1 ELSE 0 END,
         timestamp ASC,
         rowid ASC`
    )
    .all(sessionId);

  return rows.map((row) => hydrateRow(row));
}

function hydrateRow(row: EventRow): HydratedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.raw_json);
  } catch {
    // Malformed row — wrap as unknown event
    parsed = { type: "(json-parse-error)", raw: row.raw_json };
  }

  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    type: row.type,
    timestamp: row.timestamp,
    event: classifyEvent(parsed),
  };
}
