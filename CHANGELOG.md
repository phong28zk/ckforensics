# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
