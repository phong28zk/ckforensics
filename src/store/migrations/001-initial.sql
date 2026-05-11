-- Migration 001: initial schema
-- Applied when PRAGMA user_version = 0 (fresh database).
-- After applying, runner sets PRAGMA user_version = 1.

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  project_slug TEXT    NOT NULL,
  started_at   TEXT,
  ended_at     TEXT,
  model        TEXT,
  version      TEXT,
  total_events INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_started
  ON sessions (project_slug, started_at);

CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT NOT NULL,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  timestamp   TEXT,
  raw_json    TEXT NOT NULL,
  PRIMARY KEY (session_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp
  ON events (timestamp);

CREATE INDEX IF NOT EXISTS idx_events_session_timestamp
  ON events (session_id, timestamp);

CREATE TABLE IF NOT EXISTS tool_calls (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  input_summary  TEXT,
  duration_ms    INTEGER,
  output_size    INTEGER,
  FOREIGN KEY (session_id, event_id) REFERENCES events(session_id, event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS token_usage (
  event_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  input         INTEGER NOT NULL DEFAULT 0,
  output        INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_create  INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL,
  PRIMARY KEY (session_id, event_id),
  FOREIGN KEY (session_id, event_id) REFERENCES events(session_id, event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files_touched (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  path          TEXT NOT NULL,
  action        TEXT,
  lines_added   INTEGER,
  lines_removed INTEGER,
  FOREIGN KEY (session_id, event_id) REFERENCES events(session_id, event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingest_state (
  file_path        TEXT PRIMARY KEY,
  last_offset      INTEGER NOT NULL DEFAULT 0,
  last_ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  description TEXT
);

INSERT OR IGNORE INTO schema_version (version, description)
  VALUES (1, 'initial schema: sessions, events, tool_calls, token_usage, files_touched, ingest_state');
