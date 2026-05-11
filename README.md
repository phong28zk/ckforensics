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

Platforms: `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `windows-x64`

---

## Quick Start

```bash
# 1. Ingest all sessions from default Claude Code path
ckforensics ingest

# 2. Summarize recent sessions
ckforensics summary --last 7d

# 3. Audit a session for leaked secrets
ckforensics audit --session <session-id>

# 4. Redact and export a session as Markdown
ckforensics export --session <session-id> --format markdown --redact

# 5. Health check (verify DB integrity + schema version)
ckforensics doctor
```

> Sessions are stored in `~/.ckforensics/db.sqlite` (mode `0600`). Nothing leaves your machine.

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
| Token usage analytics | ✅ | ✅ | ❌ |
| Secret redaction (9 rules) | ✅ | ❌ | ❌ |
| Session audit trail | ✅ | ❌ | ❌ |
| Subagent tracking | ✅ | ❌ | ❌ |
| Markdown / JSON export | ✅ | ❌ | ❌ |
| Diff between sessions | ✅ | ❌ | ❌ |
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
