# ck:forensics — Output Interpretation Guide

How to read what ckforensics tells you, and when to act on it.

## Cost interpretation

| Display | Meaning |
|---------|---------|
| `$X.XX` (green) | <$1 — typical small session |
| `$X.XX` (yellow) | $1-10 — substantive work |
| `$X.XX` (red) | >$10 — high-value session, worth saving manifest |
| `unknown` / `—` | Cost not estimable (missing model in DB, pre-pricing-fix) |
| `*` footnote | API-rate equivalent, not actual subscription bill |

**Two cost numbers compared:**
- ckforensics `Estimated Cost`: token count × Anthropic published rates
- CC live statusline: real-time `cost.total_cost_usd` from CC's internal calc

Discrepancy expected (CC may exclude some cache pricing). Within 30% = normal.

**For subscription users:** the cost number = "value extracted from your $X/mo plan", not a bill.

## Map heatmap thresholds

| Pattern | Diagnostic | Action |
|---------|-----------|--------|
| `tool:Bash` >40% | Heavy shell output | Pipe to `head`/`tail`, redirect logs, or limit verbose flags |
| `tool:Read` >30% | Excessive file reads | Use `/ck:scout` for batched discovery |
| `tool:Edit` >30% | Lots of edits | Normal for code-heavy session; check for thrashing |
| `assistant` >40% | Very long replies | Verbose mode, summarisation overhead |
| `unknown` >10% | Attribution failure | Schema drift; report to ckforensics issues |

## Suggest confidence brackets

| Confidence | Meaning | Action |
|------------|---------|--------|
| 80-100% | Strong signal, multi-pattern match | Try the skill next session |
| 60-80% | Plausible, single pattern | Worth reading description |
| 40-60% | Weak — likely keyword coincidence | Skip unless desperate |
| <40% | Noise | Ignore |

Default threshold = 70. Lower with `--min-confidence 30` if seeing no recs.

## Audit manifest sections

### Files changed

Each file shows chronological edits with reasoning quote. **Read the reasoning** — it's the assistant's intent text before the tool call, not post-hoc explanation. Useful for:
- Understanding *why* an edit was made
- Catching scope creep (intent vs action mismatch)
- Composing PR descriptions (reasoning often is the PR body)

### Subagent Cost Breakdown

Nested table. Top-level rows = direct Agent()/Task() calls from main thread. Indented rows = nested (subagent inside subagent).

**Red flags:**
- Single subagent with >$5 cost in <10 tool calls = runaway
- "open" duration → subagent still running (session paused?)
- Many small subagents (≤2 calls each) = excessive fanout

### Reasoning correlator

Each tool call gets a "Reasoning:" quote. If reasoning is empty/unhelpful:
- Assistant didn't narrate (rare)
- Tool fired in middle of multi-block message (correlator picks last text block)
- Subagent invocation (reasoning belongs to parent dispatch)

## Sessions list signals

- Same project, multiple short sessions same day → context flushing too often
- Single 10+ hour session → consider checkpointing via context map
- Cost trending up week-over-week → instrument with `summary --days N`

## When ingest finds nothing

If `ckforensics ingest` reports 0 new events:
1. Check `ckforensics doctor` — last ingest mtime
2. Verify `~/.claude/projects/` has recent jsonl: `ls -lt ~/.claude/projects/*/*.jsonl | head`
3. CC may be on different config dir (CLAUDE_CONFIG_DIR env var) — set `--db` accordingly
4. Force re-ingest from scratch: `rm ~/.local/share/ckforensics/store.db && ckforensics ingest`
