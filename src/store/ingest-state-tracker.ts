/**
 * Tracks per-file ingest progress in the ingest_state table.
 *
 * Each JSONL file is identified by its absolute path.
 * last_offset stores the byte position after the last successfully ingested
 * line, allowing incremental resume without re-reading the whole file.
 *
 * All reads/writes use prepared statements for performance.
 */

import type { Database, Statement } from "bun:sqlite";

export interface IngestStateRow {
  file_path: string;
  last_offset: number;
  last_ingested_at: string;
}

export class IngestStateTracker {
  private readonly stmtGet: Statement<IngestStateRow, [string]>;
  private readonly stmtUpsert: Statement<void, [string, number]>;

  constructor(private readonly db: Database) {
    // Read current offset for a file
    this.stmtGet = db.prepare<IngestStateRow, [string]>(
      `SELECT file_path, last_offset, last_ingested_at
         FROM ingest_state
        WHERE file_path = ?`
    );

    // Insert or update offset + timestamp atomically
    this.stmtUpsert = db.prepare<void, [string, number]>(
      `INSERT INTO ingest_state (file_path, last_offset, last_ingested_at)
            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(file_path) DO UPDATE SET
         last_offset      = excluded.last_offset,
         last_ingested_at = excluded.last_ingested_at`
    );
  }

  /**
   * Return the last recorded byte offset for a file.
   * Returns 0 if the file has never been ingested.
   */
  getOffset(filePath: string): number {
    const row = this.stmtGet.get(filePath);
    return row?.last_offset ?? 0;
  }

  /**
   * Persist the new offset after a successful ingest batch.
   * Called inside the same transaction as the batch insert for atomicity.
   */
  saveOffset(filePath: string, offset: number): void {
    this.stmtUpsert.run(filePath, offset);
  }

  /** Return the full state row, or undefined if never ingested. */
  getRow(filePath: string): IngestStateRow | undefined {
    return this.stmtGet.get(filePath) ?? undefined;
  }

  /** Finalize prepared statements (call when done with this tracker). */
  finalize(): void {
    this.stmtGet.finalize();
    this.stmtUpsert.finalize();
  }
}
