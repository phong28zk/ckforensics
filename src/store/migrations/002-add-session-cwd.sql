-- Migration 002: add `cwd` to sessions for true project basename display.
--
-- Slug-based heuristic loses information ("project-noname" looks like two
-- separate tokens after `/`→`-` substitution). Storing the original cwd from
-- the first event lets the CLI render basename(cwd) accurately.
--
-- Backfill is best-effort on existing rows (left NULL); next ingest pass picks
-- it up from the source jsonl.

ALTER TABLE sessions ADD COLUMN cwd TEXT;
