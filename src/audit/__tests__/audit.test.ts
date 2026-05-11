/**
 * Phase 04 test suite: Session Change Manifest (audit views).
 *
 * Covers:
 *   1. Session loader  — event order, hydration, missing session error
 *   2. Change aggregator — Edit/Write/MultiEdit sequence on same file
 *   3. Reasoning correlator — tool call gets reason from preceding assistant text
 *   4. Subagent tracker — nested Agent() spans, parentMap tagging
 *   5. Diff formatter — known input/output pair, hunk structure, ANSI suppression
 *   6. Manifest builder — end-to-end pipeline on fixture session
 *   7. Markdown exporter — golden snapshot and structure assertions
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";

import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { ingestFile } from "../../store/ingest.ts";

import { loadSession, latestSessionId, listSessionIds } from "../session-loader.ts";
import { aggregateChanges } from "../change-aggregator.ts";
import { buildReasonMap, attachReasons } from "../reasoning-correlator.ts";
import { trackSubagents, attachParentAgentIds } from "../subagent-tracker.ts";
import { computeDiff, formatDiff } from "../diff-formatter.ts";
import { buildManifest } from "../manifest-builder.ts";
import { exportManifestMarkdown } from "../manifest-markdown-exporter.ts";

import type { HydratedEvent, FileChange } from "../manifest-types.ts";

// ── Fixtures path ─────────────────────────────────────────────────────────────

// fileURLToPath handles Win32 file URLs (e.g. file:///D:/...) which `.pathname`
// returns with a leading slash + forward separators — unusable by fs APIs.
const FIXTURES_DIR = fileURLToPath(new URL("../../parsers/__fixtures__/", import.meta.url));

// ── DB helper ─────────────────────────────────────────────────────────────────

function freshDb(): Database {
  const db = openDb(":memory:", { skipMmap: true });
  runMigrations(db);
  return db;
}

// ── JSONL line builders ───────────────────────────────────────────────────────

const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";

function userLine(uuid: string, ts: string, parentUuid: string | null = null): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    isSidechain: false,
    message: { role: "user", content: "user message" },
    timestamp: ts,
    sessionId: SESSION_ID,
    version: "2.0.0",
  });
}

function assistantTextLine(uuid: string, ts: string, text: string, parentUuid = ""): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    isSidechain: false,
    requestId: `req_${uuid.slice(0, 8)}`,
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      id: `msg_${uuid.slice(0, 8)}`,
      type: "message",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    timestamp: ts,
    sessionId: SESSION_ID,
    version: "2.0.0",
  });
}

function assistantToolLine(
  uuid: string,
  ts: string,
  toolName: string,
  toolId: string,
  input: Record<string, unknown>,
  parentUuid = ""
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    isSidechain: false,
    requestId: `req_${uuid.slice(0, 8)}`,
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      id: `msg_${uuid.slice(0, 8)}`,
      type: "message",
      content: [{ type: "tool_use", id: toolId, name: toolName, input }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    timestamp: ts,
    sessionId: SESSION_ID,
    version: "2.0.0",
  });
}

function assistantTextAndToolLine(
  uuid: string,
  ts: string,
  text: string,
  toolName: string,
  toolId: string,
  input: Record<string, unknown>,
  parentUuid = ""
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    isSidechain: false,
    requestId: `req_${uuid.slice(0, 8)}`,
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      id: `msg_${uuid.slice(0, 8)}`,
      type: "message",
      content: [
        { type: "text", text },
        { type: "tool_use", id: toolId, name: toolName, input },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    timestamp: ts,
    sessionId: SESSION_ID,
    version: "2.0.0",
  });
}

function toolResultLine(uuid: string, ts: string, toolUseId: string, content = "ok", parentUuid = ""): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: false }],
    },
    timestamp: ts,
    sessionId: SESSION_ID,
    version: "2.0.0",
  });
}

// ── Ingest helper ─────────────────────────────────────────────────────────────

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function ingestLines(db: Database, lines: string[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ckf-audit-test-"));
  const path = join(dir, "session.jsonl");
  try {
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
    await ingestFile(db, path, "test-project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 1. Session loader ─────────────────────────────────────────────────────────

describe("session-loader", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("loads events ordered by timestamp", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:03.000Z"),
      userLine("u-002", "2026-01-01T00:00:01.000Z"),
      userLine("u-003", "2026-01-01T00:00:02.000Z"),
    ];
    await ingestLines(db, lines);

    const sid = latestSessionId(db)!;
    const { events } = loadSession(db, sid);

    expect(events.length).toBe(3);
    // Must be ascending by timestamp
    const ts = events.map((e) => e.timestamp);
    expect(ts[0]!).toBe("2026-01-01T00:00:01.000Z");
    expect(ts[1]!).toBe("2026-01-01T00:00:02.000Z");
    expect(ts[2]!).toBe("2026-01-01T00:00:03.000Z");
  });

  it("hydrates raw_json into typed ParsedEvent", async () => {
    await ingestLines(db, [userLine("u-001", "2026-01-01T00:00:00.000Z")]);
    const sid = latestSessionId(db)!;
    const { events } = loadSession(db, sid);
    expect(events[0]!.event.kind).toBe("user");
  });

  it("throws on unknown session id", () => {
    expect(() => loadSession(db, "nonexistent-id")).toThrow("Session not found");
  });

  it("listSessionIds returns all sessions ordered newest first", async () => {
    const sid2 = "bbbbbbbb-2222-3333-4444-555555555555";
    const line1 = JSON.stringify({
      type: "user", uuid: "u-a", parentUuid: null, isSidechain: false,
      message: { role: "user", content: "hello" },
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: SESSION_ID, version: "2.0.0",
    });
    const line2 = JSON.stringify({
      type: "user", uuid: "u-b", parentUuid: null, isSidechain: false,
      message: { role: "user", content: "world" },
      timestamp: "2026-01-02T00:00:00.000Z",
      sessionId: sid2, version: "2.0.0",
    });

    await ingestLines(db, [line1]);
    // Ingest second session directly
    const dir = mkdtempSync(join(tmpdir(), "ckf-audit-s2-"));
    const path = join(dir, "s2.jsonl");
    try {
      writeFileSync(path, line2 + "\n", "utf-8");
      await ingestFile(db, path, "test-project");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const ids = listSessionIds(db);
    expect(ids.length).toBe(2);
    // Newest first: sid2 started 2026-01-02, SESSION_ID started 2026-01-01
    expect(ids[0]).toBe(sid2);
  });

  it("loads fixture sample-05 (contains 3 Edits)", async () => {
    const p = join(FIXTURES_DIR, "sample-05.jsonl");
    const result = await ingestFile(db, p, "fixture");
    expect(result.eventsInserted).toBeGreaterThan(0);

    const ids = listSessionIds(db);
    const { events } = loadSession(db, ids[0]!);
    expect(events.length).toBeGreaterThan(0);
  });
});

// ── 2. Change aggregator ──────────────────────────────────────────────────────

describe("change-aggregator", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("produces EditOp sequence for 3 edits on same file", async () => {
    const fp = "/tmp/test-file.ts";
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Write initial content
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Write", "tid-001",
        { file_path: fp, content: "line1\nline2\nline3\n" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "tid-001"),
      // Edit: replace line2
      assistantToolLine("a-002", "2026-01-01T00:00:03.000Z", "Edit", "tid-002",
        { file_path: fp, old_string: "line2", new_string: "LINE2" }),
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "tid-002"),
      // Edit: replace line3
      assistantToolLine("a-003", "2026-01-01T00:00:05.000Z", "Edit", "tid-003",
        { file_path: fp, old_string: "line3", new_string: "LINE3" }),
      toolResultLine("u-004", "2026-01-01T00:00:06.000Z", "tid-003"),
    ];
    await ingestLines(db, lines);

    const sid = latestSessionId(db)!;
    const { events } = loadSession(db, sid);
    const changes = aggregateChanges(events);

    const fc = changes.get(fp);
    expect(fc).toBeDefined();
    expect(fc!.ops.length).toBe(3);

    // First op: Write
    expect(fc!.ops[0]!.type).toBe("Write");
    expect(fc!.ops[0]!.after).toBe("line1\nline2\nline3\n");

    // Second op: Edit replacing line2
    expect(fc!.ops[1]!.type).toBe("Edit");
    expect(fc!.ops[1]!.after).toContain("LINE2");

    // Third op: Edit replacing line3
    expect(fc!.ops[2]!.type).toBe("Edit");
    expect(fc!.ops[2]!.after).toContain("LINE3");
  });

  it("marks file as new when Write has no prior state", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Write", "tid-001",
        { file_path: "/tmp/newfile.ts", content: "hello world\n" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "tid-001"),
    ];
    await ingestLines(db, lines);

    const sid = latestSessionId(db)!;
    const { events } = loadSession(db, sid);
    const changes = aggregateChanges(events);

    const fc = changes.get("/tmp/newfile.ts")!;
    expect(fc.isNew).toBe(true);
    expect(fc.ops[0]!.unknownBefore).toBe(true);
  });

  it("MultiEdit: applies ordered edits in sequence", async () => {
    const fp = "/tmp/multi.ts";
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Write", "tid-000",
        { file_path: fp, content: "aaa\nbbb\nccc\n" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "tid-000"),
      assistantToolLine("a-002", "2026-01-01T00:00:03.000Z", "MultiEdit", "tid-001",
        {
          file_path: fp,
          edits: [
            { old_string: "aaa", new_string: "AAA" },
            { old_string: "bbb", new_string: "BBB" },
          ],
        }),
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "tid-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const changes = aggregateChanges(events);
    const fc = changes.get(fp)!;
    const multiOp = fc.ops.find((o) => o.type === "MultiEdit")!;

    expect(multiOp.after).toContain("AAA");
    expect(multiOp.after).toContain("BBB");
    expect(multiOp.after).toContain("ccc"); // untouched
  });

  it("accumulates linesAdded / linesRemoved", async () => {
    const fp = "/tmp/delta.ts";
    // Start with an Edit (file already existed with known content) then another Edit
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Write establishes the file with 3 lines (before = undefined → 0 lines)
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Write", "tid-001",
        { file_path: fp, content: "a\nb\nc\n" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "tid-001"),
      // Second Write adds 2 more lines (before = 3 lines, after = 5 lines)
      assistantToolLine("a-002", "2026-01-01T00:00:03.000Z", "Write", "tid-002",
        { file_path: fp, content: "a\nb\nc\nd\ne\n" }),
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "tid-002"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const changes = aggregateChanges(events);
    const fc = changes.get(fp)!;

    // Net: first op before=undefined(0 lines) → last op after=5 lines = +5
    // This is the correct net delta from no state to final state (new file)
    expect(fc.linesAdded).toBe(5);
    expect(fc.linesRemoved).toBe(0);
  });

  it("linesRemoved correctly computed for edit that shrinks file", async () => {
    const fp = "/tmp/shrink.ts";
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Edit an existing file: before has 5 lines, after has 3
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Edit", "tid-001",
        { file_path: fp, old_string: "d\ne", new_string: "" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "tid-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    // Prime the aggregator with known before content via a Write first
    // Since there's no prior Write, unknownBefore=true and before="d\ne"
    const changes = aggregateChanges(events);
    const fc = changes.get(fp)!;
    // before = old_string = "d\ne" (2 lines), after = "" (0 lines)
    // The aggregator falls back: before = old_string when no lastContent
    expect(fc.linesRemoved).toBeGreaterThan(0);
  });
});

// ── 3. Reasoning correlator ───────────────────────────────────────────────────

describe("reasoning-correlator", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("attaches preceding assistant text as reason for tool call", async () => {
    const fp = "/tmp/reason-test.ts";
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Text then tool in same assistant event
      assistantTextAndToolLine(
        "a-001", "2026-01-01T00:00:01.000Z",
        "I will now write the implementation.",
        "Write", "tid-001",
        { file_path: fp, content: "export const x = 1;\n" }
      ),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "tid-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const changes = aggregateChanges(events);
    const reasonMap = buildReasonMap(events);
    attachReasons(changes, reasonMap);

    const fc = changes.get(fp)!;
    expect(fc.ops[0]!.reason).toBe("I will now write the implementation.");
  });

  it("resets reason buffer at user turn boundary", async () => {
    const fp = "/tmp/boundary.ts";
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // First assistant text (turn 1)
      assistantTextLine("a-001", "2026-01-01T00:00:01.000Z", "First reason"),
      // User message — resets turn
      userLine("u-002", "2026-01-01T00:00:02.000Z", "u-001"),
      // Tool call in turn 2 — no text before it in this turn
      assistantToolLine("a-002", "2026-01-01T00:00:03.000Z", "Write", "tid-001",
        { file_path: fp, content: "content\n" }),
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "tid-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const changes = aggregateChanges(events);
    const reasonMap = buildReasonMap(events);
    attachReasons(changes, reasonMap);

    const fc = changes.get(fp)!;
    // No text in turn 2 before the tool call → no reason
    expect(fc.ops[0]!.reason).toBeUndefined();
  });

  it("uses most recent text when multiple text blocks precede tool", async () => {
    const fp = "/tmp/multi-text.ts";
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantTextLine("a-001", "2026-01-01T00:00:01.000Z", "First thought"),
      assistantTextAndToolLine(
        "a-002", "2026-01-01T00:00:02.000Z",
        "Final decision",
        "Write", "tid-001",
        { file_path: fp, content: "hello\n" }
      ),
      toolResultLine("u-002", "2026-01-01T00:00:03.000Z", "tid-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const changes = aggregateChanges(events);
    const reasonMap = buildReasonMap(events);
    attachReasons(changes, reasonMap);

    const fc = changes.get(fp)!;
    expect(fc.ops[0]!.reason).toBe("Final decision");
  });
});

// ── 4. Subagent tracker ───────────────────────────────────────────────────────

describe("subagent-tracker", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("detects a single Task span open/close", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-001",
        { description: "Do something useful" }),
      toolResultLine("u-002", "2026-01-01T00:00:05.000Z", "task-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);

    expect(spans.length).toBe(1);
    expect(spans[0]!.toolName).toBe("Task");
    expect(spans[0]!.id).toBe("task-001");
    expect(spans[0]!.closedAt).toBeDefined();
    expect(spans[0]!.depth).toBe(0);
    expect(spans[0]!.parentId).toBeNull();
  });

  it("handles nested Agent inside Task (depth=1)", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Outer Task
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-outer",
        { description: "Outer task" }),
      // Inner Agent (nested)
      assistantToolLine("a-002", "2026-01-01T00:00:02.000Z", "Agent", "agent-inner",
        { description: "Inner agent" }),
      // Close inner
      toolResultLine("u-002", "2026-01-01T00:00:03.000Z", "agent-inner"),
      // Close outer
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "task-outer"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);

    expect(spans.length).toBe(2);
    const outer = spans.find((s) => s.id === "task-outer")!;
    const inner = spans.find((s) => s.id === "agent-inner")!;

    expect(outer.depth).toBe(0);
    expect(outer.parentId).toBeNull();
    expect(inner.depth).toBe(1);
    expect(inner.parentId).toBe("task-outer");
  });

  it("handles 5-level deep nesting", async () => {
    const ids = ["t1", "t2", "t3", "t4", "t5"];
    const lines: string[] = [userLine("u-001", "2026-01-01T00:00:00.000Z")];
    let ts = 1;

    // Open 5 nested spans
    for (const id of ids) {
      lines.push(assistantToolLine(
        `a-${id}`, `2026-01-01T00:00:0${ts++}.000Z`, "Task", id, { description: `Level ${ts}` }
      ));
    }
    // Close all 5 in reverse order
    for (const id of [...ids].reverse()) {
      lines.push(toolResultLine(`u-${id}`, `2026-01-01T00:00:${10 + ts++}.000Z`, id));
    }

    await ingestLines(db, lines);
    const { events } = loadSession(db, latestSessionId(db)!);
    const { spans } = trackSubagents(events);

    expect(spans.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(spans[i]!.depth).toBe(i);
    }
    // All spans closed
    for (const s of spans) {
      expect(s.closedAt).toBeDefined();
    }
  });

  it("attachParentAgentIds tags EditOps inside a Task span", async () => {
    const fp = "/tmp/subagent-file.ts";
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      // Open Task
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-001",
        { description: "Write a file" }),
      // Edit inside Task span
      assistantToolLine("a-002", "2026-01-01T00:00:02.000Z", "Write", "write-001",
        { file_path: fp, content: "nested content\n" }),
      toolResultLine("u-002", "2026-01-01T00:00:03.000Z", "write-001"),
      // Close Task
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "task-001"),
    ];
    await ingestLines(db, lines);

    const { events } = loadSession(db, latestSessionId(db)!);
    const changes = aggregateChanges(events);
    const { parentMap } = trackSubagents(events);
    attachParentAgentIds(changes, parentMap);

    const fc = changes.get(fp)!;
    // The Write op's eventId should be tagged with task-001
    expect(fc.ops[0]!.parentAgentId).toBe("task-001");
  });
});

// ── 5. Diff formatter ─────────────────────────────────────────────────────────

describe("diff-formatter", () => {
  it("produces no diff for identical strings", () => {
    const lines = computeDiff("hello\nworld\n", "hello\nworld\n");
    const changed = lines.filter((l) => l.type !== "context");
    expect(changed.length).toBe(0);
  });

  it("produces correct add/remove lines for simple change", () => {
    const lines = computeDiff("foo\nbar\n", "foo\nbaz\n");
    const removes = lines.filter((l) => l.type === "remove");
    const adds = lines.filter((l) => l.type === "add");
    expect(removes.length).toBe(1);
    expect(removes[0]!.content).toBe("-bar");
    expect(adds.length).toBe(1);
    expect(adds[0]!.content).toBe("+baz");
  });

  it("handles empty before (new file)", () => {
    const lines = computeDiff("", "line1\nline2\n");
    const adds = lines.filter((l) => l.type === "add");
    expect(adds.length).toBe(2);
  });

  it("handles empty after (deleted content)", () => {
    const lines = computeDiff("a\nb\nc\n", "");
    const removes = lines.filter((l) => l.type === "remove");
    expect(removes.length).toBe(3);
  });

  it("formatDiff produces plain text with no ANSI codes when plain=true", () => {
    const out = formatDiff("old line\n", "new line\n", { plain: true });
    // No ANSI escape sequences
    expect(out).not.toContain("\x1b[");
    // Contains unified diff markers
    expect(out).toContain("-old line");
    expect(out).toContain("+new line");
  });

  it("formatDiff includes @@ hunk headers", () => {
    const out = formatDiff("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n", { plain: true });
    expect(out).toContain("@@");
  });

  it("golden test: known before/after produces expected unified diff", () => {
    const before = "line1\nline2\nline3\n";
    const after  = "line1\nLINE2\nline3\n";
    const out = formatDiff(before, after, { plain: true });

    // Should contain the change
    expect(out).toContain("-line2");
    expect(out).toContain("+LINE2");
    // Context lines present
    expect(out).toContain(" line1");
    expect(out).toContain(" line3");
    // No ANSI
    expect(out).not.toContain("\x1b[");
  });

  it("respects context option to limit surrounding lines", () => {
    // 10 context lines, 1 change in middle — with context=1, should only show 1 surrounding line
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n") + "\n";
    const changed = lines.replace("line5", "LINE5");
    const out = formatDiff(lines, changed, { plain: true, context: 1 });

    // Should NOT include line1 (too far from change at line5)
    expect(out).not.toContain(" line1");
    // Should include line4 (adjacent)
    expect(out).toContain(" line4");
  });
});

// ── 6. Manifest builder (end-to-end) ─────────────────────────────────────────

describe("manifest-builder", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  it("builds manifest end-to-end from fixture sample-05 (Edit events)", async () => {
    const p = join(FIXTURES_DIR, "sample-05.jsonl");
    await ingestFile(db, p, "fixture");

    const sid = latestSessionId(db)!;
    const manifest = buildManifest(db, sid);

    expect(manifest.session.id).toBe(sid);
    expect(manifest.events.length).toBeGreaterThan(0);
    expect(manifest.fileChanges).toBeInstanceOf(Map);
    expect(manifest.subagentSpans).toBeInstanceOf(Array);
    expect(typeof manifest.tokenTotals.input).toBe("number");
    expect(manifest.tokenTotals.input).toBeGreaterThan(0);
  });

  it("builds manifest from fixture sample-04 (Write event)", async () => {
    const p = join(FIXTURES_DIR, "sample-04.jsonl");
    await ingestFile(db, p, "fixture");

    const sid = latestSessionId(db)!;
    const manifest = buildManifest(db, sid);

    // sample-04 has 1 Write tool call → 1 file change
    expect(manifest.fileChanges.size).toBeGreaterThanOrEqual(1);
  });

  it("throws for non-existent session", () => {
    expect(() => buildManifest(db, "does-not-exist")).toThrow("Session not found");
  });

  it("manifest from synthetic session has correct file change count", async () => {
    const files = ["/tmp/f1.ts", "/tmp/f2.ts"];
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Write", "w-001",
        { file_path: files[0], content: "file1\n" }),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "w-001"),
      assistantToolLine("a-002", "2026-01-01T00:00:03.000Z", "Write", "w-002",
        { file_path: files[1], content: "file2\n" }),
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "w-002"),
    ];
    await ingestLines(db, lines);

    const manifest = buildManifest(db, latestSessionId(db)!);
    expect(manifest.fileChanges.size).toBe(2);
  });

  it("estimatedCostUsd is non-null for opus model", async () => {
    await ingestLines(db, [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantTextLine("a-001", "2026-01-01T00:00:01.000Z", "hello"),
    ]);

    const manifest = buildManifest(db, latestSessionId(db)!);
    // model is claude-opus-4-6 from our line builders
    expect(manifest.estimatedCostUsd).not.toBeNull();
    expect(manifest.estimatedCostUsd).toBeGreaterThan(0);
  });
});

// ── 7. Markdown exporter ──────────────────────────────────────────────────────

describe("manifest-markdown-exporter", () => {
  let db: Database;

  beforeEach(() => { db = freshDb(); });
  afterEach(() => closeDb(db));

  async function buildTestManifest() {
    const fp = "/tmp/export-test.ts";
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantTextAndToolLine(
        "a-001", "2026-01-01T00:00:01.000Z",
        "Writing the initial implementation",
        "Write", "w-001",
        { file_path: fp, content: "export const x = 1;\nexport const y = 2;\n" }
      ),
      toolResultLine("u-002", "2026-01-01T00:00:02.000Z", "w-001"),
      assistantTextAndToolLine(
        "a-002", "2026-01-01T00:00:03.000Z",
        "Fixing the value",
        "Edit", "e-001",
        { file_path: fp, old_string: "const y = 2", new_string: "const y = 42" }
      ),
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "e-001"),
    ];
    await ingestLines(db, lines);
    return buildManifest(db, latestSessionId(db)!);
  }

  it("output contains required markdown sections", async () => {
    const manifest = await buildTestManifest();
    const md = exportManifestMarkdown(manifest);

    expect(md).toContain("# Session Change Manifest");
    expect(md).toContain("## Summary");
    expect(md).toContain("## File Changes");
    expect(md).toContain("---");
  });

  it("output contains session id in header table", async () => {
    const manifest = await buildTestManifest();
    const md = exportManifestMarkdown(manifest);
    expect(md).toContain(manifest.session.id);
  });

  it("output contains file path", async () => {
    const manifest = await buildTestManifest();
    const md = exportManifestMarkdown(manifest);
    expect(md).toContain("/tmp/export-test.ts");
  });

  it("output contains reasoning quotes", async () => {
    const manifest = await buildTestManifest();
    const md = exportManifestMarkdown(manifest);
    expect(md).toContain("Writing the initial implementation");
    expect(md).toContain("Fixing the value");
  });

  it("output contains diff blocks for file changes", async () => {
    const manifest = await buildTestManifest();
    const md = exportManifestMarkdown(manifest);
    // Diffs are in fenced ```diff blocks
    expect(md).toContain("```diff");
  });

  it("output has no ANSI escape codes (safe for GitHub)", async () => {
    const manifest = await buildTestManifest();
    const md = exportManifestMarkdown(manifest);
    expect(md).not.toContain("\x1b[");
  });

  it("snapshot: output structure is stable across runs", async () => {
    const manifest = await buildTestManifest();
    const md1 = exportManifestMarkdown(manifest);
    const md2 = exportManifestMarkdown(manifest);
    // Deterministic: same manifest → same output
    expect(md1).toBe(md2);
  });

  it("subagent section appears when spans exist", async () => {
    const lines = [
      userLine("u-001", "2026-01-01T00:00:00.000Z"),
      assistantToolLine("a-001", "2026-01-01T00:00:01.000Z", "Task", "task-001",
        { description: "Delegate to subagent" }),
      assistantToolLine("a-002", "2026-01-01T00:00:02.000Z", "Write", "w-001",
        { file_path: "/tmp/sub.ts", content: "sub content\n" }),
      toolResultLine("u-002", "2026-01-01T00:00:03.000Z", "w-001"),
      toolResultLine("u-003", "2026-01-01T00:00:04.000Z", "task-001"),
    ];
    await ingestLines(db, lines);

    const manifest = buildManifest(db, latestSessionId(db)!);
    const md = exportManifestMarkdown(manifest);

    expect(md).toContain("## Subagent Dispatches");
    expect(md).toContain("Task");
  });

  it("emits security warning footer", async () => {
    const manifest = await buildTestManifest();
    const md = exportManifestMarkdown(manifest);
    expect(md).toContain("sensitive information");
    expect(md).toContain("ckforensics");
  });
});
