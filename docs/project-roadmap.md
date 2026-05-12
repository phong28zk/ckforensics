# Project Roadmap

> Living view of phases + milestones. Authoritative source for stretch detail: root `ROADMAP.md`. Authoritative source for shipped detail: root `CHANGELOG.md`. This doc reconciles both into a status board.

## Current version: **v0.3.3** (2026-05-12)

## Status board

| Version | Theme | Status |
|---------|-------|--------|
| v0.1.0 | Foundation + signature audit | ✅ Shipped |
| v0.1.1 | Cost pricing fix (Opus 4.5+, Haiku 4.5) | ✅ Shipped |
| v0.1.2–0.1.5 | Release pipeline iteration (TP → NPM_TOKEN) | ✅ Shipped |
| v0.1.6 | Skill Recommender (Phase 09) | ✅ Shipped |
| v0.1.7 | Invocation-hint prefix fix | ✅ Shipped |
| v0.2.0 | Context Map (Brilliant Tier) | ✅ Shipped |
| v0.2.1 | Log infrastructure + subagent cost forensics | ✅ Shipped |
| v0.2.2 | `/ck:forensics` ClaudeKit skill bundle | ✅ Shipped |
| v0.2.3 | README hero demos + storage tables | ✅ Shipped |
| v0.2.4 | Process + prompt advice bank | ✅ Shipped |
| v0.2.5 | Session-level advice + `cache` command | ✅ Shipped |
| v0.3.0 | Post-session edit review (Copilot-style) | ✅ Shipped |
| v0.3.1 | Cross-platform review safety (CRLF, UTF-16 refusal) | ✅ Shipped |
| v0.3.2 | Auto-trigger review: Stop hook + watch daemon | ✅ Shipped |
| v0.3.3 | TUI polish: short paths, file context, jump-to-file | ✅ Shipped |
| **v0.4.0+** | Stretch: reasoning verifier, cache timeline, plan drift, analytics TUI | 🟡 Planning |
| v0.5.0 | VCS integration (generate commits/PR bodies, never auto-commit) | 🟡 Planning |
| v0.6.0 | Team chat notifications (Slack/Discord/Telegram/Teams/Mattermost) | 🟡 Planning |

## Near-term milestones

### M1 — v0.4.0 scope lock (next)
- Pick first stretch feature: subagent cost (already shipped 0.2.1) vs cache timeline vs plan-drift
- Likely first: **cache hit/miss timeline** (per-turn chart) — extends 0.2.5 `cache` command
- Open question: reasoning verifier UX — opt-in flag, user API key, determinism guarantees

### M2 — v0.5.0 commit/PR generation
- Parse plan-file convention: `plans/{slug}/phase-NN-*.md` checklists
- Map commits ↔ phases via timestamps + files touched
- Fallback to git-diff-only mode when no plan present
- Output sinks: stdout pipe, `--out FILE`, clipboard
- Hard rule: **never auto-commit**

### M3 — v0.6.0 notify
- Adapter pattern: Slack / Discord / Telegram / MS Teams / Mattermost webhooks
- Config: `~/.config/ckforensics/notify.toml`, `0600` perms
- Rate-limit + commit-SHA dedup
- Triggers: manual `notify --on push|release|pr` OR `hook install` git post-push

## Out of scope (durable)

- Cloud sync / team analytics
- Web dashboard
- IDE extension
- Live session streaming (we are post-hoc; CC owns in-flight)

## Cadence

- **Patch (0.x.y):** ship as soon as green tests + CHANGELOG entry
- **Minor (0.x.0):** batch feature + docs update + README demo refresh
- **Major (1.0.0):** lock JSONL schema-v1 reducer + commit to API stability

## Resource allocation (informal)

| Area | Effort share |
|------|--------------|
| Core forensics (parser/store/audit) | 30% — mature, mostly maintenance |
| Recommender + context-map | 25% — active expansion |
| Review (v0.3) | 20% — recently shipped, hardening phase |
| VCS / notify (v0.5+) | 15% — design phase |
| Docs / DX / release pipeline | 10% — ongoing |

## Open questions

- v0.4 first feature pick — community signal?
- Should review support sub-hunk granularity, or wait for user demand?
- Notify rate-limit defaults — per-channel or global?
- When to commit to v1.0 schema lock?

## Pointers

- `ROADMAP.md` (root) — full prose detail per phase
- `CHANGELOG.md` — exhaustive shipped log
- `plans/260510-2123-ckdev-helper/` — phase-by-phase implementation plan (dev repo only)
