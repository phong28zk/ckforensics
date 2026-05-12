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

## v0.3.0 — Post-Session Edit Review (Copilot-style)

After Claude Code finishes a session, walk through every edit hunk-by-hunk and let user accept/reject each independently. Similar to `git add -p` but driven by ckforensics' session manifest (knows what Claude touched, when, why).

- `ckforensics review [--session ID|--last] [--interactive]` — TUI hunk navigator
  - Per file: show edit chronology + net diff
  - Per hunk: `y` keep / `n` revert / `s` skip / `q` quit / `r` show reasoning quote
  - Reverts apply via `git checkout -p` equivalent (operates on working tree, never committed history)
- `ckforensics review --batch --decisions FILE` — non-interactive: read YAML decisions, apply
- `ckforensics review --emit FILE` — write structured markdown with each edit + accept/reject placeholders for offline review
- Safety: only operates on files in working tree (not committed history); refuses if uncommitted user changes exist on touched files
- Integration: pairs with Phase 04 audit manifest; reasoning trail shown alongside each hunk

Trade-off: Claude Code itself owns in-flight approval (permission modes). ckforensics is post-hoc — same session, "approve all + review after" workflow.

## v0.4.0+ — Stretch Goals

- **Reasoning Verifier** (LLM-assisted) — opt-in flag, uses user's API key, deterministic + semantic matching
- **Subagent cost forensics** — recursive Agent() breakdown
- **Cache visibility** — hit/miss timeline
- **Plan drift detector** — phase TODO vs actual file changes
- **Analytics TUI** — only if Anthropic hasn't shipped a native equivalent

## v0.5.0 — VCS Integration (Generate, Don't Write)

Generate commit-ready text from session manifests. Never auto-commit — user has final approval.

- `ckforensics commit --phase N` → conventional commit message scoped to phase N file changes
- `ckforensics pr --plan <dir>` → full PR body: summary, per-phase TLDRs, test plan, breaking changes
- `ckforensics issue close <num>` → issue close comment: root cause, fix, trade-offs
- Plan-aware: parses `plans/{slug}/phase-NN-*.md` checklists, links commits ↔ phases
- Output formats: stdout (pipe to `gh pr create --body-file -`), `--out FILE`, clipboard

Trade-off: relies on plan-file convention (`- [x]` checklists). Falls back to git-diff-only mode when no plan present.

## v0.6.0 — Team Chat Notifications

Human-tone +1 messages on PR/release events. Opt-in via `ckforensics notify` command or git post-push hook.

- Adapters: Slack webhook, Discord webhook, Telegram bot, MS Teams connector, Mattermost
- Templates: I/O-style brief, casual voice. Example:
  > "Shipped v0.1.5 to npm — auto-publish via NPM_TOKEN now wired. 3 files, +14/-11. Next: v0.2 features."
- Config file `~/.config/ckforensics/notify.toml`:
  ```toml
  [slack]
  webhook_url = "https://hooks.slack.com/..."
  channel = "#deploys"

  [discord]
  webhook_url = "https://discord.com/api/webhooks/..."
  ```
- Triggers: `ckforensics notify --on push|release|pr` (manual), or git hook script installed by `ckforensics hook install`
- Anti-spam: rate limit per-channel, dedupe by commit SHA

Trade-off: webhook URLs in plaintext config (0600 perms); user responsibility to secure host.

## Out of scope

- Cloud sync / team analytics
- Web dashboard
- IDE extension
- Live session streaming (we are post-hoc CSI, not live HUD)

## Detailed plan

See `plans/260510-2123-ckdev-helper/` in the development repo for phase-by-phase breakdown.
