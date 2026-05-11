# ck:forensics — Command Reference

Quick reference for every `ckforensics` subcommand exposed via `/ck:forensics`.

## Global flags

| Flag | Default | Description |
|------|---------|-------------|
| `--db <path>` | XDG data dir | Override SQLite path |
| `--no-color` | off | Disable ANSI |
| `-v, --verbose` | off | Info-level logging to stderr |
| `--debug` | off | Debug-level logging |
| `--log-dir <path>` | XDG state dir | Override log dir |
| `--json` | off | Force JSON output globally |

## Subcommands

### `summary [--days N] [--format text|md|json]`

Aggregate token/cost/files across a rolling window.

**Output fields:**
- `sessionCount`
- `totalInputTokens`, `totalOutputTokens`, `totalCacheRead`, `totalCacheCreate`
- `estimatedCostUsd` (API-rate equivalent)
- `filesTouched`, `editOps`
- `oldestSession`, `newestSession`

### `sessions [--project SLUG] [--limit N] [--format text|md|csv|json]`

List recent sessions ordered by `started_at DESC`.

**Columns:** ID, Project, Started, Model, Events, Cost, Duration

Cost color-coded: red >$10, yellow $1-10, green <$1, dim — for null.

### `audit [<session-id>|--last] [--out FILE] [--format md|json]`

Per-session change manifest.

**Sections:**
1. Header (session ID, project, model, duration, cost, total events)
2. Summary (files changed, lines +/-, edit ops, tokens, cache read)
3. File Changes (chronological edits, reasoning quotes, unified diff)
4. Subagent Dispatches (each Agent() / Task() with input + duration)
5. Subagent Cost Breakdown (nested table with tokens + cost per agent)

Exit codes: 0 success, 3 session not found.

### `map [<session-id>|--last] [--top N=20] [--simulate-compact] [--target-pct N=50]`

Context window heatmap by category.

**Categories:** `tool:<Name>`, `assistant`, `user`, `system_prompt`, `memory`, `skill_load`, `unknown`

Each row: ASCII bar + percentage + token count + item count.

**`--simulate-compact`:** projects which items survive next auto-compact based on documented heuristic.

**Sub-commands:**
- `ckforensics map --save NAME` — persist snapshot
- `ckforensics map list` — list saved snapshots
- `ckforensics map diff <A> <B>` — token movement between snapshots
- `ckforensics map --pin ITEM_ID --emit-manifest [FILE]` — pinned items → paste-ready markdown

### `suggest [<session-id>|--last|--days N=7] [--min-confidence N=70] [--top N=3] [--format text|md|json]`

Detect repeated tool patterns and recommend skills.

**Patterns detected:**
- `read-fanout`: ≥5 Reads within 3 adjacent turns on same dir
- `test-loop`: ≥3 Bash test runs
- `manual-diff-cycle`: read→edit→read ≥2 cycles
- `grep-walk`: ≥4 Grep+Read pairs
- `subagent-skip`: ≥20 main-thread tool calls, no Agent/Task

**Output per rec:** invocation hint (`/ck:scout`), confidence %, est savings (tokens + USD), evidence turns.

### `skills [--unused|--used] [--search QUERY] [--refresh] [--format text|md|csv|json]`

List indexed skills from `~/.claude/skills/`.

- `--refresh` — re-scan SKILL.md frontmatter
- `--unused` — show skills you've never invoked
- `--used` — show skills you've activated, with usage count
- `--search "pattern"` — keyword search

### `ingest [--watch]`

Parse `~/.claude/projects/**/*.jsonl` → SQLite. Idempotent + incremental.

- `--watch` polls every 5s (for cron alternative)

### `redact <file> [--in-place] [--force]`

Apply 9 redaction rules (sk-ant, GH tokens, AWS, JWT, etc.) to a markdown/text file. Use before sharing audit exports.

### `export <view> --format md|json|csv [--out FILE]`

Pipe-friendly export: `summary`, `sessions`, `audit`.

### `doctor`

Health check: DB exists + version, JSONL dir readable, last ingest mtime, log dir writeable, Bun version.

### `path`

Print resolved paths (DB, data dir, JSONL source, log dir, config dir).
