/**
 * SQLite connection factory for ckforensics.
 *
 * Opens a bun:sqlite Database with production pragmas:
 *   - WAL journal mode for concurrent reads during ingest
 *   - synchronous=NORMAL for durability/performance balance
 *   - 20 MB cache (cache_size=-20000 = 20000 KiB pages)
 *   - 512 MB mmap for large DB reads without extra syscalls
 *   - foreign_keys=ON to enforce referential integrity
 *
 * After first open on a real path, chmod 0600 is applied (Unix only).
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

export interface DbOptions {
  /** If true, open as read-only (no WAL setup, no chmod). */
  readonly?: boolean;
  /** Override pragmas for testing (e.g. disable mmap). */
  skipMmap?: boolean;
}

/**
 * Open (or create) a SQLite database at `dbPath`.
 *
 * Callers are responsible for running migrations before the first write.
 * The returned Database instance is NOT wrapped in a connection pool —
 * single-process, single-connection use is the intended model.
 *
 * @param dbPath  Absolute path to the .db file, or ":memory:" for tests.
 * @param opts    Optional flags (readonly, skipMmap).
 */
export function openDb(dbPath: string, opts: DbOptions = {}): Database {
  const db = new Database(dbPath, {
    readonly: opts.readonly ?? false,
    create: !(opts.readonly ?? false),
  });

  if (!opts.readonly) {
    applyWritePragmas(db, opts.skipMmap ?? false);
  }

  // Secure file permissions on Unix for real (non-memory) paths
  if (dbPath !== ":memory:" && !opts.readonly) {
    securePath(dbPath);
  }

  return db;
}

/** Apply WAL + performance pragmas for write connections. */
function applyWritePragmas(db: Database, skipMmap: boolean): void {
  // WAL mode: readers don't block writers and vice versa
  db.exec("PRAGMA journal_mode = WAL;");
  // NORMAL: fsync at checkpoints only — safe for single-process use
  db.exec("PRAGMA synchronous = NORMAL;");
  // 20 000 pages × 1 KiB default page = ~20 MB page cache
  db.exec("PRAGMA cache_size = -20000;");
  // Foreign key enforcement
  db.exec("PRAGMA foreign_keys = ON;");
  // Temp tables go to memory, not disk
  db.exec("PRAGMA temp_store = MEMORY;");

  if (!skipMmap) {
    // 512 MB memory-mapped I/O — speeds up sequential scans on large DBs
    db.exec("PRAGMA mmap_size = 536870912;");
  }
}

/**
 * Set file permissions to 0600 on Unix if the file now exists.
 * No-op on Windows (process.platform === "win32").
 */
function securePath(dbPath: string): void {
  if (process.platform === "win32") return;
  try {
    if (existsSync(dbPath)) {
      chmodSync(dbPath, 0o600);
    }
  } catch {
    // Non-fatal — permissions may already be correct or path may be virtual
  }
}

/** Close a database, flushing WAL and releasing file handles. */
export function closeDb(db: Database): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // Ignore checkpoint errors on read-only or in-memory DBs
  }
  db.close();
}
