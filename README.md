# ckforensics

**Forensic CLI for Claude Code sessions — audit, redact, export your transcripts.**

[![CI](https://github.com/phong28zk/ckforensics/actions/workflows/ci.yml/badge.svg)](https://github.com/phong28zk/ckforensics/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ckforensics)](https://www.npmjs.com/package/ckforensics)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6)](https://bun.sh)

---

## Why ckforensics

**Pain:**
- Claude Code transcripts stored as raw JSONL — no way to summarize or audit them
- Sensitive keys / tokens leak into `.jsonl` files that get committed or shared
- No visibility into token usage, tool calls, or subagent orchestration patterns

**Solution:**
- Ingest all sessions into a local SQLite DB — queryable, indexed, stays on disk
- Redact 9 secret patterns (API keys, AWS creds, JWTs, PEM blocks) before any export
- CLI commands for summary, audit, session diff, and export — no cloud, no telemetry

---

## Install

```bash
npm i -g ckforensics
```

Or download a prebuilt binary from [Releases](https://github.com/phong28zk/ckforensics/releases):

```bash
# Linux x64
curl -L https://github.com/phong28zk/ckforensics/releases/latest/download/ckforensics-linux-x64 \
  -o /usr/local/bin/ckforensics && chmod +x /usr/local/bin/ckforensics
```

Platforms: `linux-x64`, `linux-arm64`, `macos-arm64` (Apple Silicon), `windows-x64`

> Intel Mac users: build from source — `bun build --compile --target=bun-darwin-x64 src/cli/index.ts --outfile ckforensics`

---

## Quick Start

```bash
# 1. Ingest all sessions from ~/.claude/projects/
ckforensics ingest

# 2. Summarize recent sessions (default 7 days)
ckforensics summary
ckforensics summary --days 1          # today
ckforensics summary --days 30         # month

# 3. List recent sessions
ckforensics sessions --limit 10

# 4. Audit the most recent session (markdown manifest)
ckforensics audit --last
ckforensics audit <session-id> --out review.md

# 5. Redact secrets from a file before sharing
ckforensics redact review.md --in-place

# 6. Export for scripting
ckforensics export summary --format json | jq
ckforensics export sessions --format csv --out sessions.csv

# 7. Health check
ckforensics doctor
```

> DB stored at XDG-compliant path (mode `0600`):
> - Linux: `~/.local/share/ckforensics/store.db`
> - macOS: `~/Library/Application Support/ckforensics/store.db`
> - Windows: `%APPDATA%\ckforensics\store.db`
>
> Nothing leaves your machine. Run `ckforensics path` to see resolved paths.

### About cost numbers

Cost shown is **API-rate equivalent** computed from token counts × Anthropic published prices ([Nov 2025 snapshot](https://platform.claude.com/docs/en/about-claude/pricing)).

- **API users:** approximates your actual bill (±10-30% for cache-pricing edge cases)
- **Subscription users (Pro / Max / Team):** flat plan fee covers this; treat the number as **"value extracted"** from your subscription

Example: a 14h Opus 4.7 session showing `$166` means you'd pay ~$166 at API rates — your $100/mo Max plan covers it with positive ROI.

---

## Screenshots

```
[ terminal recording placeholder — see docs/demo.gif once available ]
```

---

## Feature Matrix

| Feature | ckforensics | ccusage | Native CC |
|---------|:-----------:|:-------:|:---------:|
| Local SQLite storage | ✅ | ✅ | ❌ |
| Version-aware cost pricing | ✅ | 🟡 | ✅ (live only) |
| Token usage analytics | ✅ | ✅ | ❌ |
| Secret redaction (9 rules) | ✅ | ❌ | ❌ |
| Session change manifest (diff + reasoning) | ✅ | ❌ | ❌ |
| Subagent attribution | ✅ | ❌ | ❌ |
| Markdown / JSON / CSV export | ✅ | ❌ | ❌ |
| Offline / no telemetry | ✅ | ✅ | ✅ |
| Cross-platform binaries | ✅ | ❌ | ✅ |

---

## Commands

| Command | Description |
|---------|-------------|
| `ingest` | Parse JSONL files → SQLite |
| `summary` | Token + cost summary for a time range |
| `audit` | Detect secrets / anomalies in a session |
| `export` | Output session as Markdown or JSON |
| `redact` | Strip secrets from JSONL in-place |
| `sessions` | List sessions with metadata |
| `path` | Show DB path and stats |
| `doctor` | Verify DB integrity and schema version |

---

## Architecture

See [docs/architecture.md](docs/architecture.md) — module overview and data-flow diagram.

## Threat Model

See [docs/threat-model.md](docs/threat-model.md) — privacy stance, redaction guarantees, and known gaps.

## Schema

See [docs/jsonl-schema-v1.md](docs/jsonl-schema-v1.md) — reverse-engineered Claude Code JSONL event types.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, PR checklist, fixture contribution flow.

---

## License

MIT — [LICENSE](LICENSE) — Copyright (c) 2026 phong28zk
