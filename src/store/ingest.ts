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
import { insertFilesTouched } from "./ingest-files-touched.ts";
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

  // Backfill cost_usd for token_usage rows of sessions touched by this ingest
  backfillCostUsd(db, Array.from(sessions.keys()));

  db.transaction(() => { st.saveOffset(filePath, currentOffset); })();
  if (ownTracker) st.finalize();

  return { linesRead, eventsInserted, finalOffset: currentOffset };
}

// ── Cost backfill ─────────────────────────────────────────────────────────────

/**
 * Compute token_usage.cost_usd from session.model pricing for the given sessions.
 * Pricing per million tokens (USD), Nov 2025 snapshot — version-aware:
 *   Opus 4.5+ (4.5/4.6/4.7): input=5,    output=25,   cacheRead=0.50, cacheWrite=6.25
 *   Opus 4.0/4.1 (legacy):   input=15,   output=75,   cacheRead=1.50, cacheWrite=18.75
 *   Sonnet 4.x:              input=3,    output=15,   cacheRead=0.30, cacheWrite=3.75
 *   Haiku 4.5:               input=1,    output=5,    cacheRead=0.10, cacheWrite=1.25
 *   Haiku 3.5:               input=0.8,  output=4,    cacheRead=0.08, cacheWrite=1.0
 *   Haiku 3 (legacy):        input=0.25, output=1.25, cacheRead=0.03, cacheWrite=0.30
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Keep in sync with src/lib/model-pricing.ts.
 */
function backfillCostUsd(db: Database, sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const placeholders = sessionIds.map(() => "?").join(",");
  // SQL helper: returns input pricing rate matching getModelPricing() tiers.
  // Each pricing column repeats the same CASE chain with different rates.
  const inputCase = `
    CASE
      WHEN LOWER(s.model) LIKE '%opus-4-5%' OR LOWER(s.model) LIKE '%opus-4-6%' OR LOWER(s.model) LIKE '%opus-4-7%' OR LOWER(s.model) LIKE '%opus-5%' THEN 5.0
      WHEN LOWER(s.model) LIKE '%opus%'   THEN 15.0
      WHEN LOWER(s.model) LIKE '%sonnet%' THEN 3.0
      WHEN LOWER(s.model) LIKE '%haiku-4%' THEN 1.0
      WHEN LOWER(s.model) LIKE '%haiku-3-5%' THEN 0.8
      WHEN LOWER(s.model) LIKE '%haiku%'  THEN 0.25
      ELSE 0 END`;
  const outputCase = `
    CASE
      WHEN LOWER(s.model) LIKE '%opus-4-5%' OR LOWER(s.model) LIKE '%opus-4-6%' OR LOWER(s.model) LIKE '%opus-4-7%' OR LOWER(s.model) LIKE '%opus-5%' THEN 25.0
      WHEN LOWER(s.model) LIKE '%opus%'   THEN 75.0
      WHEN LOWER(s.model) LIKE '%sonnet%' THEN 15.0
      WHEN LOWER(s.model) LIKE '%haiku-4%' THEN 5.0
      WHEN LOWER(s.model) LIKE '%haiku-3-5%' THEN 4.0
      WHEN LOWER(s.model) LIKE '%haiku%'  THEN 1.25
      ELSE 0 END`;
  const cacheReadCase = `
    CASE
      WHEN LOWER(s.model) LIKE '%opus-4-5%' OR LOWER(s.model) LIKE '%opus-4-6%' OR LOWER(s.model) LIKE '%opus-4-7%' OR LOWER(s.model) LIKE '%opus-5%' THEN 0.5
      WHEN LOWER(s.model) LIKE '%opus%'   THEN 1.5
      WHEN LOWER(s.model) LIKE '%sonnet%' THEN 0.3
      WHEN LOWER(s.model) LIKE '%haiku-4%' THEN 0.1
      WHEN LOWER(s.model) LIKE '%haiku-3-5%' THEN 0.08
      WHEN LOWER(s.model) LIKE '%haiku%'  THEN 0.03
      ELSE 0 END`;
  const cacheWriteCase = `
    CASE
      WHEN LOWER(s.model) LIKE '%opus-4-5%' OR LOWER(s.model) LIKE '%opus-4-6%' OR LOWER(s.model) LIKE '%opus-4-7%' OR LOWER(s.model) LIKE '%opus-5%' THEN 6.25
      WHEN LOWER(s.model) LIKE '%opus%'   THEN 18.75
      WHEN LOWER(s.model) LIKE '%sonnet%' THEN 3.75
      WHEN LOWER(s.model) LIKE '%haiku-4%' THEN 1.25
      WHEN LOWER(s.model) LIKE '%haiku-3-5%' THEN 1.0
      WHEN LOWER(s.model) LIKE '%haiku%'  THEN 0.3
      ELSE 0 END`;

  db.run(
    `UPDATE token_usage AS tu
     SET cost_usd = (
       SELECT
         (tu.input        * ${inputCase}
        + tu.output       * ${outputCase}
        + tu.cache_read   * ${cacheReadCase}
        + tu.cache_create * ${cacheWriteCase}
         ) / 1000000.0
       FROM sessions s WHERE s.id = tu.session_id
     )
     WHERE tu.session_id IN (${placeholders})`,
    sessionIds
  );
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
    insertFilesTouched(stmts, event, eventId, sessionId);
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
