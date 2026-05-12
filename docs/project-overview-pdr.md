# Project Overview / PDR

> Product Development Requirements for **ckforensics**. Companion to user-facing `README.md` and module-level `architecture.md`.

## 1. Vision

Make Claude Code sessions **forensically inspectable**: where tokens went, what Claude touched, which skills would have helped. Local-first, zero telemetry, queryable.

## 2. Problem

| Pain | Status quo | ckforensics |
|------|------------|-------------|
| Opaque JSONL transcripts | Manual grep | SQLite-backed query |
| Subagent costs invisible | Aggregate only | Recursive Agent()/Task() cost tree |
| Skill gaps unknown | Trial + error | Pattern detection → ranked recs |
| Auto-compact drops context silently | Surprise | `map` heatmap + pre-compact simulator |
| Secret leakage risk in shared logs | Manual cleanup | 9 built-in redaction rules |
| "What did Claude actually do?" | Re-read transcript | `audit` manifest (diff + reasoning + subagent) |
| Approve-all-then-regret | git checkout dance | `review` hunk-by-hunk revert (v0.3+) |

## 3. Users

- **Primary:** Claude Code power users on Pro / Max / Team plans wanting ROI visibility + session retrospectives.
- **Secondary:** API users tracking spend with cache-pricing precision.
- **Tertiary:** Security-conscious devs needing redaction before sharing logs.

## 4. Non-goals

- Cloud sync / team analytics dashboards
- Web UI / IDE extension
- Live session HUD (post-hoc only — CC owns in-flight)
- Auto-commit / auto-fix (we generate, user approves)

## 5. Functional requirements

### 5.1 Ingest

- Parse `~/.claude/projects/**/*.jsonl`, idempotent + incremental
- Schema-versioned reducer; `UnknownEvent` bucket for graceful degradation
- Resume from byte offset; ~100k lines/sec target
- Optional `--watch` mode

### 5.2 Reporting commands

| Command | Output |
|---------|--------|
| `summary` | Token + USD rollup (default 7d) |
| `sessions` | Per-session table: cost, duration, model, project |
| `audit` | Session manifest: diffs + reasoning + subagent cost tree |
| `map` | Context heatmap, compaction simulator, snapshot diff/pin |
| `suggest` | Skill + process + prompt recommendations |
| `skills` | ClaudeKit catalog browser with usage stats |
| `cache` | Hit/miss stats, savings calculation |
| `review` | Hunk-by-hunk revert (TUI / markdown / batch) |
| `export` | Pipe-friendly markdown / JSON / CSV |
| `redact` | Strip 9 secret patterns from a file |
| `doctor` | Health check: DB, paths, schema version, log activity |
| `path` | Show all resolved FS paths |

### 5.3 Privacy

- Default redaction rules: API keys, GH/AWS/JWT tokens, high-entropy strings
- Apply before any export (markdown / CSV / JSON)
- DB file perms `0600` on Unix
- Zero outbound network calls (except npm postinstall binary download)

### 5.4 Cost accounting

- Version-aware pricing (Opus 4.5+ ≠ 4.0/4.1)
- Treat output as **API-rate equivalent**; subscription users see "value extracted"
- ±10–30% accuracy for cache-pricing edge cases (documented)

### 5.5 Cross-platform

- Linux x64 + arm64, macOS Apple Silicon, Windows x64 (prebuilt binaries)
- Intel Mac: build-from-source documented
- Single npm install; postinstall picks correct binary
- XDG-compliant storage paths per OS

## 6. Non-functional requirements

| Concern | Target |
|---------|--------|
| Cold ingest of 1000+ JSONL | ≤ 20s |
| Test coverage | ≥ 350 tests, real DB + real git (no mocks) |
| Bundle size (npm) | < 1 MB (binary lives in GH Releases) |
| Startup latency | < 100ms cold for non-ingest commands |
| Memory ceiling | streaming — bounded regardless of session size |

## 7. Constraints

- **Bun runtime** locked in (eliminates per-platform native rebuild). Node compatibility via npm wrapper only.
- **Read-only stance:** never mutate Claude Code's JSONL. `review` operates on working tree, never committed history.
- **JSONL schema can drift:** versioned reducer + fixture-driven tests are mandatory.
- **No mocks in DB tests:** prior mock/prod divergence philosophy.

## 8. Output contracts

JSON outputs carry `$schema` envelope for downstream consumers:
- `ckforensics-suggest-v2`
- `ckforensics-cache-v1`
- Audit/map: markdown default, `--json` available

## 9. Distribution

- npm: `npm i -g ckforensics` (postinstall downloads binary + installs `/ck:forensics` skill to `~/.claude/skills/`)
- Direct binary download from GitHub Releases
- Opt-out env: `CKFORENSICS_SKIP_SKILL_INSTALL=1`
- Release pipeline: tag `v*.*.*` → GitHub Actions → builds 5 binaries → publishes via `NPM_TOKEN`

## 10. Success metrics

- npm weekly installs trending up
- Issue rate < 1 per 100 installs
- Tests stay green across schema-version changes
- Community contributions to skill catalog patterns

## 11. Risks

| Risk | Mitigation |
|------|------------|
| Anthropic ships native equivalent | Stay narrowly scoped to forensics CC native won't cover (subagent tree, skill recs, hunk review) |
| JSONL schema breaks parser | Schema-versioned reducer + `UnknownEvent` graceful path |
| Cost numbers diverge from real billing | Documented ±10–30% margin; version-aware pricing tests |
| Redaction misses a secret pattern | Conservative rules + user-reviewed export step; community rule additions |
| Cross-platform regressions (CRLF, BOM) | Encoding/line-ending refusal + CRLF round-trip tests |

## 12. Open questions

- Should `review` support partial-hunk acceptance (sub-hunk granularity)?
- Cache visibility (v0.4): per-turn timeline format — chart vs table?
- Notify integrations (v0.6): rate-limit defaults per channel?
- Reasoning verifier (v0.4): which model + what determinism guarantees?
