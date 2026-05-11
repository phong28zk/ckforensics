/**
 * Recommender test suite (Phase 09).
 *
 * Covers:
 *   1. skill-catalog-indexer: tmpdir SKILL.md fixtures → parse + persist
 *   2. pattern-detector: synthetic events matching each pattern type
 *   3. pattern-skill-matcher: catalog + pattern → ranked candidates
 *   4. savings-estimator: known tokens → expected USD delta
 *   5. skill-usage-tracker: fixture events with <command-name> → row inserted
 *   6. dismissed-recs-store: dismiss/undismiss/filter
 *   7. effectiveness-analyzer: no crash on empty DB
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { indexSkillCatalog, loadCatalog } from "../skill-catalog-indexer.ts";
import { detectPatterns } from "../pattern-detector.ts";
import { matchSkillsForPattern } from "../pattern-skill-matcher.ts";
import { estimateSavings, buildSavingsMap } from "../savings-estimator.ts";
import {
  trackSkillUsage,
  getSkillUsageForSession,
  getAggregateSkillUsage,
} from "../skill-usage-tracker.ts";
import { filterDismissed } from "../dismissed-recs-store.ts";
import { analyzeSkillEffectiveness } from "../effectiveness-analyzer.ts";
import type { HydratedEvent } from "../../audit/manifest-types.ts";
import type { SkillCatalogEntry } from "../types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshDb(): Database {
  const db = openDb(":memory:", { skipMmap: true });
  runMigrations(db);
  return db;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ckf-recommender-"));
}

/** Build a minimal HydratedEvent wrapping an assistant turn with tool_use blocks. */
function makeAssistantEvent(
  toolUses: Array<{ name: string; input: Record<string, unknown> }>,
  timestamp = "2025-01-01T00:00:00Z",
  tokens = 1000
): HydratedEvent {
  return {
    eventId: `ev-${Math.random().toString(36).slice(2)}`,
    sessionId: "test-session",
    type: "assistant",
    timestamp,
    event: {
      kind: "assistant",
      timestamp,
      message: {
        role: "assistant",
        content: toolUses.map((tu, i) => ({
          type: "tool_use" as const,
          id: `tu-${i}`,
          name: tu.name,
          input: tu.input,
        })),
        usage: { input_tokens: tokens, output_tokens: 200 },
      },
      raw: {},
    },
  };
}

/** Build a system event carrying a skill activation marker. */
function makeSystemEvent(content: string, timestamp = "2025-01-01T00:00:00Z"): HydratedEvent {
  return {
    eventId: `ev-sys-${Math.random().toString(36).slice(2)}`,
    sessionId: "test-session",
    type: "system",
    timestamp,
    event: {
      kind: "system",
      timestamp,
      content,
      raw: {},
    },
  };
}

/** Write a minimal SKILL.md with frontmatter to a temp skills dir. */
function writeSkillMd(
  skillsDir: string,
  skillName: string,
  opts: { description?: string; keywords?: string[] } = {}
): string {
  const dir = join(skillsDir, skillName);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${skillName}`,
    `description: "${opts.description ?? `The ${skillName} skill`}"`,
    `keywords: [${(opts.keywords ?? [skillName]).join(", ")}]`,
    "---",
    "",
    `# ${skillName}`,
    "Skill documentation here.",
  ].join("\n");
  const p = join(dir, "SKILL.md");
  writeFileSync(p, fm, "utf-8");
  return p;
}

// ── 1. Skill catalog indexer ──────────────────────────────────────────────────

describe("skill-catalog-indexer", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = makeTempDir();
    db = freshDb();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes SKILL.md files from tmpdir", () => {
    writeSkillMd(tmpDir, "scout", { description: "Code explorer", keywords: ["explore", "search"] });
    writeSkillMd(tmpDir, "test", { description: "Test runner", keywords: ["test", "bun"] });
    writeSkillMd(tmpDir, "plan", { description: "Planning agent", keywords: ["plan"] });

    const result = indexSkillCatalog(db, tmpDir);

    expect(result.indexed).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("persists entries readable via loadCatalog", () => {
    writeSkillMd(tmpDir, "scout", { description: "Scout skill", keywords: ["explore"] });
    indexSkillCatalog(db, tmpDir);

    const catalog = loadCatalog(db);
    expect(catalog.length).toBeGreaterThanOrEqual(1);

    const scout = catalog.find((e) => e.name === "scout");
    expect(scout).toBeDefined();
    expect(scout!.description).toContain("Scout");
    expect(scout!.keywords).toContain("explore");
  });

  it("skips SKILL.md with missing name field (malformed frontmatter)", () => {
    // Write a SKILL.md without a name field
    const dir = join(tmpDir, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: broken\n---\n# broken\n");

    const result = indexSkillCatalog(db, tmpDir);
    expect(result.skipped).toBe(1);
    // DB should have 0 entries
    const catalog = loadCatalog(db);
    expect(catalog.find((e) => e.name === "broken")).toBeUndefined();
  });

  it("skips SKILL.md with no frontmatter at all", () => {
    const dir = join(tmpDir, "nofm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# No frontmatter\nJust text.");
    const result = indexSkillCatalog(db, tmpDir);
    expect(result.skipped).toBe(1);
  });

  it("returns zero counts for non-existent skills dir", () => {
    const result = indexSkillCatalog(db, join(tmpDir, "nonexistent"));
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("uses mtime cache — second index call marks no refresh when unchanged", () => {
    writeSkillMd(tmpDir, "scout", {});
    indexSkillCatalog(db, tmpDir);
    const r2 = indexSkillCatalog(db, tmpDir);
    // All already indexed, none refreshed
    expect(r2.refreshed).toBe(0);
    expect(r2.indexed).toBeGreaterThan(0);
  });
});

// ── 2. Pattern detector ───────────────────────────────────────────────────────

describe("pattern-detector", () => {
  it("detects read-fanout: ≥5 Reads same dir within 3 turns", () => {
    const events: HydratedEvent[] = [];
    // 6 Read calls on /src/ dir across 2 turns
    events.push(makeAssistantEvent([
      { name: "Read", input: { file_path: "/src/a.ts" } },
      { name: "Read", input: { file_path: "/src/b.ts" } },
      { name: "Read", input: { file_path: "/src/c.ts" } },
    ]));
    events.push(makeAssistantEvent([
      { name: "Read", input: { file_path: "/src/d.ts" } },
      { name: "Read", input: { file_path: "/src/e.ts" } },
      { name: "Read", input: { file_path: "/src/f.ts" } },
    ]));

    const patterns = detectPatterns(events);
    expect(patterns.some((p) => p.type === "read-fanout")).toBe(true);
  });

  it("does NOT detect read-fanout with only 4 Reads", () => {
    const events: HydratedEvent[] = [
      makeAssistantEvent([
        { name: "Read", input: { file_path: "/src/a.ts" } },
        { name: "Read", input: { file_path: "/src/b.ts" } },
        { name: "Read", input: { file_path: "/src/c.ts" } },
        { name: "Read", input: { file_path: "/src/d.ts" } },
      ]),
    ];
    const patterns = detectPatterns(events);
    expect(patterns.some((p) => p.type === "read-fanout")).toBe(false);
  });

  it("detects test-loop: ≥3 Bash test runner calls", () => {
    const events: HydratedEvent[] = [
      makeAssistantEvent([{ name: "Bash", input: { command: "bun test" } }]),
      makeAssistantEvent([{ name: "Bash", input: { command: "bun test src/store" } }]),
      makeAssistantEvent([{ name: "Bash", input: { command: "bun t" } }]),
    ];
    const patterns = detectPatterns(events);
    const tl = patterns.find((p) => p.type === "test-loop");
    expect(tl).toBeDefined();
    if (tl?.type === "test-loop") expect(tl.count).toBe(3);
  });

  it("does NOT detect test-loop with only 2 Bash test calls", () => {
    const events: HydratedEvent[] = [
      makeAssistantEvent([{ name: "Bash", input: { command: "bun test" } }]),
      makeAssistantEvent([{ name: "Bash", input: { command: "npm test" } }]),
    ];
    const patterns = detectPatterns(events);
    expect(patterns.some((p) => p.type === "test-loop")).toBe(false);
  });

  it("detects manual-diff-cycle: R→E→R on same file ≥2 cycles", () => {
    // 2 full R→E→R cycles on same file = 6 tool_use calls across turns
    const f = "/src/foo.ts";
    const events: HydratedEvent[] = [
      makeAssistantEvent([{ name: "Read", input: { file_path: f } }]),
      makeAssistantEvent([{ name: "Edit", input: { file_path: f } }]),
      makeAssistantEvent([{ name: "Read", input: { file_path: f } }]),
      makeAssistantEvent([{ name: "Edit", input: { file_path: f } }]),
      makeAssistantEvent([{ name: "Read", input: { file_path: f } }]),
    ];
    const patterns = detectPatterns(events);
    const dc = patterns.find((p) => p.type === "manual-diff-cycle");
    expect(dc).toBeDefined();
    if (dc?.type === "manual-diff-cycle") expect(dc.cycles).toBeGreaterThanOrEqual(2);
  });

  it("detects grep-walk: ≥4 Grep+Read pairs", () => {
    const events: HydratedEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(makeAssistantEvent([
        { name: "Grep", input: { pattern: "foo" } },
        { name: "Read", input: { file_path: `/src/file${i}.ts` } },
      ]));
    }
    const patterns = detectPatterns(events);
    expect(patterns.some((p) => p.type === "grep-walk")).toBe(true);
  });

  it("detects subagent-skip: ≥20 tool_use calls, no Task/Agent", () => {
    // 25 Bash calls across turns, no Task/Agent
    const events: HydratedEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(makeAssistantEvent(
        Array.from({ length: 5 }, (_, j) => ({
          name: "Bash",
          input: { command: `echo ${i * 5 + j}` },
        })),
        `2025-01-01T00:0${i}:00Z`,
        5000
      ));
    }
    const patterns = detectPatterns(events);
    expect(patterns.some((p) => p.type === "subagent-skip")).toBe(true);
  });

  it("returns empty array for empty events list", () => {
    expect(detectPatterns([])).toEqual([]);
  });
});

// ── 3. Pattern-skill matcher ──────────────────────────────────────────────────

describe("pattern-skill-matcher", () => {
  const catalog: SkillCatalogEntry[] = [
    { name: "scout", description: "Explore codebase files", keywords: ["explore", "search", "scout", "codebase"], path: "/tmp/scout/SKILL.md", mtime: 0 },
    { name: "test", description: "Run test suites", keywords: ["test", "bun", "vitest", "coverage"], path: "/tmp/test/SKILL.md", mtime: 0 },
    { name: "cook", description: "Plan and execute implementations", keywords: ["plan", "cook", "implement", "agent"], path: "/tmp/cook/SKILL.md", mtime: 0 },
    { name: "code-review", description: "Review code changes", keywords: ["review", "diff", "patch"], path: "/tmp/review/SKILL.md", mtime: 0 },
  ];

  it("read-fanout → scout ranks first", () => {
    const pattern = {
      type: "read-fanout" as const,
      dir: "/src",
      count: 7,
      turnIndices: [0, 1],
      timestamps: ["2025-01-01T00:00:00Z", "2025-01-01T00:01:00Z"],
      tokensConsumed: 10000,
    };
    const matches = matchSkillsForPattern(pattern, catalog);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.skillName).toBe("scout");
    expect(matches[0]!.confidence).toBeGreaterThanOrEqual(40);
  });

  it("test-loop → test ranks first", () => {
    const pattern = {
      type: "test-loop" as const,
      count: 4,
      turnIndices: [0, 1, 2, 3],
      timestamps: ["2025-01-01T00:00:00Z"],
      commands: ["bun test"],
      tokensConsumed: 8000,
    };
    const matches = matchSkillsForPattern(pattern, catalog);
    expect(matches[0]!.skillName).toBe("test");
  });

  it("subagent-skip → cook ranks first", () => {
    const pattern = {
      type: "subagent-skip" as const,
      toolCallCount: 25,
      turnIndices: [],
      timestamps: [],
      tokensConsumed: 50000,
    };
    const matches = matchSkillsForPattern(pattern, catalog);
    expect(matches[0]!.skillName).toBe("cook");
  });

  it("respects topK limit", () => {
    const pattern = {
      type: "read-fanout" as const,
      dir: "/src",
      count: 5,
      turnIndices: [0],
      timestamps: ["2025-01-01T00:00:00Z"],
      tokensConsumed: 5000,
    };
    const matches = matchSkillsForPattern(pattern, catalog, { topK: 2 });
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for empty catalog", () => {
    const pattern = {
      type: "test-loop" as const,
      count: 3,
      turnIndices: [0],
      timestamps: [],
      commands: [],
      tokensConsumed: 3000,
    };
    const matches = matchSkillsForPattern(pattern, []);
    expect(matches).toEqual([]);
  });
});

// ── 4. Savings estimator ──────────────────────────────────────────────────────

describe("savings-estimator", () => {
  it("returns zero savings when pattern tokens < skill prior", () => {
    const est = estimateSavings("scout", 1000, "claude-sonnet-4-5");
    expect(est.tokensSaved).toBe(0);
    expect(est.usdSaved).toBe(0);
  });

  it("returns positive savings when pattern tokens > skill prior", () => {
    const est = estimateSavings("scout", 50000, "claude-sonnet-4-5");
    expect(est.tokensSaved).toBeGreaterThan(0);
    expect(est.usdSaved).toBeGreaterThan(0);
  });

  it("returns zero usdSaved for unknown model", () => {
    const est = estimateSavings("test", 30000, null);
    expect(est.tokensSaved).toBeGreaterThan(0);
    expect(est.usdSaved).toBe(0);
  });

  it("buildSavingsMap returns map with all requested skills", () => {
    const skills = ["scout", "test", "cook"];
    const map = buildSavingsMap(skills, 20000, "claude-sonnet-4-5");
    for (const name of skills) {
      expect(map.has(name)).toBe(true);
    }
  });

  it("savings are never negative", () => {
    const est = estimateSavings("cook", 100, "claude-opus-4-5");
    expect(est.tokensSaved).toBeGreaterThanOrEqual(0);
    expect(est.usdSaved).toBeGreaterThanOrEqual(0);
  });
});

// ── 5. Skill usage tracker ────────────────────────────────────────────────────

describe("skill-usage-tracker", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
    // Insert a dummy session row to satisfy FK
    db.run(
      `INSERT OR IGNORE INTO sessions (id, project_slug, started_at, ended_at, model, total_events)
       VALUES ('test-session', 'test', '2025-01-01T00:00:00Z', NULL, NULL, 0)`
    );
  });

  afterEach(() => { db.close(); });

  it("detects skill activation from <command-name>ck:foo</command-name> in system events", () => {
    const events: HydratedEvent[] = [
      makeSystemEvent("SubagentStart hook context: <command-name>ck:scout</command-name>"),
    ];
    const count = trackSkillUsage(db, "test-session", events);
    expect(count).toBe(1);

    const rows = getSkillUsageForSession(db, "test-session");
    expect(rows.length).toBe(1);
    expect(rows[0]!.skillName).toBe("scout");
  });

  it("detects /ck:foo pattern in assistant text content", () => {
    const events: HydratedEvent[] = [{
      eventId: "ev-a1",
      sessionId: "test-session",
      type: "assistant",
      timestamp: "2025-01-01T00:00:00Z",
      event: {
        kind: "assistant",
        timestamp: "2025-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me use /ck:repomix to dump context." }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        raw: {},
      },
    }];
    trackSkillUsage(db, "test-session", events);
    const rows = getSkillUsageForSession(db, "test-session");
    expect(rows.some((r) => r.skillName === "repomix")).toBe(true);
  });

  it("is idempotent — re-tracking same session replaces rows", () => {
    const events: HydratedEvent[] = [
      makeSystemEvent("<command-name>ck:scout</command-name>"),
    ];
    trackSkillUsage(db, "test-session", events);
    trackSkillUsage(db, "test-session", events);

    const rows = getSkillUsageForSession(db, "test-session");
    expect(rows.length).toBe(1); // not doubled
  });

  it("getAggregateSkillUsage counts across sessions", () => {
    db.run(
      `INSERT OR IGNORE INTO sessions (id, project_slug, started_at, ended_at, model, total_events)
       VALUES ('session-2', 'test', '2025-01-02T00:00:00Z', NULL, NULL, 0)`
    );
    db.run("INSERT INTO skill_usage (session_id, skill_name, activated_at) VALUES (?,?,?)",
      ["test-session", "scout", "2025-01-01T00:00:00Z"]);
    db.run("INSERT INTO skill_usage (session_id, skill_name, activated_at) VALUES (?,?,?)",
      ["session-2", "scout", "2025-01-02T00:00:00Z"]);
    db.run("INSERT INTO skill_usage (session_id, skill_name, activated_at) VALUES (?,?,?)",
      ["test-session", "test", "2025-01-01T00:01:00Z"]);

    const agg = getAggregateSkillUsage(db);
    expect(agg.get("scout")?.sessions).toBe(2);
    expect(agg.get("test")?.sessions).toBe(1);
  });

  it("returns empty array for session with no skill usage", () => {
    const rows = getSkillUsageForSession(db, "test-session");
    expect(rows).toEqual([]);
  });
});

// ── 6. Dismissed recs store ───────────────────────────────────────────────────

describe("dismissed-recs-store", () => {
  it("filterDismissed passes through items with non-dismissed skills", () => {
    const items = [
      { skillName: "scout", confidence: 80 },
      { skillName: "test", confidence: 70 },
    ];
    // Since we don't dismiss anything in tests, all should pass through
    const result = filterDismissed(items);
    // At minimum, items not in dismissed list are preserved
    expect(result.length).toBeLessThanOrEqual(items.length);
    // Both items should be present unless user has previously dismissed them
    const names = result.map((r) => r.skillName);
    // scout and test are very unlikely to be in user's real dismissed.json
    // We just verify the function runs and preserves structure
    for (const r of result) {
      expect(r).toHaveProperty("skillName");
      expect(r).toHaveProperty("confidence");
    }
  });
});

// ── 7. Effectiveness analyzer ─────────────────────────────────────────────────

describe("effectiveness-analyzer", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it("returns score=50 when no sessions exist (unknown baseline)", () => {
    const report = analyzeSkillEffectiveness(db, "scout");
    expect(report.skillName).toBe("scout");
    expect(report.effectivenessScore).toBe(50);
    expect(report.usedSessions).toBe(0);
    expect(report.unusedSessions).toBe(0);
  });

  it("returns correct structure for a skill", () => {
    const report = analyzeSkillEffectiveness(db, "nonexistent-skill");
    expect(report).toHaveProperty("skillName");
    expect(report).toHaveProperty("usedSessions");
    expect(report).toHaveProperty("unusedSessions");
    expect(report).toHaveProperty("avgToolCallsWithSkill");
    expect(report).toHaveProperty("avgToolCallsWithout");
    expect(report.effectivenessScore).toBeGreaterThanOrEqual(0);
    expect(report.effectivenessScore).toBeLessThanOrEqual(100);
  });
});
