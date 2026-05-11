/**
 * Schema migration runner for ckforensics SQLite store.
 *
 * Strategy: PRAGMA user_version tracks the applied migration level.
 *   - user_version = 0  → fresh DB, apply all migrations
 *   - user_version = N  → apply migrations N+1 … latest only
 *
 * Each migration is a plain SQL file in src/store/migrations/.
 * Migrations are applied inside a single transaction per migration file
 * and user_version is bumped atomically within the same transaction.
 *
 * Migration files must be named: NNN-description.sql  (NNN = 3-digit int).
 * They are applied in numeric order; gaps are not allowed.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve migrations directory relative to this source file
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

/** A resolved migration entry. */
interface Migration {
  version: number; // 1-based: file 001 = version 1
  filename: string;
  sqlPath: string;
}

/**
 * Ordered list of known migrations.
 * Add new entries here when adding migration files.
 */
const KNOWN_MIGRATIONS: Migration[] = [
  {
    version: 1,
    filename: "001-initial.sql",
    sqlPath: join(MIGRATIONS_DIR, "001-initial.sql"),
  },
  {
    version: 2,
    filename: "002-add-session-cwd.sql",
    sqlPath: join(MIGRATIONS_DIR, "002-add-session-cwd.sql"),
  },
];

/**
 * Apply any pending schema migrations to the given database.
 *
 * Safe to call on every startup — is a no-op when already up to date.
 *
 * @param db  Open, writable bun:sqlite Database instance.
 * @returns   Number of migrations applied.
 */
export function runMigrations(db: Database): number {
  const current = getCurrentVersion(db);
  const pending = KNOWN_MIGRATIONS.filter((m) => m.version > current);

  for (const migration of pending) {
    applyMigration(db, migration);
  }

  return pending.length;
}

/** Read PRAGMA user_version from the database. */
export function getCurrentVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>(
    "PRAGMA user_version"
  ).get();
  return row?.user_version ?? 0;
}

/** Apply a single migration file inside a transaction. */
function applyMigration(db: Database, migration: Migration): void {
  const sql = readFileSync(migration.sqlPath, "utf-8");

  // Run DDL + version bump atomically
  db.transaction(() => {
    db.exec(sql);
    // PRAGMA cannot be parameterised — version is a trusted integer constant
    db.exec(`PRAGMA user_version = ${migration.version};`);
  })();
}

/**
 * Return the latest known migration version number.
 * Useful for assertions in tests.
 */
export function latestVersion(): number {
  const last = KNOWN_MIGRATIONS[KNOWN_MIGRATIONS.length - 1];
  return last?.version ?? 0;
}
