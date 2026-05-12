---
name: ck:forensics
description: "Forensic analysis of Claude Code sessions — token cost, context map, audit manifest, skill recommendations. Use when user asks 'what did Claude touch', 'where did my tokens go', 'how much did this session cost', 'show last session', 'what skill should I have used', or wants post-hoc review of CC work."
category: dev-tools
keywords: [claude-code, audit, forensics, observability, token-cost, context, skill-recommender, session-review]
argument-hint: "summary|sessions|audit|map|suggest|skills|review|hook|watch|ingest [args]"
metadata:
  author: phong28zk
  version: "0.3.3"
  upstream: "https://github.com/phong28zk/ckforensics"
---

# ck:forensics — Claude Code Session Forensics

Read-only post-hoc analysis of `~/.claude/projects/**/*.jsonl` transcripts. Surfaces:
- **What was burned:** tokens, $, time, by tool/skill/file
- **What changed:** files touched, diff, reasoning trail, subagent attribution
- **What lives in context:** heatmap of items by category (tool_result, message, ...)
- **What you missed:** skills that would have replaced repeated manual sequences

Powered by the `ckforensics` CLI (npm `ckforensics@^0.2.1`). Local-only, no telemetry.

---

## Default (No Arguments)

If invoked without arguments, use `AskUserQuestion` to present operations:

| Operation | Description |
|-----------|-------------|
| `summary` | Token + cost rollup (last 7d default) |
| `sessions` | List recent sessions with cost/duration |
| `audit` | Per-session change manifest (files, diff, reasoning) |
| `map` | Context-window heatmap (what eats tokens?) |
| `suggest` | Skills that would have helped (pattern detection) |
| `skills` | List/search indexed skills with usage stats |
| `review` | Hunk-by-hunk Copilot-style review of session edits (accept/reject) |
| `ingest` | Refresh DB from `~/.claude/projects/` |

Present via `AskUserQuestion` with header "Forensics" and question "Which analysis?".

---

## Installation Check

Before running any command, ensure CLI is installed:

```bash
command -v ckforensics >/dev/null || {
  echo "ckforensics not installed. Install with: npm i -g ckforensics"
  exit 1
}
```

If missing, ask user to install before proceeding.

---

## Workflows

| Workflow | Reference |
|----------|-----------|
| End-of-day session review | `references/workflow-eod.md` |
| Pre-commit audit | `references/workflow-pre-commit.md` |
| Weekly cost retro | `references/workflow-weekly-retro.md` |
| Command reference | `references/commands.md` |
| Output interpretation | `references/interpretation.md` |

---

## Core Commands

### `summary [--days N]`

Token/cost rollup. Default 7 days.

```bash
ckforensics summary             # last 7 days
ckforensics summary --days 1    # today
ckforensics summary --days 30   # this month
ckforensics summary --json      # for piping to jq
```

**Cost interpretation:** API-rate equivalent. Subscription users (Pro/Max) pay flat fee — treat as "value extracted", not actual bill. See `references/interpretation.md`.

### `audit [--last|<session-id>] [--out FILE]`

Per-session change manifest:
- Header (model, duration, cost, total events)
- Files changed (with chronological edits + reasoning quotes)
- Subagent dispatches + recursive cost breakdown
- Reasoning correlator: each tool call linked to preceding assistant text

```bash
ckforensics audit --last                            # most recent session
ckforensics audit <session-id> --out review.md      # for PR review
ckforensics audit --last --format json | jq         # script-friendly
```

### `map [--last|<session-id>] [--top N]`

Context-window heatmap. Shows what categories eat the most tokens:
- `tool:Bash` → shell output
- `tool:Read` / `tool:Edit` → file ops
- `assistant` / `user` → messages
- `unknown` → unattributable

Use `--simulate-compact` to project what survives next auto-compact.

```bash
ckforensics map --last --top 20
ckforensics map --simulate-compact --target-pct 50
```

### `suggest [--session ID|--last|--days N] [--min-confidence 70]`

Skill recommendations: detects repeated tool patterns and matches against `~/.claude/skills/` catalog. Suggests skills that would have replaced manual work.

```bash
ckforensics suggest --last                       # for most recent session
ckforensics suggest --days 7 --min-confidence 30  # weekly retro
```

### `sessions [--project SLUG] [--limit N]`

List recent sessions with cost/duration. Filter by project.

```bash
ckforensics sessions --limit 10
ckforensics sessions --project ckforensics --limit 50
```

### `skills [--unused|--used] [--search QUERY] [--refresh]`

List indexed skills. `--unused` shows skills you have but never invoked. Discoverability tool.

```bash
ckforensics skills --refresh        # re-scan ~/.claude/skills/
ckforensics skills --unused | head  # what am I missing?
```

### `review [--last|<session-id>] [--emit FILE | --batch --decisions FILE]`

Walk through Claude's edits hunk-by-hunk. Three modes:

- **Interactive TUI** (default, requires terminal): keybindings `y` keep / `n` revert / `s` skip / `A` approve-all / `R` reject-all / `q` quit-menu.
- **Emit markdown:** `ckforensics review --last --emit review.md` writes a checklist; toggle `[ ] → [x]` in your editor.
- **Batch apply:** `ckforensics review --batch --decisions review.md [--dry-run] [--allow-dirty]` applies reverts via `git apply --reverse` with safety check.

```bash
# Typical post-session flow:
ckforensics review --last --emit review.md
# (edit review.md, tick [x] for hunks to revert)
ckforensics review --batch --decisions review.md --dry-run   # preview
ckforensics review --batch --decisions review.md             # apply
```

### `hook install [--exec CMD] [--out-path FILE]`

Wire `ckforensics review --last --emit` into Claude Code's **Stop hook** so a review markdown is auto-generated every time a session ends. Idempotent; preserves other user-configured hooks.

```bash
# Basic: write review.md to default cache path on every session end
ckforensics hook install

# Auto-open in VS Code when ready
ckforensics hook install --exec 'code {path}'

# Check / remove
ckforensics hook status
ckforensics hook uninstall
```

The `{path}` token in `--exec` is replaced with the resolved review-file path.

### `watch [--idle SECONDS] [--exec CMD] [--out-path FILE]`

Long-running daemon alternative to the Stop hook. Polls `~/.claude/projects/**/*.jsonl`; when the active session goes idle for the threshold, runs `ingest` + `review --last --emit`.

```bash
ckforensics watch --idle 30                                 # default
ckforensics watch --idle 60 --exec 'code {path}'            # auto-open in editor
ckforensics watch --once --exec 'notify-send "Review ready: {path}"'
```

Useful when you don't want to modify `~/.claude/settings.json`, or when running ckforensics as a sidecar process.

### `ingest`

Refresh DB from `~/.claude/projects/`. Incremental — only new jsonl content.

```bash
ckforensics ingest                  # one-shot
ckforensics ingest --watch          # poll every 5s
```

---

## When to Use This Skill

**After CC session:** Run `audit --last` to review what Claude changed.

**Cost review:** Run `summary` to see token burn vs subscription value.

**Habit improvement:** Run `suggest --days 7` weekly to find skill opportunities.

**Context optimization:** Run `map --last` when session hits compaction wall — see what eats tokens.

**Pre-commit:** Run `audit --last --out review.md` then `redact review.md --in-place` before sharing.

---

## Output Interpretation

| Pattern | Meaning |
|---------|---------|
| `tool:Bash` >40% of map | Heavy shell output; consider piping to `tail`/`head` |
| `tool:Read` repeats on same dir | `/ck:scout` candidate |
| Subagent cost > main cost | Runaway subagent — review prompt scope |
| Cost in red (>$10) | High-value session; worth saving manifest for retro |
| Suggest confidence <50% | Probably noise; only act on ≥70% |

See `references/interpretation.md` for full guide.

---

## Important Notes

- **All operations are read-only.** Never modifies `~/.claude/projects/`.
- **Cost is API-rate estimate** (Nov 2025 Anthropic pricing); subscription users see flat fee.
- **±20% attribution margin** on context map (heuristic-based).
- **Cache local at** `~/.local/share/ckforensics/store.db` (mode 0600).
- **Logs at** `~/.local/state/ckforensics/logs/` (Linux), `~/Library/Logs/ckforensics/` (macOS).

## Token Efficiency

- Activate `ck:context-engineering` skill if running `audit` or `map` on very long sessions (output can be 100k+ tokens of markdown — pipe to file).
- Use `--json` for downstream tools; avoids markdown formatting overhead.
- For routine ingest, cron handles it: `0 * * * * ckforensics ingest >> ~/.local/state/ckforensics/logs/ingest.log 2>&1`.

**Sacrifice grammar for concision when reporting findings to user.**

---

## Quick Start (User's First Run)

```bash
npm i -g ckforensics                    # install
ckforensics doctor                      # verify
ckforensics ingest                      # populate DB (~20s for 1000+ jsonl)
ckforensics summary                     # see weekly totals
ckforensics audit --last | head -50     # review last session
```
