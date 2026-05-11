-- Migration 003: skill catalog + skill usage tracking
-- Enables the skill recommender feature (Phase 09).
-- Applied when PRAGMA user_version = 2.
-- After applying, runner sets PRAGMA user_version = 3.

CREATE TABLE IF NOT EXISTS skill_catalog (
  name        TEXT    PRIMARY KEY,
  description TEXT,
  keywords    TEXT,          -- JSON array of strings
  path        TEXT NOT NULL,
  mtime       INTEGER        -- unix epoch ms for cache invalidation
);

CREATE TABLE IF NOT EXISTS skill_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  skill_name  TEXT NOT NULL,
  activated_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_skill_usage_session
  ON skill_usage (session_id);

CREATE INDEX IF NOT EXISTS idx_skill_usage_skill
  ON skill_usage (skill_name);
