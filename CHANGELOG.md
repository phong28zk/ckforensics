# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
