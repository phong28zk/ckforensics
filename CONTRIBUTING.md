# Contributing to ckforensics

Thanks for taking the time to contribute. Below is everything needed to go from zero to merged PR.

---

## Prerequisites

- **Bun ≥ 1.1** — https://bun.sh/docs/installation
- **Node.js** not required (Bun is the runtime)
- **Git**

---

## Dev Setup

```bash
git clone https://github.com/phong28zk/ckforensics.git
cd ckforensics
bun install
bun test          # 133 tests should pass
bun run typecheck # tsc --noEmit
```

---

## Project Structure

```
src/
  parsers/   — JSONL event parsing, schema detection
  store/     — SQLite schema, migrations, queries
  cli/       — Commander subcommands, output formatters
  audit/     — Session diff, manifest builder, subagent tracker
  privacy/   — Redaction rules, redactor engine
docs/        — Architecture, threat model, schema reference
```

---

## Coding Standards

- **TypeScript strict mode** — `tsconfig.json` enforces `strict: true`. No `any` without an explanatory comment.
- **File naming** — kebab-case, descriptive. `session-loader.ts` not `sl.ts`.
- **File size** — keep files under 200 lines. Split into modules if exceeding.
- **Error handling** — all async paths use try/catch. No silent failures.
- **No telemetry** — do not add any network calls. ckforensics is local-only by design.

---

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add CSV export format
fix: handle empty session JSONL gracefully
docs: clarify redaction gap in threat-model.md
refactor: extract token-counter into standalone module
test: add fixture for schema-v2 assistant events
chore: bump bun lockfile
```

- Keep subject ≤ 72 chars
- No AI tool references in commit messages
- Scope is optional: `feat(audit): detect duplicate tool calls`

---

## PR Checklist

Before opening a PR, verify each item:

- [ ] `bun test` passes locally (all tests green)
- [ ] `bun run typecheck` exits 0
- [ ] New behavior has test coverage (add fixtures or unit tests)
- [ ] No secrets or real session data in fixtures
- [ ] `gitleaks detect --source .` exits clean (if gitleaks installed)
- [ ] Commit messages follow conventional commits
- [ ] PR description explains *why*, not just *what*

See [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) — it will pre-fill when you open a PR.

---

## Adding a JSONL Fixture

Fixtures live in `src/**/__tests__/fixtures/`. They are real or synthetic JSONL snippets used by unit tests.

**Rules:**
1. Never use real session files. Synthesize from scratch or anonymize completely.
2. Replace all UUIDs with deterministic fake UUIDs (e.g. `aaaaaaaa-0000-4000-8000-000000000001`).
3. Replace all filesystem paths with `/fake/path/project`.
4. Replace all timestamps with fixed values (`2026-01-01T00:00:00.000Z`).
5. Ensure `gitleaks detect --source .` passes before committing the fixture.
6. Add a comment at the top of the fixture file explaining what scenario it covers.

---

## Issue Labels

| Label | When to apply |
|-------|---------------|
| `good-first-issue` | Isolated, well-scoped, low risk |
| `help-wanted` | Maintainer needs community input |
| `bug` | Confirmed misbehavior |
| `schema-drift` | CC schema changed, parser needs update |
| `audit` | Related to audit / diff commands |
| `analytics` | Token usage / summary features |
| `privacy` | Redaction rules, threat model |
| `claudekit` | Integration with ClaudeKit ecosystem |

---

## Getting Help

- Open a [Discussion](https://github.com/phong28zk/ckforensics/discussions) for questions
- Open an issue only for confirmed bugs or feature proposals
- Tag `@phong28zk` if a PR sits unreviewed for >72h
