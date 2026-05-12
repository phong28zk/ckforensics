# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.3] - 2026-05-12 — TUI polish

### Changed
- **Diff headers in TUI now show short paths** instead of `a//absolute/path` double-slash. Uses cwd-relative when inside, else basename.
- **Header bar gained file-context line:** "File 3/8: src/foo.ts (4 hunks)" — knowing where you are in a 44-hunk session.

### Added
- **Jump-to-file keybindings** in TUI: `f` next file, `F` previous file, `1-9` jump to N-th file's first hunk. Footer + help overlay updated.

## [0.3.2] - 2026-05-12 — Auto-trigger review (hook + watch daemon)

### Added
- **`ckforensics hook install|uninstall|status`** — non-destructively wires a `Stop` hook into `~/.claude/settings.json` so a review markdown is auto-emitted every time a Claude Code session ends. Preserves other user-configured hooks; tagged `managed-by:ckforensics` so re-install is idempotent and uninstall surgical.
  - `--exec '<cmd>'` runs a follow-up command with `{path}` substitution (e.g. `code {path}` to auto-open in VS Code).
  - `--out-path <file>` overrides default `~/.cache/ckforensics/last-review.md`.
- **`ckforensics watch [--idle SECONDS] [--exec CMD]`** — long-running daemon alternative to the Stop hook. Polls `~/.claude/projects/**/*.jsonl`; when the latest session goes idle for the threshold, runs `ingest` + `review --emit` + optional `--exec`. Useful for users who don't want to modify settings.json.
- **README "Post-session review (three UX modes)" section** documenting manual / hook / watch paths with a clear comparison.
- **SKILL.md updated** with `hook` and `watch` subcommand handlers.

### Tests
- 13 new tests covering hook installer purity (idempotent re-install, surgical uninstall, preservation of unrelated hook types, sentinel detection). Total: 366 pass.

## [0.3.1] - 2026-05-12 — Cross-platform review safety

### Added
- **Line-ending preservation** (`src/review/line-ending-helper.ts`): `detectLineEnding()` heuristic over file bytes (LF vs CRLF dominance). `buildUnifiedDiff` accepts a `lineEnding` opt that suffixes payload lines with `\r` so `git apply --reverse` matches Windows-edited / MQL5 / legacy C# files on disk. Headers stay LF.
- **Encoding refusal** (`src/review/encoding-helper.ts`): `detectEncoding()` sniffs BOM. UTF-8 + UTF-8-BOM supported; UTF-16/UTF-32 LE/BE explicitly refused with `refused-encoding` status. **Bypasses `--allow-dirty`** — corruption risk too high to override.
- Tests: 17 new (`line-ending-helper`, `encoding-helper`, CRLF round-trip in `revert-engine`, UTF-16 refusal). Total: 353 pass.

### Changed
- Version bumped to 0.3.1 in `package.json` and `src/cli/index.ts`.
- `SafetyVerdict` gained `unsupported-encoding` variant.
- `RevertStatus` gained `refused-encoding`.

### Coverage
Now safe for: Rust, Go, Python, JS/TS, MQL5 (CRLF + UTF-8), C# (with/without BOM), shell scripts, Lua, Elixir, Java, Kotlin, Swift. Unsafe-by-design: UTF-16/UTF-32 (refused before any modification).

## [0.3.0] - 2026-05-12 — Post-Session Edit Review (Copilot-style)

### Added
- **`ckforensics review` command** — walk through Claude's edits hunk-by-hunk, accept/reject each. Three modes:
  - **Interactive TUI** (ink/React): keybindings `y`/`n`/`s` per-hunk, `A`/`R` approve-all/reject-all, `←/→` nav, `r` reasoning, `q` quit-menu.
  - **Emit markdown:** `--emit FILE` produces a checklist with sentinel anchors; user toggles `[ ] → [x]` in any editor.
  - **Batch apply:** `--batch --decisions FILE` reads the toggled markdown and applies reverts.
- **Revert engine** (`src/review/revert-engine.ts`): sequential newest-first apply via `git apply --reverse`, falls back to direct file rewrite when non-git or git fails. Atomic per-file (temp + rename).
- **Safety check** (`src/review/safety-check.ts`): refuses revert when target file has uncommitted user changes (porcelain check). Non-git mode: sha1 drift detection against last EditOp's `after`. Override with `--allow-dirty`.
- **Hunk model** (`src/review/hunk-types.ts`, `hunk-builder.ts`): one EditOp = one Hunk; MultiEdit explodes; flags `unreviewable` for unknown-before / write-new-file / identical / binary.
- **Diff builder** (`src/review/diff-builder.ts`): produces unified diff parseable by `git apply --check` (validated in tests).
- **Markdown round-trip** (`markdown-emitter.ts`, `markdown-parser.ts`): HTML-comment sentinels resistant to user edits; tolerant parser ignores unknown hunk IDs.
- **Write-new-file as delete-revert** (`revertKind: "delete"`): Reverting a Write hunk that created a new file now removes the file rather than being marked unreviewable. Delete-kind hunks supersede patch hunks against the same file.
- **Unknown-before hydration** (`src/review/hydrate-before.ts`): Hunks that landed with `unknownBefore=true` (Claude didn't `Read` first) are reconstructed from git HEAD (first-in-chain) or chained from preceding hunk's `after` (subsequent hunks). Dogfood test on this session: reviewable rate jumped from 11% to 73%.
- **`/ck:forensics` skill** updated to advertise the `review` subcommand and include workflow examples.

### Changed
- Version bumped to 0.3.0 in `package.json` and `src/cli/index.ts`.
- New runtime deps: `ink`, `react` (lazy-loaded only for interactive TUI).
- ROADMAP labels corrected: Post-Session Edit Review now v0.3.0, Stretch Goals v0.4.0+, VCS Integration v0.5.0, Notifications v0.6.0.

### Tests
- 30 new tests across `hunk-builder`, `diff-builder`, `markdown-roundtrip`, `revert-engine`, `hydrate-before`. Include real `git apply --check` and `git show HEAD:` validation. Total: 336 tests pass.

## [0.2.5] - 2026-05-11

### Added
- **Session-level prompt advice** wired into `suggest` pipeline (v0.2.4 carried over `SESSION_PROMPT_ADVICE` but never invoked it).
  - New `src/recommender/session-signals.ts`: `computeSessionSignals()` queries DB for durationMs, totalCacheReadTokens, maxBashCallsPerTurn, totalToolCalls per session.
  - New `buildSessionRecommendations()` in `pattern-skill-matcher.ts`: evaluates all `SESSION_PROMPT_ADVICE` predicates, emits `PromptRecommendation[]` once per session (not per pattern).
  - Three new advice entries active: "Checkpoint context periodically" (>6h sessions), "Audit memory injections" (>100M cache-read tokens), "Pipe Bash results" (≥5 Bash calls/turn).
- **`ckforensics cache` command** (`src/cli/commands/cache.ts`): surfaces cache hit/miss stats.
  - New `src/cli/queries/cache-query.ts`: `getCacheBreakdown()` with `--days` / `--session` scoping, model-aware savings calculation, per-session breakdown sorted by cache_read DESC.
  - Text output: aggregate header with hit ratio color-coded (green ≥70%, yellow 40-69%, red <40%), top sessions table with savings.
  - `--format md`: markdown table for sharing.
  - `--json`: envelope with `$schema: "ckforensics-cache-v1"`, `generatedAt`, `label`, `data`.
  - Supports `--session ID`, `--last`, `--days N` (default 7).

### Changed
- Version bumped to 0.2.5 in `package.json` and `src/cli/index.ts`.

## [0.2.4] - 2026-05-11

### Added
- Process + prompt advice bank in `suggest` command: recommendations now work for non-ClaudeKit users.
  - New `src/recommender/process-advice-bank.ts`: static curated entries for all 5 pattern types.
  - Each pattern type has process + prompt advice: read-fanout (Glob, repomix, ls-first), test-loop (watch mode, pre-commit hook, narrow scope), manual-diff-cycle (MultiEdit batch, commit-between-iterations), grep-walk (ripgrep one-shot, repomix, knowledge graph), subagent-skip (Task tool, plan-first, pipe-bash).
- New recommendation types: `[Skill]`, `[Process]`, `[Prompt]` — each rendered with distinct color coding (cyan/blue/yellow) and confidence.
- Suggest JSON schema bumped to `ckforensics-suggest-v2` (`$schema`, `generatedAt`, `recommendations[]`).

### Changed
- Default `--top` raised from 3 to 5 so users see a mix of all recommendation types.
- `Recommendation` type is now a discriminated union (`SkillRecommendation | ProcessRecommendation | PromptRecommendation`).
- Suggest text and markdown output headers renamed to "Recommendations" (was "Skill Recommendations").

## [0.2.3] - 2026-05-11

### Changed
- README polish: hero ASCII-box demos (summary, map, suggest, audit), feature matrix vs ccusage + native CC, ClaudeKit integration section, expanded commands table, removed broken screenshot placeholder.
- Added storage path tables for Linux/macOS/Windows.
- Added recommended cron snippet for hourly auto-ingest.

## [0.2.2] - 2026-05-11

### Added
- **\`/ck:forensics\` ClaudeKit skill** bundled into npm package. Installs to \`~/.claude/skills/ckforensics/\` via postinstall.
  - SKILL.md with AskUserQuestion default + 7 subcommand handlers
  - 3 workflow references: EOD review, pre-commit audit, weekly retro
  - Commands + interpretation reference docs
  - \`session-overview.py\` script: unified JSON report from multiple CLI calls (saves Claude 4 Bash invocations per review)
- \`CKFORENSICS_SKIP_SKILL_INSTALL=1\` opt-out env var for skill copy step.

## [0.2.1] - 2026-05-11

### Added
- **Log infrastructure (Phase 11):** XDG-compliant log dir + daily rotation.
  - Linux: \`~/.local/state/ckforensics/logs/\`
  - macOS: \`~/Library/Logs/ckforensics/\`
  - Windows: \`%LOCALAPPDATA%\\ckforensics\\Logs\\\`
  - \`--verbose\` / \`--debug\` gate levels; default = error only.
  - \`ckforensics path\` shows log directory; \`doctor\` checks writeability.
- **Subagent cost forensics:** recursive Agent() / Task() cost breakdown in audit output.
  - \`## Subagent Cost Breakdown\` table with nested hierarchy, token + USD per node.
  - Identifies runaway subagents in long-running sessions.

### Fixed
- Commander option syntax: \`-vv, --debug\` (invalid: short flag > 1 char) -> \`--debug\`.
- log-path-resolver test expected wrong path (missing \`ckforensics/\` segment).

## [0.2.0] - 2026-05-11 — Brilliant Tier Release

### Added
- **Context Map** (\`ckforensics map\`): visualize what eats your context window.
  - Heatmap of context items by category (tool:Read, tool:Edit, assistant, user, ...)
  - \`--simulate-compact\` projects which items survive next auto-compact
  - Snapshot save/load/list/diff for context evolution tracking
  - \`--pin --emit-manifest\` produces paste-ready keep-list for next CC prompt
  - Documented ±20% attribution margin (heuristic, best-effort)
  - Tool-name correlation: tool_result items inherit tool name from paired tool_use
  - Migration 004 adds context_snapshots table

### Notes
- v0.2.0 ships Skill Recommender (0.1.6) + Context Map (0.2.0). Log Infrastructure (P11) deferred to v0.2.1+.

## [0.1.7] - 2026-05-11

### Fixed
- \`suggest\`: double prefix in invocation hints (\`/ck:ck:test\` -> \`/ck:test\`). Strip leading \`ck:\`/\`ckm:\` from skill names before prepending \`/ck:\`.

## [0.1.6] - 2026-05-11

### Added
- **Skill Recommender** (Phase 09 of v0.2): \`ckforensics suggest\` + \`ckforensics skills\`.
  - Pattern detector: read-fanout, test-loop, manual-diff-cycle, grep-walk, subagent-skip
  - Skill catalog indexer reading ~/.claude/skills/**/SKILL.md frontmatter
  - Pattern-to-skill matcher with keyword + intent scoring
  - Savings estimator (tokens + USD via model-pricing)
  - Skill usage tracker detecting \`<command-name>ck:foo</command-name>\` activations
  - Effectiveness analyzer (tool-call deltas for used vs unused)
  - Dismissed recs persistence at ~/.config/ckforensics/dismissed.json
  - Migration 003: skill_catalog + skill_usage tables

## [0.1.5] - 2026-05-11

### Changed
- CI npm publish via NPM_TOKEN secret (granular automation token, bypass-2fa, package-scoped).
- Drop Trusted Publisher / OIDC path — TP returned 404 for packages with prior user-token publishes.

## [0.1.4] - 2026-05-11

### Added
- `cwd` column on sessions (migration 002): true project basename instead of slug heuristic.
- `truncateRight()` + ANSI-aware padding in table renderer.

### Changed
- `sessions` text mode: project basename from cwd, compact model name ("Opus 4.7"), color-tiered cost (red >$10, yellow $1-10, green <$1), tighter columns, footer hint.
- `fmtDuration` compact: "14h36m" instead of "14h 36m".

## [0.1.3] - 2026-05-11

### Changed
- TP retest after switching npm Publishing access to "disallow tokens" mode.

## [0.1.2] - 2026-05-11

### Changed
- Test release for npm Trusted Publisher auto-publish via OIDC.

## [0.1.1] - 2026-05-11

### Fixed
- Cost calculation for Opus 4.5/4.6/4.7 was 3× too high (used legacy Opus 4.0/4.1 rates).
  Updated to Anthropic's Nov 2025 published pricing: Opus 4.5+ at $5/$25 input/output
  (was $15/$75), cache_read $0.50 (was $1.50), cache_write $6.25 (was $18.75).
- Haiku 4.5 pricing was 4× too low (used Haiku 3 rates).
- Added version-aware regex matching in `getModelPricing()` so Opus 4.1 keeps legacy
  rates while 4.5+ uses new rates.

### Added
- `summary` output footnote clarifying cost is API-rate equivalent (subscription users
  see flat fee).
- `src/lib/__tests__/model-pricing.test.ts` covers all model variants.
- README "About cost numbers" section explaining ckforensics vs CC live cost vs
  subscription billing.

## [0.1.0] - TBD

### Added
- JSONL streaming parser with schema-versioned reducer (v1)
- SQLite store with idempotent incremental ingest (~100k lines/sec)
- 8 CLI subcommands: `ingest`, `summary`, `sessions`, `audit`, `export`, `redact`, `doctor`, `path`
- Session change manifest with diff + reasoning correlation + subagent tracking
- Markdown / JSON / CSV exporters
- Built-in redaction (9 rules: API keys, GH tokens, AWS, JWT, high-entropy)
- Cross-platform single-binary distribution (Linux x64/arm64, macOS x64/arm64, Windows x64)
- npm wrapper with platform-detection postinstall
- GitHub Actions tag-driven release workflow
- 133 tests across parser / store / audit / privacy / CLI layers

### Security
- DB file permissions 0600 on Unix
- No network calls outside postinstall binary download
- Redaction applied before any markdown export
