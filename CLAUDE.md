# CLAUDE.md

Guidance for Claude Code working in the **ckforensics** repo.

## What this is

Forensic CLI for Claude Code sessions. Parses `~/.claude/projects/**/*.jsonl` into SQLite, then provides audit / cost / context-map / skill-recommendation / hunk-review commands. Ships as a single npm package that also installs a `/ck:forensics` ClaudeKit skill.

- Read-only, local-first, no telemetry
- Runtime: **Bun** (compiled to single binary per OS)
- Distribution: npm wrapper downloads platform binary via postinstall

## Stack

- **Runtime:** Bun ≥ 1.1 (`bun:sqlite`, no native node deps)
- **Language:** TypeScript (`tsc --noEmit` for typecheck only — Bun runs `.ts` directly)
- **CLI:** Commander
- **TUI (review command):** Ink + React (lazy-loaded)
- **DB:** SQLite (WAL, migrations under `src/store/migrations/`)
- **Tests:** `bun test`

## Commands

```bash
bun run src/cli/index.ts <subcommand>   # dev
bun test                                 # 353 tests
bun run typecheck                        # tsc --noEmit
./scripts/build-all.sh                   # cross-platform binaries
```

## Source layout (200-line modularization rule)

```
src/
├── parsers/        JSONL stream → typed events (schema-versioned reducer)
├── store/          SQLite + migrations + idempotent incremental ingest
├── audit/          Session manifest: diffs + reasoning + subagent cost tree
├── context-map/    Heatmap, compaction simulator, snapshot diff/pin
├── recommender/    Pattern detection → skill/process/prompt recommendations
├── review/         Post-session hunk-by-hunk review (v0.3+): revert engine, TUI
├── privacy/        9 redaction rules, applied before any export
├── cli/            Commander root, commands/, queries/, exporters/
└── lib/            logger, log-path-resolver, model-pricing
```

## Conventions

- **File names:** kebab-case, long + descriptive (LLM-readable via Grep/Glob)
- **File size:** keep under 200 lines; split by concern when growing
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). No AI references.
- **Versioning:** Semver. Bump in `package.json` AND `src/cli/index.ts`. Update `CHANGELOG.md` (Keep a Changelog format).
- **No telemetry / no network calls** outside postinstall binary download.
- **DB file perms `0600`** on Unix; never log secrets.

## Storage paths (XDG-compliant)

| OS      | DB                                                  | Logs                                  |
|---------|-----------------------------------------------------|---------------------------------------|
| Linux   | `~/.local/share/ckforensics/store.db`              | `~/.local/state/ckforensics/logs/`    |
| macOS   | `~/Library/Application Support/ckforensics/store.db` | `~/Library/Logs/ckforensics/`       |
| Windows | `%APPDATA%\ckforensics\store.db`                    | `%LOCALAPPDATA%\ckforensics\Logs\`    |

`ckforensics path` resolves all paths at runtime.

## Output schemas

JSON outputs carry `$schema` envelope:
- `ckforensics-suggest-v2` (suggest)
- `ckforensics-cache-v1` (cache)
- audit / map use markdown by default; `--json` available

## Testing rules

- No mocks for DB — use real `bun:sqlite` in tests
- Real `git apply --check` validation in `review/` tests (no synthetic diffs)
- Fixture JSONL lives under `src/parsers/__fixtures__/`
- 353 tests currently pass; do not regress

## Releases

- Tag `v*.*.*` → GitHub Actions builds binaries + publishes to npm via `NPM_TOKEN`
- Skill bundle ships at `.claude/skills/ckforensics/`; copied to `~/.claude/skills/` by postinstall
- Opt out: `CKFORENSICS_SKIP_SKILL_INSTALL=1`

## Common pitfalls

- Commander short flags must be 1 char (`-vv` is invalid → use `--debug`)
- Opus 4.5+ pricing differs from Opus 4.0/4.1 — use version-aware `getModelPricing()`
- `bun build --compile --target=bun-darwin-x64` for Intel Mac (no prebuilt)
- Review revert engine on Windows/CRLF files: `detectLineEnding()` must run before `buildUnifiedDiff`; UTF-16/32 files are refused (bypass `--allow-dirty`)

## Pointers

- `README.md` — user-facing overview, install, command list
- `ROADMAP.md` — v0.1 → v0.6 plans
- `CHANGELOG.md` — version history
- `docs/architecture.md` — module data flow
- `docs/jsonl-schema-v1.md` — reverse-engineered Claude Code JSONL format
- `docs/threat-model.md` — privacy stance, redaction guarantees
- `docs/codebase-summary.md` — module-by-module navigation
- `CONTRIBUTING.md` — dev setup, PR checklist
