/**
 * Tests for subagent cost attribution (subagent-cost.ts).
 *
 * Covers:
 *   1. Single subagent span — correct cost computed from events in window
 *   2. Nested subagent (parent + child) — tree structure, gross totals
 *   3. No subagents → empty array
 *   4. Manifest builder includes subagentCosts field
 *   5. Markdown exporter renders cost breakdown section
 *   6. Real fixture session — subagentCosts populated when Agent calls present
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { ingestFile } from "../../store/ingest.ts";

import { loadSession, latestSessionId } from "../session-loader.ts";
import { trackSubagents } from "../subagent-tracker.ts";
import { computeSubagentCosts } from "../subagent-cost.ts";
import { buildManifest } from "../manifest-builder.ts";
import { exportManifestMarkdown } from "../manifest-markdown-exporter.ts";

// ── DB helper ─────────────────────────────────────────────────────────────────

function freshDb(): Database {
  const db = openDb(":memory:", { skipMmap: true });
  runMigrations(db);
  return db;
}

// ── JSONL line builders ───────────────────────────────────────────────────────

const SESSION_ID = "cccccccc-3333-4444-5555-666666666666";

function userLine(uuid: string, ts: string): string {
  return JSON.stringify({
    type: "user", uuid, parentUuid: null, isSidechain: false,
    message: { role: "user", content: "user message" },
    timestamp: ts, sessionId: SESSION_ID, version: "2.0.0",
  });
}

function assistantToolLine(
  uuid: string, ts: string, toolName: string, toolId: string,
  input: Record<string, unknown>,
  inputTokens = 100, outputTokens = 50
): string {
  return JSON.stringify({
    type: "assistant", uuid, parentUuid: "", isSidechain: false,
    requestId: `req_${uuid}`,
    message: {
      role: "assistant", model: "claude-sonnet-4-6",
      id: `msg_${uuid}`, type: "message",
      content: [{ type: "tool_use", id: toolId, name: toolName, input }],
      stop_reason: "tool_use", stop_sequence: null,
      usage: {
        input_tokens: inputTokens, output_tokens: outputTokens,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
    },
    timestamp: ts, sessionId: SESSION_ID, version: "2.0.0",
  });
}

function toolResultLine(uuid: string, ts: string, toolUseId: string): string {
  return JSON.stringify({
    type: "user", uuid, parentUuid: "", isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok", is_error: false }],
    },
    timestamp: ts, sessionId: SESSION_ID, version: "2.0.0",
  });
}

// ── Ingest helper ─────────────────────────────────────────────────────────────

async function ingestLines(db: Database, lines: string[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ckf-cost-test-"));
  const path = join(dir, "session.jsonl");
  try {
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
    await ingestFile(db, path, "test-project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 1. Single subagent span ───────────────────────────────────────────────────

describe("computeSubagentCosts - single span", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("returns one node with correct token totals and cost", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Open Task span — assistant event with 100 input, 50 output tokens
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-001",
        { description: "Do research" }, 100, 50),
      // Another assistant event inside span — 200 input, 80 output
      assistantToolLine("a-002", "2026-01-01T00:00:02.000Z", "Write", "w-001",
        { file_path: "/tmp/x.ts", content: "x" }, 200, 80),
      toolResultLine("u-002", "2026-01-01T00:00:03.000Z", "w-001"),
      // Close Task span
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "task-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);
    const nodes = computeSubagentCosts(events, spans, "claude-sonnet-4-6");

    expect(nodes.length).toBe(1);
    const node = nodes[0]!;

    expect(node.toolUseId).toBe("task-001");
    expect(node.subagentType).toBe("Task");
    expect(node.description).toContain("Do research");
    // Gross: 100+200=300 input, 50+80=130 output
    expect(node.tokens.input).toBe(300);
    expect(node.tokens.output).toBe(130);
    // Cost should be non-null (sonnet model known)
    expect(node.costUsd).not.toBeNull();
    expect(node.costUsd).toBeGreaterThan(0);
    // Duration: 4000ms - 1000ms = 3000ms
    expect(node.durationMs).toBe(3000);
    // 2 tool_use blocks inside (Task tool_use + Write tool_use)
    expect(node.childToolCalls).toBe(2);
    // No children
    expect(node.children.length).toBe(0);
  });

  it("returns null costUsd for unknown model", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-001",
        { description: "test" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "task-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);
    const nodes = computeSubagentCosts(events, spans, "unknown-model-xyz");

    expect(nodes[0]!.costUsd).toBeNull();
  });

  it("endedAt is null for unclosed span", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Task opened but never closed
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-open",
        { description: "never closed" }),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);
    const nodes = computeSubagentCosts(events, spans, "claude-sonnet-4-6");

    expect(nodes.length).toBe(1);
    expect(nodes[0]!.endedAt).toBeNull();
    expect(nodes[0]!.durationMs).toBeNull();
  });
});

// ── 2. Nested subagent (parent + child) ──────────────────────────────────────

describe("computeSubagentCosts - nested spans", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("builds tree with parent and child nodes", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Parent Task opens
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-parent",
        { description: "parent task" }, 500, 200),
      // Child Agent opens inside parent
      assistantToolLine("a-002", "2026-01-01T00:00:02.000Z", "Agent", "agent-child",
        { description: "child agent" }, 100, 40),
      // Close child
      toolResultLine("u-002", "2026-01-01T00:00:03.000Z", "agent-child"),
      // Close parent
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "task-parent"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);

    expect(spans.length).toBe(2);

    const nodes = computeSubagentCosts(events, spans, "claude-sonnet-4-6");

    // Only 1 top-level node
    expect(nodes.length).toBe(1);
    const parent = nodes[0]!;

    expect(parent.toolUseId).toBe("task-parent");
    expect(parent.children.length).toBe(1);

    const child = parent.children[0]!;
    expect(child.toolUseId).toBe("agent-child");
    expect(child.subagentType).toBe("Agent");
    expect(child.children.length).toBe(0);

    // Gross: parent window has BOTH assistant events (500+100=600 input, 200+40=240 output)
    expect(parent.tokens.input).toBe(600);
    expect(parent.tokens.output).toBe(240);

    // Child window has only child's event (100 input, 40 output)
    expect(child.tokens.input).toBe(100);
    expect(child.tokens.output).toBe(40);

    // Parent cost > child cost (gross includes child tokens)
    expect(parent.costUsd!).toBeGreaterThan(child.costUsd!);
  });

  it("children sorted by cost DESC", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Parent
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-parent",
        { description: "parent" }, 1000, 500),
      // First child — small
      assistantToolLine("a-002", "2026-01-01T00:00:02.000Z", "Agent", "agent-small",
        { description: "small child" }, 10, 5),
      toolResultLine("u-002", "2026-01-01T00:00:03.000Z", "agent-small"),
      // Second child — large
      assistantToolLine("a-003", "2026-01-01T00:00:04.000Z", "Agent", "agent-large",
        { description: "large child" }, 800, 400),
      toolResultLine("u-003", "2026-01-01T00:00:05.000Z", "agent-large"),
      // Close parent
      toolResultLine("u-004", "2026-01-01T00:00:06.000Z", "task-parent"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);
    const nodes = computeSubagentCosts(events, spans, "claude-sonnet-4-6");

    const children = nodes[0]!.children;
    expect(children.length).toBe(2);
    // large child (agent-large) should come first
    expect(children[0]!.toolUseId).toBe("agent-large");
    expect(children[1]!.toolUseId).toBe("agent-small");
  });
});

// ── 3. No subagents ───────────────────────────────────────────────────────────

describe("computeSubagentCosts - edge cases", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("returns empty array when no spans", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Write", "w-001",
        { file_path: "/tmp/f.ts", content: "x" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "w-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);
    const nodes = computeSubagentCosts(events, spans, "claude-sonnet-4-6");

    expect(nodes).toEqual([]);
  });
});

// ── 4. Manifest builder integration ──────────────────────────────────────────

describe("manifest-builder - subagentCosts integration", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("manifest includes subagentCosts array", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-001",
        { description: "test task" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "task-001"),
    ];
    await ingestLines(db, lines);

    const manifest = buildManifest(db, latestSessionId(db)!);

    expect(manifest.subagentCosts).toBeDefined();
    expect(Array.isArray(manifest.subagentCosts)).toBe(true);
    expect(manifest.subagentCosts!.length).toBe(1);
    expect(manifest.subagentCosts![0]!.toolUseId).toBe("task-001");
  });

  it("manifest subagentCosts is empty array when no subagents", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Write", "w-001",
        { file_path: "/tmp/x.ts", content: "x" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "w-001"),
    ];
    await ingestLines(db, lines);

    const manifest = buildManifest(db, latestSessionId(db)!);

    expect(manifest.subagentCosts).toEqual([]);
  });
});

// ── 5. Markdown exporter ──────────────────────────────────────────────────────

describe("manifest-markdown-exporter - subagent cost section", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("renders Subagent Cost Breakdown section when subagentCosts present", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-001",
        { description: "research task" }, 70_000, 10_000),
      toolResultLine("u-002", "2026-01-01T00:00:05.000Z", "task-001"),
    ];
    await ingestLines(db, lines);

    const manifest = buildManifest(db, latestSessionId(db)!);
    const md = exportManifestMarkdown(manifest);

    expect(md).toContain("## Subagent Cost Breakdown");
    expect(md).toContain("Task");
    expect(md).toContain("research task");
    // Cost table headers
    expect(md).toContain("| Subagent |");
    expect(md).toContain("| Cost |");
  });

  it("does NOT render cost section when no subagents", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Write", "w-001",
        { file_path: "/tmp/x.ts", content: "x" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "w-001"),
    ];
    await ingestLines(db, lines);

    const manifest = buildManifest(db, latestSessionId(db)!);
    const md = exportManifestMarkdown(manifest);

    expect(md).not.toContain("## Subagent Cost Breakdown");
  });

  it("renders nested child with └── indent marker", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-parent",
        { description: "parent task" }, 500, 200),
      assistantToolLine("a-002", "2026-01-01T00:00:02.000Z", "Agent", "agent-child",
        { description: "child agent" }, 100, 40),
      toolResultLine("u-002", "2026-01-01T00:00:03.000Z", "agent-child"),
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "task-parent"),
    ];
    await ingestLines(db, lines);

    const manifest = buildManifest(db, latestSessionId(db)!);
    const md = exportManifestMarkdown(manifest);

    expect(md).toContain("## Subagent Cost Breakdown");
    expect(md).toContain("└──");
    expect(md).toContain("Agent");
    expect(md).toContain("child agent");
  });

  it("shows token count in k format for large spans", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-001",
        { description: "big task" }, 50_000, 20_000),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "task-001"),
    ];
    await ingestLines(db, lines);

    const manifest = buildManifest(db, latestSessionId(db)!);
    const md = exportManifestMarkdown(manifest);

    // 50k + 20k = 70k tokens → should show "70k"
    expect(md).toContain("70k");
  });
});

// ── 6. Real fixture session ───────────────────────────────────────────────────

describe("subagentCosts with real fixture files", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("sample-05 fixture produces valid manifest with subagentCosts defined", async () => {
    // fileURLToPath handles Win32 file URLs (file:///D:/...) which `.pathname`
    // returns with a leading slash + forward separators — unusable by fs APIs.
    const p = fileURLToPath(new URL("../../parsers/__fixtures__/sample-05.jsonl", import.meta.url));
    await ingestFile(db, p, "fixture");

    const manifest = buildManifest(db, latestSessionId(db)!);

    // subagentCosts must always be defined (even if empty)
    expect(manifest.subagentCosts).toBeDefined();
    expect(Array.isArray(manifest.subagentCosts)).toBe(true);

    // Markdown export should not throw
    const md = exportManifestMarkdown(manifest);
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });
});
