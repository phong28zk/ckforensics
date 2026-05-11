-- ckforensics SQLite schema v1
-- Applied by migration-runner.ts via PRAGMA user_version.
-- All tables use TEXT for UUIDs/IDs; timestamps stored as ISO-8601 TEXT.

-- ── Sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,  -- session UUID from JSONL
  project_slug TEXT    NOT NULL,     -- derived from parent folder name
  started_at   TEXT,                 -- ISO-8601 of earliest event timestamp
  ended_at     TEXT,                 -- ISO-8601 of latest event timestamp
  model        TEXT,                 -- e.g. "claude-opus-4-6"
  version      TEXT,                 -- Claude Code CLI version
  total_events INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_started
  ON sessions (project_slug, started_at);

-- ── Events ────────────────────────────────────────────────────────────────────
-- event_id is deterministic: first 16 hex chars of SHA-256(timestamp||raw_json)
CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT NOT NULL,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,   -- "assistant" | "user" | "system" | ...
  timestamp   TEXT,            -- ISO-8601 from raw event; NULL if absent
  raw_json    TEXT NOT NULL,   -- original serialised JSON line
  PRIMARY KEY (session_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp
  ON events (timestamp);

CREATE INDEX IF NOT EXISTS idx_events_session_timestamp
  ON events (session_id, timestamp);

-- ── Tool calls ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_calls (
  id             TEXT PRIMARY KEY,  -- tool_use block id from message content
  event_id       TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  input_summary  TEXT,              -- first 256 chars of JSON-stringified input
  duration_ms    INTEGER,           -- filled in post-hoc if available
  output_size    INTEGER,           -- byte length of tool result if matched
  FOREIGN KEY (session_id, event_id) REFERENCES events(session_id, event_id) ON DELETE CASCADE
);

-- ── Token usage ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_usage (
  event_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  input         INTEGER NOT NULL DEFAULT 0,
  output        INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_create  INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL,               -- computed by ingest layer if pricing known
  PRIMARY KEY (session_id, event_id),
  FOREIGN KEY (session_id, event_id) REFERENCES events(session_id, event_id) ON DELETE CASCADE
);

-- ── Files touched ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files_touched (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  path          TEXT NOT NULL,
  action        TEXT,               -- "edit" | "create" | "delete" | "read"
  lines_added   INTEGER,
  lines_removed INTEGER,
  FOREIGN KEY (session_id, event_id) REFERENCES events(session_id, event_id) ON DELETE CASCADE
);

-- ── Ingest state ──────────────────────────────────────────────────────────────
-- Tracks the last byte offset ingested per JSONL file for incremental resumes.
CREATE TABLE IF NOT EXISTS ingest_state (
  file_path        TEXT PRIMARY KEY,
  last_offset      INTEGER NOT NULL DEFAULT 0,  -- byte offset after last ingested line
  last_ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ── Schema version (single-row sentinel) ──────────────────────────────────────
-- PRAGMA user_version is the canonical version; this table is informational only.
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  description TEXT
);
