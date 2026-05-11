-- Migration 004: context snapshots for ckforensics map command
-- Stores serialised context item snapshots per session.
-- Applied when PRAGMA user_version = 3.
-- After applying, runner sets PRAGMA user_version = 4.

CREATE TABLE IF NOT EXISTS context_snapshots (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL,
  name        TEXT,                  -- user-given snapshot name (optional)
  created_at  TEXT    NOT NULL,
  total_tokens INTEGER,
  items_json  TEXT    NOT NULL,      -- serialised ContextItem array
  pinned_json TEXT,                  -- serialised pinned item IDs (default empty)
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_session
  ON context_snapshots (session_id);
