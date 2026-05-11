/**
 * Prepared-statement factory for the ingest pipeline.
 *
 * Centralises all SQL for ingest operations so ingest.ts stays
 * focused on orchestration logic only.
 */

import type { Database } from "bun:sqlite";

/** Prepared statement bundle shared across ingest modules. */
export interface IngestStmts {
  upsertSession: ReturnType<Database["prepare"]>;
  updateSession: ReturnType<Database["prepare"]>;
  insertEvent: ReturnType<Database["prepare"]>;
  insertToolCall: ReturnType<Database["prepare"]>;
  insertTokenUsage: ReturnType<Database["prepare"]>;
  insertFileTouched: ReturnType<Database["prepare"]>;
}

/**
 * Create and return all prepared statements needed for one ingest run.
 *
 * Statements are NOT finalised here — the caller (ingest.ts) controls
 * their lifetime via IngestStateTracker.finalize() and DB closure.
 */
export function prepareIngestStmts(db: Database): IngestStmts {
  return {
    // Stub insert: creates the session row on first encounter.
    // INSERT OR IGNORE — subsequent encounters for the same session are no-ops.
    upsertSession: db.prepare(
      `INSERT OR IGNORE INTO sessions
         (id, project_slug, started_at, ended_at, model, version, total_events)
       VALUES ($id, $slug, $minTs, $maxTs, $model, $version, $delta)`
    ),

    // Metadata merge: applied once per session at end-of-file flush.
    // Updates min/max timestamps and total_events from in-memory accumulators.
    updateSession: db.prepare(
      `UPDATE sessions SET
          started_at   = CASE WHEN started_at IS NULL
                               OR (started_at > $minTs AND $minTs != '')
                           THEN $minTs ELSE started_at END,
          ended_at     = CASE WHEN ended_at IS NULL OR ended_at < $maxTs
                           THEN $maxTs ELSE ended_at END,
          model        = COALESCE(NULLIF(model, ''), $model),
          version      = COALESCE(NULLIF(version, ''), $version),
          total_events = total_events + $delta
       WHERE id = $id`
    ),

    // Event row: idempotent via INSERT OR IGNORE on (session_id, event_id) PK.
    insertEvent: db.prepare(
      `INSERT OR IGNORE INTO events
         (event_id, session_id, type, timestamp, raw_json)
       VALUES ($eventId, $sessionId, $type, $ts, $raw)`
    ),

    // Tool call row: idempotent via INSERT OR IGNORE on id PK.
    insertToolCall: db.prepare(
      `INSERT OR IGNORE INTO tool_calls
         (id, event_id, session_id, tool_name, input_summary)
       VALUES ($id, $eventId, $sessionId, $name, $summary)`
    ),

    // Token usage row: idempotent via INSERT OR IGNORE on (session_id, event_id) PK.
    insertTokenUsage: db.prepare(
      `INSERT OR IGNORE INTO token_usage
         (event_id, session_id, input, output, cache_read, cache_create)
       VALUES ($eventId, $sessionId, $input, $output, $cacheRead, $cacheCreate)`
    ),

    // Files touched row: one per (event, path) tool call edit/write.
    // No explicit idempotency — same event re-ingested produces same rows; we
    // rely on event-level idempotency upstream (events.INSERT OR IGNORE).
    insertFileTouched: db.prepare(
      `INSERT INTO files_touched
         (event_id, session_id, path, action, lines_added, lines_removed)
       VALUES ($eventId, $sessionId, $path, $action, $linesAdded, $linesRemoved)`
    ),
  };
}
