# ckforensics

> 🔍 **Forensic CLI for Claude Code sessions** — see where your tokens went, what Claude touched, and which skills you missed.

[![CI](https://github.com/phong28zk/ckforensics/actions/workflows/ci.yml/badge.svg)](https://github.com/phong28zk/ckforensics/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ckforensics)](https://www.npmjs.com/package/ckforensics)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6)](https://bun.sh)
[![ClaudeKit Skill](https://img.shields.io/badge/ClaudeKit-/ck:forensics-9333ea)](#claudekit-integration)

**One install. Two interfaces.** Standalone CLI **and** ClaudeKit `/ck:forensics` skill — bundled together.

```bash
npm i -g ckforensics
```

---

## What does it do?

After Claude Code finishes a session, ckforensics parses `~/.claude/projects/**/*.jsonl` and tells you:

```
╭─ ckforensics summary --days 7 ──────────────────────────────────╮
│  Sessions          19                                            │
│  Input tokens      69,190                                        │
│  Output tokens     3,088,275                                     │
│  Cache read        934,429,934                                   │
│  Total tokens      967,848,242                                   │
│  Estimated cost*   $733.8981  ← value extracted from $100 Max    │
│  Files touched     149                                           │
│  Edit operations   488                                           │
╰──────────────────────────────────────────────────────────────────╯
```

```
╭─ ckforensics map --last (where do my tokens go?) ──────────────╮
│  tool:Bash    ████████  40.5%   30,444 tok  (293 calls)          │
│  tool:Edit    ███       16.1%   12,396 tok  (98)                 │
│  assistant    ██        11.9%    9,197 tok  (563)                │
│  tool:Read    ██        10.8%    8,327 tok  (70)                 │
│  tool:Write   ██         9.3%    7,179 tok  (42)                 │
│                                                                   │
│  Total: 77,204 tokens  (±20% attribution margin)                 │
╰──────────────────────────────────────────────────────────────────╯
```

```
╭─ ckforensics suggest --last (what skills would have helped?) ──╮
│  #1  /ck:scout                                  confidence: 85% │
│      You ran 23× Read on src/audit/* in turns 47-89             │
│      /ck:scout fans out file discovery in parallel              │
│      Est. savings: 12k tokens ($0.14)                           │
│                                                                   │
│  #2  /ck:test                                   confidence: 72% │
│      8× `bun test` Bash calls in retry loop                     │
╰──────────────────────────────────────────────────────────────────╯
```

```
╭─ ckforensics audit --last  (session change manifest) ──────────╮
│  ## Subagent Cost Breakdown                                      │
│                                                                   │
│  │ Subagent           │ Tokens │ Cost   │ Tool calls │ Duration ││
│  ├────────────────────┼────────┼────────┼────────────┼──────────┤│
│  │ Agent: P11 log infra│ 28.9M │ $28.42 │ 20         │ open     ││
│  │ └── nested forensics│ 28.2M │ $27.91 │ 19         │ open     ││
│  │ Agent: P06 build    │ 646k  │ $0.61  │ 2          │ 3h0m     ││
│  │ Agent: P07 ctx map  │ 751k  │ $0.47  │ 1          │ 12m28s   ││
│  └────────────────────┴────────┴────────┴────────────┴──────────┘│
│                                                                   │
│  ↑ Identifies runaway subagents in long sessions                 │
╰──────────────────────────────────────────────────────────────────╯
```

\* API-rate equivalent (Anthropic Nov 2025 pricing). Subscription users (Pro/Max/Team) pay flat fee — treat as "value extracted from your plan", not actual billing.

---

## Why does this exist?

| Pain | ckforensics |
|------|-------------|
| Claude Code stores transcripts as opaque JSONL | Parses into queryable SQLite |
| You can't see what subagents cost vs the parent | Recursive cost tree per Agent()/Task() |
| You don't know which skills you skipped using | Pattern detection → ranked recommendations |
| Auto-compact is opaque, drops context invisibly | `map` shows what eats your window |
| Sensitive keys leak into committed jsonl logs | 9 built-in redaction rules |
| "How much did Claude cost me this week?" | `summary` gives token + USD totals |
| "What did Claude actually change in that 14h session?" | `audit` produces signed-off manifest |

---

## Install

```bash
npm i -g ckforensics
```

Single command installs:
1. **Cross-platform binary** (Linux x64/arm64, macOS Apple Silicon, Windows x64) via npm postinstall download
2. **ClaudeKit skill** at `~/.claude/skills/ckforensics/` — auto-activates in next Claude Code session

> **Intel Mac:** build from source — `bun build --compile --target=bun-darwin-x64 src/cli/index.ts --outfile ckforensics`
>
> **Opt out of skill copy:** `CKFORENSICS_SKIP_SKILL_INSTALL=1 npm i -g ckforensics`

Or grab a binary directly:

```bash
# Linux x64
curl -L https://github.com/phong28zk/ckforensics/releases/latest/download/ckforensics-linux-x64 \
  -o /usr/local/bin/ckforensics && chmod +x /usr/local/bin/ckforensics
```

---

## Quick Start

```bash
ckforensics ingest                         # populate DB (~20s for 1000+ jsonl)
ckforensics summary                        # weekly totals
ckforensics audit --last                   # last session manifest
ckforensics map --last --top 10            # context heatmap
ckforensics suggest --last                 # skill recommendations
ckforensics doctor                         # health check
```

**Recommended cron** (hourly auto-ingest):

```bash
(crontab -l 2>/dev/null; echo "0 * * * * $(which ckforensics) ingest >> ~/.local/state/ckforensics/logs/ingest.log 2>&1") | crontab -
```

---

## ClaudeKit integration

When installed, `/ck:forensics` is available inside Claude Code:

```
You: "show me last session cost"
Claude: [auto-invokes /ck:forensics → reads SKILL.md → runs ckforensics audit --last]
Claude: "Last session was 18h, $1102 API-equivalent. Top files: ..."
```

**Triggers** (skill description picks these up):
- "what did Claude touch this session"
- "show me last session cost"
- "where did my tokens go"
- "audit last session"
- "what skill should I have used"
- `/ck:forensics summary` / `/ck:forensics audit` / etc

The skill ships with 3 workflows:
- **`workflow-eod.md`** — end-of-day session review
- **`workflow-pre-commit.md`** — generate commit message + redact before commit
- **`workflow-weekly-retro.md`** — Sunday retrospective

---

## Storage

DB at XDG-compliant path (mode `0600`):

| OS | Path |
|----|------|
| Linux | `~/.local/share/ckforensics/store.db` |
| macOS | `~/Library/Application Support/ckforensics/store.db` |
| Windows | `%APPDATA%\ckforensics\store.db` |

Logs (daily-rotated):

| OS | Path |
|----|------|
| Linux | `~/.local/state/ckforensics/logs/` |
| macOS | `~/Library/Logs/ckforensics/` |
| Windows | `%LOCALAPPDATA%\ckforensics\Logs\` |

**Nothing leaves your machine.** No telemetry. No cloud sync. Run `ckforensics path` to see resolved paths.

---

## Feature Matrix

| Feature | ckforensics | ccusage | Native CC `/usage` |
|---------|:-----------:|:-------:|:--------------------:|
| Local SQLite storage | ✅ | ✅ | ❌ |
| Token usage analytics | ✅ | ✅ | ✅ (live only) |
| Version-aware cost pricing | ✅ | 🟡 | ✅ |
| Subagent cost forensics (recursive) | ✅ | ❌ | ❌ |
| Context window heatmap | ✅ | ❌ | ❌ |
| Pre-compact simulation | ✅ | ❌ | ❌ |
| Skill recommendation engine | ✅ | ❌ | ❌ |
| Session change manifest (diff + reasoning) | ✅ | ❌ | ❌ |
| Secret redaction (9 rules) | ✅ | ❌ | ❌ |
| Markdown / JSON / CSV export | ✅ | 🟡 | ❌ |
| Offline, zero telemetry | ✅ | ✅ | ✅ |
| Cross-platform binaries | ✅ | ❌ | ✅ |
| ClaudeKit skill bundled | ✅ | ❌ | ❌ |

---

## Commands

| Command | Purpose |
|---------|---------|
| `ingest` | Parse JSONL → SQLite (idempotent + incremental, optional `--watch`) |
| `summary` | Token + cost rollup over rolling window (default 7d) |
| `sessions` | List sessions with cost, duration, model |
| `audit` | Per-session manifest: diffs + reasoning + subagent breakdown |
| `map` | Context-window heatmap by category, snapshot/diff/pin |
| `suggest` | Skill recommendations from detected tool patterns |
| `skills` | Browse ClaudeKit skill catalog with usage stats |
| `review` | Hunk-by-hunk Copilot-style review of session edits (TUI / emit / batch) |
| `hook install` | Wire Claude Code Stop hook so review auto-runs after every session |
| `watch` | Daemon: poll for session-end → auto-emit review markdown |
| `export` | Pipe-friendly export (markdown, JSON, CSV) |
| `redact` | Strip 9 secret patterns from a file |
| `doctor` | Health check (DB, paths, schema version, log activity) |
| `path` | Show all resolved file system paths |

Run `ckforensics <cmd> --help` for flags.

---

## Post-session review (three UX modes)

After Claude Code finishes a session, walk through every edit hunk-by-hunk and accept/reject each — similar to GitHub Copilot's review panel, but driven by ckforensics' manifest (knows file, when, why).

**Mode 1 — Manual** *(default; control freaks)*

```bash
ckforensics review --last                          # interactive TUI
# or:
ckforensics review --last --emit review.md         # write checklist
# tick [x] in your editor → batch apply
ckforensics review --batch --decisions review.md --dry-run
ckforensics review --batch --decisions review.md
```

**Mode 2 — Stop hook** *(auto-trigger when session ends)*

```bash
ckforensics hook install --exec 'code {path}'      # write + open in VS Code
# Verify:
ckforensics hook status
# Remove later:
ckforensics hook uninstall
```

The hook is appended to `~/.claude/settings.json` non-destructively and tagged `managed-by:ckforensics`. Other user hooks are untouched.

**Mode 3 — Watch daemon** *(when you don't want to touch settings.json)*

```bash
ckforensics watch --idle 30 --exec 'code {path}'
```

Polls `~/.claude/projects/**/*.jsonl`; when the active session goes idle for the threshold, runs `ingest` + `review --emit` + your `--exec` command.

### Safety guarantees

- Refuses to revert files with **uncommitted user changes** unless `--allow-dirty`
- Refuses files in **UTF-16 / UTF-32** unconditionally (corruption risk)
- Preserves **CRLF** line endings when target is Windows-style (MQL5, C#, .bat)
- Detects **content drift** when running outside git
- Hunks where Claude didn't `Read` first are **reconstructed** from git HEAD or the edit chain (lifts reviewable rate ~5× in practice)

---

## About cost numbers

Cost is **API-rate equivalent** computed from token counts × Anthropic's published prices ([Nov 2025 snapshot](https://platform.claude.com/docs/en/about-claude/pricing)).

- **API users:** approximates your actual bill (±10-30% for cache-pricing edge cases)
- **Subscription users (Pro / Max / Team):** flat plan fee covers this — treat the number as **"value extracted"** from your subscription

Example: a 14h Opus 4.7 session showing `$166` means you'd pay ~$166 at API rates — your $100/mo Max plan covers it with positive ROI.

---

## Documentation

| Doc | Topic |
|-----|-------|
| [docs/architecture.md](docs/architecture.md) | Module overview, data flow |
| [docs/threat-model.md](docs/threat-model.md) | Privacy stance, redaction guarantees |
| [docs/jsonl-schema-v1.md](docs/jsonl-schema-v1.md) | Reverse-engineered JSONL event types |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, PR checklist, fixture rules |
| [ROADMAP.md](ROADMAP.md) | v0.1.x → v0.6+ feature plans |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

---

## License

MIT — [LICENSE](LICENSE) — Copyright (c) 2026 phong28zk

---

## Acknowledgements

- [ClaudeKit](https://github.com/phong28zk) ecosystem for the `/ck:*` skill pattern
- [Anthropic](https://anthropic.com) for Claude Code + the public JSONL transcript format
- [Bun](https://bun.sh) for single-binary compilation that makes cross-platform distribution painless
