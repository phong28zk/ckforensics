/**
 * Core ingest pipeline: reads a JSONL file and persists events to SQLite.
 *
 * Key properties:
 *   - Idempotent: INSERT OR IGNORE on PRIMARY KEY (session_id, event_id)
 *   - Incremental: resumes from last_offset in ingest_state table
 *   - Batched: flushes every BATCH_SIZE events in a single transaction
 *   - event_id: deterministic 16-hex SHA-256 prefix of (timestamp + raw_json)
 *   - Session metadata (min/max timestamps, total_events) is cached in memory
 *     and flushed once per file end to minimise DB round-trips.
 *
 * File reading is delegated to ingest-file-reader.ts.
 * Derived-row insertion (tool_calls, token_usage) is in ingest-derived-rows.ts.
 *
 * Entry point: ingestFile(db, filePath, projectSlug, tracker?)
 */

import type { Database } from "bun:sqlite";
import type { IngestStmts } from "./ingest-stmts.ts";
import { classifyLine } from "../parsers/event-classifier.ts";
import type { ParsedEvent } from "../parsers/event-types.ts";
import { computeEventId } from "./event-id-hasher.ts";
import { IngestStateTracker } from "./ingest-state-tracker.ts";
import { readLinesFromOffset } from "./ingest-file-reader.ts";
import { insertAssistantDerived } from "./ingest-derived-rows.ts";
import { prepareIngestStmts } from "./ingest-stmts.ts";
export type { IngestStmts } from "./ingest-stmts.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IngestResult {
  linesRead: number;
  eventsInserted: number;
  finalOffset: number;
}

/** In-memory session accumulator — reduces per-event UPDATE overhead. */
interface SessionAccum {
  id: string;
  projectSlug: string;
  model: string;
  version: string;
  minTs: string;
  maxTs: string;
  deltaEvents: number;
  /** true once a stub row has been INSERT OR IGNOREd into sessions. */
  flushedToDb: boolean;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ingest a single JSONL file into the SQLite database.
 *
 * @param db          Open bun:sqlite Database (migrations already applied).
 * @param filePath    Absolute path to the .jsonl file.
 * @param projectSlug Slug label for the owning project.
 * @param tracker     Optional IngestStateTracker; created internally if omitted.
 */
export async function ingestFile(
  db: Database,
  filePath: string,
  projectSlug: string,
  tracker?: IngestStateTracker
): Promise<IngestResult> {
  const ownTracker = !tracker;
  const st = tracker ?? new IngestStateTracker(db);

  const startOffset = st.getOffset(filePath);
  const stmts = prepareIngestStmts(db);
  const sessions = new Map<string, SessionAccum>();

  const lines = await readLinesFromOffset(filePath, startOffset);
  let linesRead = 0;
  let eventsInserted = 0;
  let currentOffset = startOffset;
  let batch: Array<{ line: string; byteLen: number }> = [];

  const flush = (): void => {
    if (batch.length === 0) return;
    const inserted = db.transaction((): number => {
      let n = 0;
      for (const { line, byteLen } of batch) {
        if (line.length === 0) { currentOffset += byteLen; continue; }
        const event = classifyLine(line);
        const ok = insertEventRow(stmts, sessions, event, line, projectSlug);
        if (ok) n++;
        currentOffset += byteLen;
      }
      return n;
    })();
    eventsInserted += inserted;
    batch = [];
  };

  for (const item of lines) {
    linesRead += item.line.length > 0 ? 1 : 0;
    batch.push(item);
    if (batch.length >= BATCH_SIZE) flush();
  }
  flush();

  // Merge accumulated session metadata in one final transaction
  flushSessions(db, stmts, sessions);

  db.transaction(() => { st.saveOffset(filePath, currentOffset); })();
  if (ownTracker) st.finalize();

  return { linesRead, eventsInserted, finalOffset: currentOffset };
}

// ── Session accumulator flush ─────────────────────────────────────────────────

function flushSessions(
  db: Database,
  stmts: IngestStmts,
  sessions: Map<string, SessionAccum>
): void {
  if (sessions.size === 0) return;
  db.transaction(() => {
    for (const s of sessions.values()) {
      stmts.updateSession.run({
        $id: s.id,
        $minTs: s.minTs,
        $maxTs: s.maxTs,
        $model: s.model,
        $version: s.version,
        $delta: s.deltaEvents,
      });
    }
  })();
}

// ── Per-event insertion ───────────────────────────────────────────────────────

function insertEventRow(
  stmts: IngestStmts,
  sessions: Map<string, SessionAccum>,
  event: ParsedEvent,
  rawLine: string,
  projectSlug: string
): boolean {
  const sessionId = extractSessionId(event);
  if (!sessionId) return false;

  const ts = extractTimestamp(event) ?? "";
  const eventId = computeEventId(ts || undefined, rawLine);

  // Ensure a session stub row exists before the event INSERT (FK constraint).
  let accum = sessions.get(sessionId);
  if (!accum) {
    accum = {
      id: sessionId, projectSlug,
      model: extractModel(event) ?? "",
      version: extractVersion(event) ?? "",
      minTs: ts, maxTs: ts,
      deltaEvents: 0, flushedToDb: false,
    };
    sessions.set(sessionId, accum);
  }

  if (!accum.flushedToDb) {
    stmts.upsertSession.run({
      $id: sessionId, $slug: projectSlug,
      $minTs: ts || null, $maxTs: ts || null,
      $model: accum.model, $version: accum.version, $delta: 0,
    });
    accum.flushedToDb = true;
  }

  if (ts && (!accum.minTs || ts < accum.minTs)) accum.minTs = ts;
  if (ts && ts > accum.maxTs) accum.maxTs = ts;
  accum.deltaEvents++;
  if (!accum.model) accum.model = extractModel(event) ?? accum.model;
  if (!accum.version) accum.version = extractVersion(event) ?? accum.version;

  const info = stmts.insertEvent.run({
    $eventId: eventId, $sessionId: sessionId,
    $type: event.kind, $ts: ts || null, $raw: rawLine,
  });

  const wasInserted = (info as { changes: number }).changes > 0;
  if (wasInserted && event.kind === "assistant") {
    insertAssistantDerived(stmts, event, eventId, sessionId);
  }
  return wasInserted;
}

// ── Field extractors ──────────────────────────────────────────────────────────

function extractSessionId(event: ParsedEvent): string | undefined {
  const e = event as unknown as Record<string, unknown>;
  return typeof e["sessionId"] === "string" ? e["sessionId"] : undefined;
}

function extractTimestamp(event: ParsedEvent): string | undefined {
  const e = event as unknown as Record<string, unknown>;
  return typeof e["timestamp"] === "string" ? e["timestamp"] : undefined;
}

function extractModel(event: ParsedEvent): string | undefined {
  if (event.kind === "assistant") return event.message.model ?? undefined;
  return undefined;
}

function extractVersion(event: ParsedEvent): string | undefined {
  const e = event as unknown as Record<string, unknown>;
  return typeof e["version"] === "string" ? e["version"] : undefined;
}
