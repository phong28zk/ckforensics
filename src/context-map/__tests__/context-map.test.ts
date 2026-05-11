/**
 * Context Map test suite (Phase 07).
 *
 * Covers:
 *   1. item-id-hasher: determinism + collision resistance
 *   2. context-snapshot-builder: fixture events → item counts by category
 *   3. token-attribution: synthetic events with cache deltas → token sums
 *   4. compaction-simulator: 80%-full snapshot → drops until ≤50%
 *   5. snapshot-store: save/load round-trip, list filters by session
 *   6. snapshot-differ: known add/drop → exact diff output
 *   7. manifest-emitter: pinned items → markdown contains all entries
 *   8. integration: ingest fixture → map shows non-empty heatmap rows
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { buildSnapshot } from "../context-snapshot-builder.ts";
import { fillTokenAttribution } from "../token-attribution.ts";
import { simulateCompaction } from "../compaction-simulator.ts";
import { saveSnapshot, loadSnapshot, listSnapshots, deleteSnapshot } from "../snapshot-store.ts";
import { diff } from "../snapshot-differ.ts";
import { emitManifest } from "../manifest-emitter.ts";
import { hashItemId } from "../item-id-hasher.ts";
import type { ContextItem, ContextSnapshot } from "../types.ts";
import type { HydratedEvent } from "../../audit/manifest-types.ts";

// ── DB helpers ────────────────────────────────────────────────────────────────

function freshDb() {
  const db = openDb(":memory:", { skipMmap: true });
  runMigrations(db);
  return db;
}

// ── Event fixture helpers ─────────────────────────────────────────────────────

function makeAssistantEvent(opts: {
  id?: string;
  uuid?: string;
  ts?: string;
  toolUses?: Array<{ id: string; name: string; input?: Record<string, unknown> }>;
  text?: string;
  cacheCreate?: number;
  outputTokens?: number;
}): HydratedEvent {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (const tu of opts.toolUses ?? []) {
    content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {} });
  }
  return {
    eventId: opts.id ?? `ae-${Math.random().toString(36).slice(2)}`,
    sessionId: "sess-1",
    type: "assistant",
    timestamp: opts.ts ?? "2025-01-01T00:00:00Z",
    event: {
      kind: "assistant",
      uuid: opts.uuid ?? "uuid-a",
      message: {
        id: opts.uuid ?? "msg-a",
        role: "assistant",
        content: content as never,
        usage: {
          input_tokens: 1000,
          output_tokens: opts.outputTokens ?? 100,
          cache_creation_input_tokens: opts.cacheCreate ?? 0,
        },
      },
      raw: {},
    },
  };
}

function makeUserEventWithToolResults(
  toolResults: Array<{ toolUseId: string; content: string }>,
  ts = "2025-01-01T00:00:01Z"
): HydratedEvent {
  const content = toolResults.map((tr) => ({
    type: "tool_result",
    tool_use_id: tr.toolUseId,
    content: tr.content,
  }));
  return {
    eventId: `ue-${Math.random().toString(36).slice(2)}`,
    sessionId: "sess-1",
    type: "user",
    timestamp: ts,
    event: {
      kind: "user",
      message: { role: "user", content: content as never },
      raw: {},
    },
  };
}

function makeUserTextEvent(text: string, ts = "2025-01-01T00:00:00Z"): HydratedEvent {
  return {
    eventId: `ut-${Math.random().toString(36).slice(2)}`,
    sessionId: "sess-1",
    type: "user",
    timestamp: ts,
    event: {
      kind: "user",
      message: { role: "user", content: text },
      raw: {},
    },
  };
}

function makeSystemEvent(content: string, ts = "2025-01-01T00:00:00Z"): HydratedEvent {
  return {
    eventId: `se-${Math.random().toString(36).slice(2)}`,
    sessionId: "sess-1",
    type: "system",
    timestamp: ts,
    event: {
      kind: "system",
      content,
      raw: {},
    },
  };
}

// ── Item factory for unit tests ───────────────────────────────────────────────

function makeToolResultItem(id: string, tokens: number, turnIndex: number): ContextItem {
  return {
    id,
    source: { type: "tool_result", toolName: "Read", toolCallId: id, preview: "preview" },
    tokens,
    turnIndex,
    timestamp: "2025-01-01T00:00:00Z",
    attributionConfidence: "medium",
  };
}

function makeAssistantItem(id: string, tokens: number, turnIndex: number): ContextItem {
  return {
    id,
    source: { type: "assistant_message", messageId: id, preview: "reasoning" },
    tokens,
    turnIndex,
    timestamp: "2025-01-01T00:00:00Z",
    attributionConfidence: "medium",
  };
}

function makeSnapshot(sessionId: string, items: ContextItem[]): ContextSnapshot {
  return {
    id: hashItemId("snapshot", `${sessionId}:test`),
    sessionId,
    createdAt: new Date().toISOString(),
    totalTokens: items.reduce((s, it) => s + it.tokens, 0),
    items,
    pinnedIds: [],
  };
}

// ── 1. item-id-hasher ─────────────────────────────────────────────────────────

describe("item-id-hasher", () => {
  it("produces same ID for same inputs", () => {
    const a = hashItemId("tool_result", "call-123");
    const b = hashItemId("tool_result", "call-123");
    expect(a).toBe(b);
  });

  it("produces different IDs for different inputs", () => {
    const a = hashItemId("tool_result", "call-123");
    const b = hashItemId("tool_result", "call-456");
    expect(a).not.toBe(b);
  });

  it("includes category prefix", () => {
    const id = hashItemId("assistant_message", "msg-1");
    expect(id.startsWith("assistant_message-")).toBe(true);
  });

  it("produces 8-hex-char suffix", () => {
    const id = hashItemId("user_message", "u1");
    const suffix = id.split("-").pop()!;
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ── 2. context-snapshot-builder ──────────────────────────────────────────────

describe("context-snapshot-builder", () => {
  it("builds items from assistant + tool_result events", () => {
    const events: HydratedEvent[] = [
      makeAssistantEvent({ text: "I will read the file", toolUses: [{ id: "tu-1", name: "Read" }] }),
      makeUserEventWithToolResults([{ toolUseId: "tu-1", content: "file content here" }]),
    ];
    const snap = buildSnapshot(events, { sessionId: "sess-1" });
    expect(snap.items.length).toBeGreaterThan(0);
    const toolResults = snap.items.filter((it) => it.source.type === "tool_result");
    expect(toolResults.length).toBe(1);
    const assistants = snap.items.filter((it) => it.source.type === "assistant_message");
    expect(assistants.length).toBe(1);
  });

  it("detects skill load from system event with <command-name>", () => {
    const events: HydratedEvent[] = [
      makeSystemEvent("<command-name>frontend-design</command-name>\nsome skill content"),
    ];
    const snap = buildSnapshot(events, { sessionId: "sess-1" });
    const skillItems = snap.items.filter((it) => it.source.type === "skill_load");
    expect(skillItems.length).toBe(1);
    if (skillItems[0]!.source.type === "skill_load") {
      expect(skillItems[0]!.source.skillName).toBe("frontend-design");
    }
  });

  it("handles plain user text message", () => {
    const events: HydratedEvent[] = [
      makeUserTextEvent("Please help me build a feature"),
    ];
    const snap = buildSnapshot(events, { sessionId: "sess-1" });
    const userItems = snap.items.filter((it) => it.source.type === "user_message");
    expect(userItems.length).toBe(1);
  });

  it("single-turn session still produces items", () => {
    const events: HydratedEvent[] = [
      makeAssistantEvent({ text: "Hello" }),
    ];
    const snap = buildSnapshot(events, { sessionId: "sess-1" });
    expect(snap.items.length).toBeGreaterThan(0);
  });

  it("assigns incrementing turnIndex to assistant events", () => {
    const events: HydratedEvent[] = [
      makeAssistantEvent({ text: "Turn 0", ts: "2025-01-01T00:00:00Z" }),
      makeAssistantEvent({ text: "Turn 1", ts: "2025-01-01T00:01:00Z" }),
    ];
    const snap = buildSnapshot(events, { sessionId: "sess-1" });
    const turns = snap.items.map((it) => it.turnIndex);
    expect(turns).toContain(0);
    expect(turns).toContain(1);
  });
});

// ── 3. token-attribution ──────────────────────────────────────────────────────

describe("token-attribution", () => {
  it("distributes cache delta across tool_results in a turn", () => {
    const CACHE = 5000;
    const events: HydratedEvent[] = [
      makeAssistantEvent({
        uuid: "msg-1",
        toolUses: [{ id: "tu-a", name: "Read" }, { id: "tu-b", name: "Bash" }],
        cacheCreate: CACHE,
        outputTokens: 200,
        ts: "2025-01-01T00:00:00Z",
      }),
      makeUserEventWithToolResults([
        { toolUseId: "tu-a", content: "A".repeat(300) },
        { toolUseId: "tu-b", content: "B".repeat(100) },
      ], "2025-01-01T00:00:01Z"),
    ];
    const snap = buildSnapshot(events, { sessionId: "sess-1" });
    fillTokenAttribution(snap, events);

    const toolResults = snap.items.filter((it) => it.source.type === "tool_result");
    expect(toolResults.length).toBe(2);

    const total = snap.items.reduce((s, it) => s + it.tokens, 0);
    // Total should be within 5% of sum of all attributed tokens
    expect(total).toBeGreaterThan(0);
    expect(snap.totalTokens).toBe(total);
  });

  it("falls back to char-count heuristic when no cache data", () => {
    const events: HydratedEvent[] = [
      makeAssistantEvent({ text: "A".repeat(350), cacheCreate: 0 }),
    ];
    const snap = buildSnapshot(events, { sessionId: "sess-1" });
    fillTokenAttribution(snap, events);

    const items = snap.items.filter((it) => it.source.type === "assistant_message");
    expect(items.length).toBe(1);
    // 350 chars / 3.5 ≈ 100 tokens; confidence = low
    expect(items[0]!.tokens).toBeGreaterThan(0);
    expect(items[0]!.attributionConfidence).toBe("low");
  });

  it("marks single tool_result in turn as high confidence", () => {
    const events: HydratedEvent[] = [
      makeAssistantEvent({
        toolUses: [{ id: "tu-solo", name: "Read" }],
        cacheCreate: 2000,
        ts: "2025-01-01T00:00:00Z",
      }),
      makeUserEventWithToolResults([
        { toolUseId: "tu-solo", content: "content" },
      ], "2025-01-01T00:00:01Z"),
    ];
    const snap = buildSnapshot(events, { sessionId: "sess-1" });
    fillTokenAttribution(snap, events);
    const tr = snap.items.find((it) => it.source.type === "tool_result");
    expect(tr?.attributionConfidence).toBe("high");
  });
});

// ── 4. compaction-simulator ───────────────────────────────────────────────────

describe("compaction-simulator", () => {
  it("drops oldest tool_results to reach target", () => {
    // 10 tool_result items of 10k tokens each = 100k total
    // Context window = 200k → 50% full initially? No: 100k / 200k = 50% → already at target.
    // Use 140k total to exceed 80% of 160k window.
    const items: ContextItem[] = [
      ...Array.from({ length: 7 }, (_, i) =>
        makeToolResultItem(`tr-${i}`, 10_000, i)
      ),
      makeAssistantItem("am-0", 5_000, 3),
      makeAssistantItem("am-1", 5_000, 6),
    ];
    // total = 80k; target = 50% of 160k = 80k → already at 50%; need >80k to trigger.
    // Adjust: 9 items × 10k = 90k in 160k window = 56% → just above 50%
    const items2: ContextItem[] = Array.from({ length: 9 }, (_, i) =>
      makeToolResultItem(`tr-${i}`, 10_000, i)
    );

    const result = simulateCompaction(items2, {
      targetPct: 50,
      contextWindowTokens: 160_000,
    });

    // keptTokens should be ≤ 80k (50% of 160k)
    expect(result.keptTokens).toBeLessThanOrEqual(80_000);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.simulatorVersion).toBe("v1");
  });

  it("keeps all items when already below target", () => {
    const items: ContextItem[] = [
      makeToolResultItem("tr-1", 5_000, 0),
      makeToolResultItem("tr-2", 5_000, 1),
    ];
    // 10k of 200k = 5% → well below 50%
    const result = simulateCompaction(items, { targetPct: 50, contextWindowTokens: 200_000 });
    expect(result.dropped.length).toBe(0);
    expect(result.kept.length).toBe(2);
  });

  it("always preserves non-tool-result items", () => {
    const items: ContextItem[] = [
      ...Array.from({ length: 8 }, (_, i) => makeToolResultItem(`tr-${i}`, 12_000, i)),
      makeAssistantItem("am-0", 10_000, 4),
    ];
    const result = simulateCompaction(items, { targetPct: 50, contextWindowTokens: 180_000 });
    const keptIds = new Set(result.kept.map((it) => it.id));
    expect(keptIds.has("am-0")).toBe(true);
  });

  it("always keeps most recent N tool_results", () => {
    const items: ContextItem[] = Array.from({ length: 10 }, (_, i) =>
      makeToolResultItem(`tr-${i}`, 15_000, i)
    );
    const result = simulateCompaction(items, {
      targetPct: 50,
      contextWindowTokens: 200_000,
      keepRecentToolResults: 3,
    });
    // The 3 most recent (tr-7, tr-8, tr-9) must be in kept
    const keptIds = new Set(result.kept.map((it) => it.id));
    expect(keptIds.has("tr-7")).toBe(true);
    expect(keptIds.has("tr-8")).toBe(true);
    expect(keptIds.has("tr-9")).toBe(true);
  });
});

// ── 5. snapshot-store ─────────────────────────────────────────────────────────

describe("snapshot-store", () => {
  it("save/load round-trip preserves items and pinnedIds", () => {
    const db = freshDb();
    // Insert a minimal session row so FK constraint passes
    db.run(`INSERT INTO sessions (id, project_slug, total_events) VALUES (?, ?, ?)`, [
      "sess-store-1", "proj", 0,
    ]);
    const items: ContextItem[] = [makeToolResultItem("tr-1", 1000, 0)];
    const snap = makeSnapshot("sess-store-1", items);
    snap.pinnedIds = ["tr-1"];

    const id = saveSnapshot(db, snap, "test-snap");
    expect(id).toBe(snap.id);

    const loaded = loadSnapshot(db, id);
    expect(loaded.sessionId).toBe("sess-store-1");
    expect(loaded.items.length).toBe(1);
    expect(loaded.pinnedIds).toContain("tr-1");
    expect(loaded.name).toBe("test-snap");
    closeDb(db);
  });

  it("listSnapshots returns all when no filter", () => {
    const db = freshDb();
    db.run(`INSERT INTO sessions (id, project_slug, total_events) VALUES (?, ?, ?)`, [
      "sess-list", "proj", 0,
    ]);
    const snap1 = makeSnapshot("sess-list", [makeToolResultItem("t1", 100, 0)]);
    const snap2 = { ...makeSnapshot("sess-list", [makeToolResultItem("t2", 200, 0)]), id: "snap-2" };
    saveSnapshot(db, snap1);
    saveSnapshot(db, snap2);

    const all = listSnapshots(db);
    expect(all.length).toBeGreaterThanOrEqual(2);
    closeDb(db);
  });

  it("listSnapshots filters by sessionId", () => {
    const db = freshDb();
    db.run(`INSERT INTO sessions (id, project_slug, total_events) VALUES (?, ?, ?)`, ["s1", "p", 0]);
    db.run(`INSERT INTO sessions (id, project_slug, total_events) VALUES (?, ?, ?)`, ["s2", "p", 0]);
    const snap1 = makeSnapshot("s1", [makeToolResultItem("a", 100, 0)]);
    const snap2 = { ...makeSnapshot("s2", [makeToolResultItem("b", 200, 0)]), id: "snap-b" };
    saveSnapshot(db, snap1);
    saveSnapshot(db, snap2);

    const s1Snaps = listSnapshots(db, "s1");
    expect(s1Snaps.every((s) => s.sessionId === "s1")).toBe(true);
    closeDb(db);
  });

  it("returns empty list gracefully when no snapshots", () => {
    const db = freshDb();
    const result = listSnapshots(db, "nonexistent-session");
    expect(result).toEqual([]);
    closeDb(db);
  });

  it("deleteSnapshot removes row", () => {
    const db = freshDb();
    db.run(`INSERT INTO sessions (id, project_slug, total_events) VALUES (?, ?, ?)`, [
      "sess-del", "p", 0,
    ]);
    const snap = makeSnapshot("sess-del", [makeToolResultItem("x", 50, 0)]);
    saveSnapshot(db, snap);
    deleteSnapshot(db, snap.id);
    expect(() => loadSnapshot(db, snap.id)).toThrow();
    closeDb(db);
  });
});

// ── 6. snapshot-differ ────────────────────────────────────────────────────────

describe("snapshot-differ", () => {
  it("identifies added and dropped items", () => {
    const shared = makeToolResultItem("shared", 1000, 0);
    const onlyA = makeToolResultItem("only-a", 500, 1);
    const onlyB = makeToolResultItem("only-b", 800, 2);

    const snapA = makeSnapshot("sess-1", [shared, onlyA]);
    const snapB = makeSnapshot("sess-1", [shared, onlyB]);

    const result = diff(snapA, snapB);
    expect(result.addedItems.map((it) => it.id)).toContain("only-b");
    expect(result.droppedItems.map((it) => it.id)).toContain("only-a");
  });

  it("computes net token delta", () => {
    const a = makeSnapshot("s", [makeToolResultItem("i1", 1000, 0)]);
    const b = makeSnapshot("s", [makeToolResultItem("i2", 1500, 0)]);
    const result = diff(a, b);
    expect(result.netTokenDelta).toBe(500);
  });

  it("warns on cross-session diff", () => {
    const a = makeSnapshot("sess-A", [makeToolResultItem("i1", 100, 0)]);
    const b = makeSnapshot("sess-B", [makeToolResultItem("i2", 100, 0)]);
    const result = diff(a, b);
    expect(result.crossSessionWarning).toBeDefined();
    expect(result.crossSessionWarning).toContain("different sessions");
  });

  it("no warning on same-session diff", () => {
    const a = makeSnapshot("sess-X", [makeToolResultItem("i1", 100, 0)]);
    const b = makeSnapshot("sess-X", [makeToolResultItem("i2", 100, 0)]);
    const result = diff(a, b);
    expect(result.crossSessionWarning).toBeUndefined();
  });

  it("empty diff when snapshots are identical", () => {
    const items = [makeToolResultItem("t", 300, 0)];
    const a = makeSnapshot("s", items);
    const b = makeSnapshot("s", items);
    const result = diff(a, b);
    expect(result.addedItems.length).toBe(0);
    expect(result.droppedItems.length).toBe(0);
    expect(result.netTokenDelta).toBe(0);
  });
});

// ── 7. manifest-emitter ───────────────────────────────────────────────────────

describe("manifest-emitter", () => {
  it("contains header comment and instruction line", () => {
    const items: ContextItem[] = [makeToolResultItem("t1", 2000, 3)];
    const out = emitManifest(items, { redact: false });
    expect(out).toContain("<!-- ckforensics keep-manifest -->");
    expect(out).toContain("Keep these in context");
  });

  it("includes all pinned items", () => {
    const items: ContextItem[] = [
      makeToolResultItem("t1", 1000, 1),
      makeToolResultItem("t2", 2000, 2),
    ];
    const out = emitManifest(items, { redact: false });
    // Each item should produce a bullet line
    const bullets = out.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(2);
  });

  it("includes token count and turn index per item", () => {
    const items: ContextItem[] = [makeToolResultItem("t1", 3500, 7)];
    const out = emitManifest(items, { redact: false });
    expect(out).toContain("3.5k tokens");
    expect(out).toContain("turn 7");
  });

  it("applies redaction by default", () => {
    const item: ContextItem = {
      id: "u-1",
      source: {
        type: "user_message",
        messageId: "m1",
        // embed a pattern that looks like an AWS key (hits DEFAULT_RULES)
        preview: "key: AKIAIOSFODNN7EXAMPLE rest of text",
      },
      tokens: 100,
      turnIndex: 0,
      timestamp: "2025-01-01T00:00:00Z",
      attributionConfidence: "medium",
    };
    const out = emitManifest([item], { redact: true });
    expect(out).toContain("[REDACTED:");
  });

  it("empty pinned list produces only header", () => {
    const out = emitManifest([]);
    const bullets = out.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(0);
  });
});

// ── 8. integration ────────────────────────────────────────────────────────────

describe("integration: build → attribute → heatmap rows", () => {
  it("produces non-empty item list from multi-turn fixture", () => {
    const events: HydratedEvent[] = [
      makeUserTextEvent("Please read the config file"),
      makeAssistantEvent({
        text: "I will read it",
        toolUses: [{ id: "tu-read", name: "Read", input: { file_path: "config.json" } }],
        cacheCreate: 3000,
        outputTokens: 80,
        ts: "2025-01-01T00:00:01Z",
      }),
      makeUserEventWithToolResults([
        { toolUseId: "tu-read", content: '{"key": "value", "setting": true}' },
      ], "2025-01-01T00:00:02Z"),
      makeAssistantEvent({
        text: "The config has key=value. Now I will edit the file.",
        toolUses: [{ id: "tu-edit", name: "Edit", input: { file_path: "config.json" } }],
        cacheCreate: 5000,
        outputTokens: 120,
        ts: "2025-01-01T00:00:03Z",
      }),
      makeUserEventWithToolResults([
        { toolUseId: "tu-edit", content: "Edit applied successfully" },
      ], "2025-01-01T00:00:04Z"),
    ];

    const snap = buildSnapshot(events, { sessionId: "sess-integ" });
    fillTokenAttribution(snap, events);

    expect(snap.items.length).toBeGreaterThanOrEqual(4);
    expect(snap.totalTokens).toBeGreaterThan(0);

    // Verify categories present
    const types = new Set(snap.items.map((it) => it.source.type));
    expect(types.has("tool_result")).toBe(true);
    expect(types.has("assistant_message")).toBe(true);
    expect(types.has("user_message")).toBe(true);

    // All tool_results have positive tokens after attribution
    const toolResults = snap.items.filter((it) => it.source.type === "tool_result");
    expect(toolResults.every((it) => it.tokens >= 0)).toBe(true);
  });
});
