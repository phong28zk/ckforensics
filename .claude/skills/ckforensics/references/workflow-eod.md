# End-of-Day Session Review Workflow

Pattern: after a substantial Claude Code session, run forensics to know what shipped, what burned, what to remember.

## Flow

```
1. ckforensics ingest                       # refresh DB
2. ckforensics summary --days 1             # today's totals
3. ckforensics audit --last --out eod.md    # capture manifest
4. ckforensics suggest --last               # skills that would have helped
5. ckforensics map --last --top 15          # what ate the context
```

## When Claude runs this skill

User says one of:
- "wrap up this session"
- "what did I do today"
- "end of day review"
- "summary of last session"
- "did Claude do anything weird"

## What Claude should do

1. Run the 5 commands above (or relevant subset).
2. **Summarise**, don't paste raw output to user. Surface:
   - Total cost (API-rate) + duration
   - Top 3 files changed (by lines or by importance from reasoning quotes)
   - Any subagent that cost >$1 (flag for review)
   - Top 1-2 skill recommendations with confidence ≥70
   - Context map insight: what ate most tokens
3. **Offer next actions:**
   - "Save audit manifest as PR description?" → use `eod.md`
   - "Dismiss low-value skill recs?" → `~/.config/ckforensics/dismissed.json`
   - "Schedule cron for daily ingest?" → crontab snippet

## Example response template

```
Today's session burned $X.XX over Y hours. Modified Z files (top: A, B, C).

Notable:
- Subagent "P11 log infra" cost $28 — runaway, worth reviewing
- Skill /ck:scout would have replaced 23× Read on src/audit/* (saves ~12k tokens)
- Context map: tool:Bash 40%, tool:Edit 16% — heavy shell + editing

Manifest saved to eod.md. Want me to draft a commit message from it?
```

## Anti-patterns

- ❌ Paste full audit markdown (1000+ lines) to user
- ❌ Run all 5 commands when user only asked "cost today"
- ❌ Recommend skills with confidence <70 without flagging confidence
- ❌ Skip subagent cost breakdown — that's the highest-signal section
