# Weekly Retro Workflow

Pattern: every Sunday (or Monday morning), look back at the week — cost trends, skill discovery, runaway sessions.

## Flow

```
1. ckforensics ingest                                 # ensure DB current
2. ckforensics summary --days 7                       # weekly rollup
3. ckforensics sessions --limit 20                    # week's sessions
4. ckforensics suggest --days 7 --min-confidence 50   # patterns to fix
5. ckforensics skills --unused | head -20             # discovery
```

## When Claude runs this skill

User says one of:
- "weekly retro"
- "what did I spend on Claude Code this week"
- "any patterns I should fix in my workflow"
- "show me sessions ranked by cost"
- "what skills should I learn"

## What Claude should do

1. **Summary numbers first** — cost, session count, vs previous week if possible (`--days 14` then compute delta).
2. **Top 5 most expensive sessions** with project + duration. Flag anything over $50.
3. **Recurring patterns** from `suggest --days 7`:
   - List top 3 skill recommendations
   - Group by pattern type (e.g. "read-fanout detected 4× this week")
4. **Skill discovery**:
   - From `skills --unused`, pick 3-5 that match user's project work (filter by keyword overlap with recent session topics)
   - Format as "consider trying: /ck:xyz — <description>"
5. **Anomaly check**:
   - Any single session >$100? Flag for review.
   - Any subagent that ran >1h? Worth investigating.
6. **Optional: write retro to docs/**:
   - `docs/retros/YYYY-MM-DD-week-N.md`
   - Auto-fill summary + recommendations sections
   - User edits notes manually after

## Example response template

```
Weekly retro (Mon 2026-05-04 → Sun 2026-05-10):

📊 Totals: $733 API-equivalent across 19 sessions, 967M tokens
   vs prev week: +180% (last week $260 / 12 sessions)
   
🔥 Top sessions:
   1. project-noname  18h56m  $1102  (Tue, 4082 events)
   2. MQL5            2h21m   $29    (Tue)
   3. career-launchpad 19h    $32    (Wed)

📚 Skill recommendations:
   - /ck:scout (4× read-fanout patterns this week — 50k tok save)
   - /ck:test (3× test-loop patterns — 15k tok save)

💡 Try these unused skills:
   - /ck:retro — auto-generate this report (would replace this manual flow)
   - /ck:journal — capture session reflections automatically
   - /ck:debug — systematic debugging when stuck

⚠️ Notable: session #1 was 18h Opus — consider checkpointing context mid-way.
```

## Anti-patterns

- ❌ Compare cost to subscription price as if it's the bill — it's API-equivalent, frame as "value extracted"
- ❌ Recommend ALL unused skills (150+) — filter to relevant per project context
- ❌ Skip anomaly check — outliers are the highest-signal items
- ❌ Long bullet lists — keep tight, 3-5 items per category max
