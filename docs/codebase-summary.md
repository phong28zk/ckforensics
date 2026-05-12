# Codebase Summary

Module-by-module map of `src/`. Pairs with `architecture.md` (data flow) and `jsonl-schema-v1.md` (event format).

## src/parsers — JSONL ingest layer

Stream Claude Code transcripts into typed events.

| File | Role |
|------|------|
| `jsonl-reader.ts` | Streaming line reader, byte-offset tracking for incremental ingest |
| `schema-detector.ts` | Heuristic dispatcher → picks `schema-vN` reducer |
| `schema-v1.ts` | v1 reducer: line → typed `Event` union |
| `event-classifier.ts` | Bucket events: user / assistant / tool_use / tool_result / system |
| `event-classifier-helpers.ts` | Tool-name extraction, content-type sniffers |
| `event-content-types.ts`, `event-types.ts` | Discriminated union types |
| `__fixtures__/` | Sample JSONL per schema version |

## src/store — SQLite layer

Persistence + idempotent incremental ingest.

| File | Role |
|------|------|
| `db.ts` | Connection, PRAGMAs, migration runner entry |
| `schema.sql` | Base schema (sessions, events, tool_calls, token_usage, files_touched) |
| `migrations/` | Numbered SQL migrations (001+) |
| `migration-runner.ts` | Apply pending migrations, track `user_version` |
| `ingest.ts` | Top-level orchestrator |
| `ingest-file-reader.ts` | Resume from last offset |
| `ingest-state-tracker.ts` | Persist `ingest_state(file_path, last_offset)` |
| `ingest-derived-rows.ts` | Project events → tool_calls + token_usage rows |
| `ingest-files-touched.ts` | Extract file mutations from Edit/Write/MultiEdit |
| `ingest-stmts.ts` | Prepared statements |
| `event-id-hasher.ts` | Stable hash for dedup |
| `discovery.ts` | Walk `~/.claude/projects/**/*.jsonl` |
| `path-resolver.ts` | XDG-compliant DB path per OS |

## src/audit — Session change manifest

Per-session diff + reasoning correlation + recursive subagent cost tree.

| File | Role |
|------|------|
| `session-loader.ts` | Hydrate full session from DB |
| `change-aggregator.ts` | Coalesce per-file edit chronology |
| `diff-formatter.ts` | Unified diff rendering |
| `reasoning-correlator.ts` | Pair assistant reasoning to subsequent tool calls |
| `subagent-tracker.ts` | Detect Agent()/Task() nesting from event tree |
| `subagent-cost.ts` | Recursive token + USD sum per subagent node |
| `manifest-builder.ts` | Assemble final manifest object |
| `manifest-markdown-exporter.ts` | Render to markdown |
| `manifest-types.ts` | Shared types |

## src/context-map — Context-window heatmap (v0.2)

| File | Role |
|------|------|
| `token-attribution.ts` | Per-item token estimate (±20% margin documented) |
| `context-snapshot-builder.ts` | Snapshot context state at a turn |
| `compaction-simulator.ts` | Predict which items survive next auto-compact |
| `snapshot-store.ts` | Persist snapshots to DB (migration 004) |
| `snapshot-differ.ts` | Diff two snapshots |
| `manifest-emitter.ts` | `--pin --emit-manifest` keep-list output |
| `item-id-hasher.ts` | Stable IDs for context items |

## src/recommender — Skill / process / prompt suggestions (v0.2)

| File | Role |
|------|------|
| `pattern-detector.ts` | 5 patterns: read-fanout, test-loop, manual-diff-cycle, grep-walk, subagent-skip |
| `pattern-detector-helpers.ts`, `pattern-detector-types.ts` | Predicates + types |
| `skill-catalog-indexer.ts` | Index `~/.claude/skills/**/SKILL.md` frontmatter |
| `pattern-skill-matcher.ts` | Match patterns → skill recs + session-level prompt advice |
| `pattern-skill-scorer.ts` | Confidence scoring (keyword + intent) |
| `process-advice-bank.ts` | Static process/prompt advice for non-ClaudeKit users |
| `session-signals.ts` | Per-session aggregates (duration, cache-read, Bash density) |
| `savings-estimator.ts` | Project token + USD savings |
| `skill-usage-tracker.ts` | Detect `<command-name>ck:foo</command-name>` activations |
| `effectiveness-analyzer.ts` | Compare tool-call deltas: used vs unused recs |
| `dismissed-recs-store.ts` | Persist user dismissals at `~/.config/ckforensics/dismissed.json` |
| `types.ts` | Discriminated union: SkillRec \| ProcessRec \| PromptRec |

## src/review — Post-session hunk review (v0.3)

Walk Claude's edits hunk-by-hunk; accept/reject each. Interactive TUI, markdown round-trip, or batch.

| File | Role |
|------|------|
| `hunk-builder.ts` | EditOp → Hunk; MultiEdit explodes |
| `hunk-types.ts` | Hunk model: reviewable flags, revertKind |
| `hydrate-before.ts` | Reconstruct `unknownBefore` from git HEAD or chained `after` |
| `diff-builder.ts` | Unified diff (validated by real `git apply --check`) |
| `line-ending-helper.ts` | LF vs CRLF detection for cross-platform safety |
| `encoding-helper.ts` | BOM sniff; refuses UTF-16/32 (bypasses `--allow-dirty`) |
| `safety-check.ts` | Refuse revert on dirty working tree; sha1 drift check in non-git mode |
| `revert-engine.ts` | Newest-first apply via `git apply --reverse`, fallback to file rewrite. Atomic temp+rename |
| `git-helper.ts` | Porcelain checks, `git show HEAD:` reads |
| `markdown-emitter.ts` / `markdown-parser.ts` | HTML-comment sentinel round-trip |
| `tui-launcher.ts` | Lazy-load Ink TUI |
| `tui/` | Ink/React components |

## src/privacy — Redaction

| File | Role |
|------|------|
| `redaction-rules.ts` | 9 rules: API keys, GH/AWS tokens, JWT, high-entropy strings, etc. |
| `redactor.ts` | Stream redact; applied before any markdown/CSV export |

## src/cli — Commander surface

| Path | Role |
|------|------|
| `index.ts` | Commander root, version, global flags (`-v`, `--debug`) |
| `color.ts`, `output-formatter.ts` | ANSI + table rendering, ANSI-aware padding |
| `commands/` | One file per subcommand (ingest, summary, sessions, audit, map, suggest, skills, cache, review, export, redact, doctor, path) |
| `queries/` | Read-only SQL: summary-query, sessions-query, cache-query |
| `exporters/` | Markdown / JSON / CSV writers |

## src/lib — Cross-cutting

| File | Role |
|------|------|
| `logger.ts` | Level-gated (error/info/debug), daily file rotation |
| `log-path-resolver.ts` | Per-OS XDG log dir |
| `model-pricing.ts` | Version-aware (Opus 4.5+ vs 4.0/4.1 differ); covers Sonnet, Haiku variants |

## Tests

Co-located in `__tests__/` per module. 366 pass as of v0.3.3. Real DB, real git, real fixture JSONL — no mocks.
