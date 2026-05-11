# Roadmap

## v0.1.0 (current) — Foundation + Signature Audit

- ✅ JSONL streaming parser (schema v1)
- ✅ SQLite store + incremental ingest
- ✅ CLI surface (8 subcommands)
- ✅ Session change manifest with diff + reasoning + subagent tracking
- ✅ Redaction (9 built-in rules)
- ✅ Cross-platform binaries + npm wrapper
- ✅ CI + release pipeline
- ⏳ npm publish + first GitHub Release
- ⏳ README demo gif

## v0.2.0 — Brilliant Tier

- **Skill Recommender** — analyze session, suggest skills that would have replaced repeated manual tool sequences. Hooks into ClaudeKit skills catalog when present.
- **Context Map** (X-ray) — visualize what eats tokens in current window; pre-compact simulator; pinning manifest output. Documented as best-effort with ±20% attribution margin.
- **Log infrastructure** — XDG-compliant per-OS log directory with daily rotation:
  - Linux: `~/.local/state/ckforensics/logs/`
  - macOS: `~/Library/Logs/ckforensics/`
  - Windows: `%LOCALAPPDATA%\ckforensics\Logs\`
  - Levels: error (default) / info (`-v`) / debug (`-vv`)
  - File naming: `<command>-YYYY-MM-DD.log` (e.g. `ingest-2026-05-11.log`)
  - `ckforensics path` will surface log directory
  - Critical for cron-driven `ingest --watch` users to debug failures

## v0.3.0+ — Stretch Goals

- **Reasoning Verifier** (LLM-assisted) — opt-in flag, uses user's API key, deterministic + semantic matching
- **Subagent cost forensics** — recursive Agent() breakdown
- **Cache visibility** — hit/miss timeline
- **Plan drift detector** — phase TODO vs actual file changes
- **Analytics TUI** — only if Anthropic hasn't shipped a native equivalent

## Out of scope

- Cloud sync / team analytics
- Web dashboard
- IDE extension
- Live session streaming (we are post-hoc CSI, not live HUD)

## Detailed plan

See `plans/260510-2123-ckdev-helper/` in the development repo for phase-by-phase breakdown.
