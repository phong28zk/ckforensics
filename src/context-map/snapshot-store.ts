/**
 * Snapshot store: persist and load ContextSnapshots in the SQLite DB.
 *
 * All snapshots inherit 0600 file permissions from db.ts WAL setup.
 * Items are stored as JSON in items_json; pinned IDs in pinned_json.
 */

import type { Database } from "bun:sqlite";
import type {
  ContextSnapshot,
  SnapshotMetadata,
  ContextItem,
} from "./types.ts";
import { hashItemId } from "./item-id-hasher.ts";

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  session_id: string;
  name: string | null;
  created_at: string;
  total_tokens: number;
  items_json: string;
  pinned_json: string | null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist a ContextSnapshot to the database.
 *
 * If a snapshot with the same id already exists it is replaced (upsert).
 * Returns the snapshot id.
 */
export function saveSnapshot(
  db: Database,
  snapshot: ContextSnapshot,
  name?: string
): string {
  const effectiveName = name ?? snapshot.name ?? null;
  db.run(
    `INSERT OR REPLACE INTO context_snapshots
       (id, session_id, name, created_at, total_tokens, items_json, pinned_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.sessionId,
      effectiveName,
      snapshot.createdAt,
      snapshot.totalTokens,
      JSON.stringify(snapshot.items),
      snapshot.pinnedIds.length > 0
        ? JSON.stringify(snapshot.pinnedIds)
        : null,
    ]
  );
  return snapshot.id;
}

/**
 * Load a single snapshot by id.
 *
 * @throws Error if not found.
 */
export function loadSnapshot(db: Database, id: string): ContextSnapshot {
  const row = db
    .query<SnapshotRow, [string]>(
      `SELECT id, session_id, name, created_at, total_tokens, items_json, pinned_json
       FROM context_snapshots WHERE id = ?`
    )
    .get(id);

  if (!row) throw new Error(`Snapshot not found: ${id}`);
  return hydrateRow(row);
}

/**
 * List snapshot metadata, optionally filtered by sessionId.
 * Ordered by created_at DESC.
 */
export function listSnapshots(
  db: Database,
  sessionId?: string
): SnapshotMetadata[] {
  let rows: SnapshotRow[];
  if (sessionId) {
    rows = db
      .query<SnapshotRow, [string]>(
        `SELECT id, session_id, name, created_at, total_tokens, items_json, pinned_json
         FROM context_snapshots
         WHERE session_id = ?
         ORDER BY created_at DESC`
      )
      .all(sessionId);
  } else {
    rows = db
      .query<SnapshotRow, []>(
        `SELECT id, session_id, name, created_at, total_tokens, items_json, pinned_json
         FROM context_snapshots
         ORDER BY created_at DESC`
      )
      .all();
  }

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    name: r.name ?? undefined,
    createdAt: r.created_at,
    totalTokens: r.total_tokens,
    itemCount: countItems(r.items_json),
  }));
}

/**
 * Delete a snapshot by id. No-op if not found.
 */
export function deleteSnapshot(db: Database, id: string): void {
  db.run(`DELETE FROM context_snapshots WHERE id = ?`, [id]);
}

/**
 * Update the pinned item IDs for an existing snapshot.
 */
export function updatePinnedIds(
  db: Database,
  snapshotId: string,
  pinnedIds: string[]
): void {
  db.run(
    `UPDATE context_snapshots SET pinned_json = ? WHERE id = ?`,
    [pinnedIds.length > 0 ? JSON.stringify(pinnedIds) : null, snapshotId]
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hydrateRow(row: SnapshotRow): ContextSnapshot {
  let items: ContextItem[] = [];
  try {
    items = JSON.parse(row.items_json) as ContextItem[];
  } catch {
    items = [];
  }

  let pinnedIds: string[] = [];
  if (row.pinned_json) {
    try {
      pinnedIds = JSON.parse(row.pinned_json) as string[];
    } catch {
      pinnedIds = [];
    }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name ?? undefined,
    createdAt: row.created_at,
    totalTokens: row.total_tokens,
    items,
    pinnedIds,
  };
}

function countItems(itemsJson: string): number {
  try {
    const arr = JSON.parse(itemsJson);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}
