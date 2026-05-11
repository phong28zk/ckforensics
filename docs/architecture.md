# Architecture

## Overview

ckforensics is a **read-only, local-first** CLI tool. Pipeline:

```
~/.claude/projects/**/*.jsonl
        │
        ▼
   parsers/        streaming line reader → typed Event union → schema reducer
        │
        ▼
   store/          SQLite (bun:sqlite), WAL, idempotent batched ingest
        │
        ├──────► cli/queries/     summary, sessions
        │
        └──────► audit/           load session → aggregate changes → correlate
                                   reasoning → track subagents → diff → manifest
                                                  │
                                                  ▼
                                          cli/exporters/    md / json / csv
                                                  │
                                                  ▼
                                          privacy/redactor  apply rules before write
```

## Modules

| Module | Role | Key files |
|--------|------|-----------|
| `parsers/` | Stream + classify JSONL events | `jsonl-reader.ts`, `event-classifier.ts`, `schema-v1.ts` |
| `store/` | SQLite schema + ingest pipeline | `db.ts`, `ingest.ts`, `discovery.ts`, `path-resolver.ts` |
| `audit/` | Session change manifest | `manifest-builder.ts`, `change-aggregator.ts`, `reasoning-correlator.ts`, `subagent-tracker.ts`, `diff-formatter.ts` |
| `cli/` | Commander root + subcommands | `index.ts`, `commands/*`, `queries/*`, `exporters/*` |
| `privacy/` | Redaction rules + stream | `redaction-rules.ts`, `redactor.ts` |

## Data model (SQLite)

```
sessions      (id PK, project_slug, started_at, ended_at, model, ...)
events        (id, session_id FK, type, timestamp, raw_json) — PK (session_id, id)
tool_calls    (id, event_id FK, tool_name, input_summary, duration_ms, output_size)
token_usage   (event_id FK, input, output, cache_read, cache_create, cost_usd)
files_touched (event_id FK, path, action, lines_added, lines_removed)
ingest_state  (file_path PK, last_offset, last_ingested_at)
schema_version (via PRAGMA user_version)
```

Indexes: `events(timestamp)`, `events(session_id, timestamp)`, `sessions(project_slug, started_at)`.

## Why these choices

- **Bun + `bun:sqlite`**: zero native deps, single-binary `bun build --compile`, eliminates per-platform native rebuild pain.
- **SQLite over flat files**: queryable, indexed, incremental ingest, survives restart.
- **Schema-versioned reducer**: Claude Code JSONL format can drift; reducer per version + `UnknownEvent` bucket = graceful degradation.
- **Read-only stance**: no risk of corrupting user state. CC owns the data; we observe.
- **No telemetry**: privacy-first; users review redaction before any export.

## Phase plans

Full implementation phases live in the development plan dir (not shipped with binary):
- Phase 00 — Competitive research, naming
- Phase 01 — JSONL parser
- Phase 02 — SQLite store + ingest
- Phase 04 — Audit manifest
- Phase 05 — CLI surface + privacy
- Phase 06 — Cross-platform build + release
- Phase 07 — Context Map (v0.2)
- Phase 09 — Skill Recommender (v0.2)
- Phase 10 — Community infrastructure

## Adding a new schema version

1. Capture sample lines exhibiting new shape into `src/parsers/__fixtures__/sample-vN.jsonl`
2. Add detector heuristic in `schema-detector.ts`
3. Implement `schema-vN.ts` reducer alongside `schema-v1.ts`
4. Update `event-classifier.ts` switch if new event types
5. Add tests in `parsers/__tests__/`
