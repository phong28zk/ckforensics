/**
 * Tests for hunk-builder.explodeHunks() — covers all EditOp types and unreviewable flags.
 */

import { describe, it, expect } from "bun:test";
import { explodeHunks } from "../hunk-builder.ts";
import type { SessionManifest, EditOp, FileChange } from "../../audit/manifest-types.ts";

function makeManifest(filesMap: Record<string, EditOp[]>): SessionManifest {
  const fileChanges = new Map<string, FileChange>();
  for (const [path, ops] of Object.entries(filesMap)) {
    fileChanges.set(path, {
      path,
      isNew: false,
      ops,
      linesAdded: 0,
      linesRemoved: 0,
    });
  }
  return {
    session: {
      id: "sess-1",
      projectSlug: "test",
      startedAt: "2026-05-11T00:00:00Z",
      endedAt: "2026-05-11T01:00:00Z",
      model: "claude-opus-4-7",
      totalEvents: 0,
    },
    events: [],
    fileChanges,
    subagentSpans: [],
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    estimatedCostUsd: null,
  };
}

describe("explodeHunks", () => {
  it("emits one hunk per EditOp", () => {
    const ops: EditOp[] = [
      { timestamp: "t1", type: "Edit", before: "foo\n", after: "bar\n" },
      { timestamp: "t2", type: "Edit", before: "bar\n", after: "baz\n" },
    ];
    const hunks = explodeHunks(makeManifest({ "/a.ts": ops }));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.id).toBe("sess-1:/a.ts:0");
    expect(hunks[1]!.id).toBe("sess-1:/a.ts:1");
  });

  it("preserves file ordering from Map and op ordering within file", () => {
    const hunks = explodeHunks(
      makeManifest({
        "/first.ts": [{ timestamp: "t1", type: "Edit", before: "a", after: "b" }],
        "/second.ts": [{ timestamp: "t2", type: "Edit", before: "c", after: "d" }],
      })
    );
    expect(hunks.map((h) => h.filePath)).toEqual(["/first.ts", "/second.ts"]);
  });

  it("flags unknownBefore as unreviewable", () => {
    const ops: EditOp[] = [
      { timestamp: "t1", type: "Edit", before: "x", after: "y", unknownBefore: true },
    ];
    const [h] = explodeHunks(makeManifest({ "/a.ts": ops }));
    expect(h!.unreviewable).toBe(true);
    expect(h!.unreviewableReason).toBe("unknown-before");
  });

  it("Write with no prior state is reviewable as a delete operation", () => {
    const ops: EditOp[] = [
      { timestamp: "t1", type: "Write", after: "new file content\n" },
    ];
    const [h] = explodeHunks(makeManifest({ "/new.ts": ops }));
    expect(h!.unreviewable).toBe(false);
    expect(h!.revertKind).toBe("delete");
    expect(h!.before).toBe(""); // normalized to empty string
  });

  it("flags identical before/after", () => {
    const ops: EditOp[] = [
      { timestamp: "t1", type: "Edit", before: "same\n", after: "same\n" },
    ];
    const [h] = explodeHunks(makeManifest({ "/a.ts": ops }));
    expect(h!.unreviewable).toBe(true);
    expect(h!.unreviewableReason).toBe("identical");
  });

  it("flags binary content (NUL byte present)", () => {
    const binaryContent = "hello" + String.fromCharCode(0) + "world";
    const ops: EditOp[] = [
      { timestamp: "t1", type: "Edit", before: binaryContent, after: "text" },
    ];
    const [h] = explodeHunks(makeManifest({ "/blob.bin": ops }));
    expect(h!.unreviewable).toBe(true);
    expect(h!.unreviewableReason).toBe("binary");
  });

  it("carries reason and toolUseId through", () => {
    const ops: EditOp[] = [
      {
        timestamp: "t1",
        type: "Edit",
        before: "a\n",
        after: "b\n",
        reason: "Fix null check",
        toolUseId: "toolu_123",
      },
    ];
    const [h] = explodeHunks(makeManifest({ "/a.ts": ops }));
    expect(h!.reason).toBe("Fix null check");
    expect(h!.toolUseId).toBe("toolu_123");
    expect(h!.unreviewable).toBe(false);
  });

  it("treats MultiEdit as N independent hunks (already flattened by aggregator)", () => {
    const ops: EditOp[] = [
      { timestamp: "t1", type: "MultiEdit", before: "v1\n", after: "v2\n" },
      { timestamp: "t1", type: "MultiEdit", before: "v2\n", after: "v3\n" },
      { timestamp: "t1", type: "MultiEdit", before: "v3\n", after: "v4\n" },
    ];
    const hunks = explodeHunks(makeManifest({ "/a.ts": ops }));
    expect(hunks).toHaveLength(3);
    expect(hunks.every((h) => !h.unreviewable)).toBe(true);
  });
});
