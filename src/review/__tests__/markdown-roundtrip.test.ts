/**
 * Round-trip tests for markdown-emitter ↔ markdown-parser.
 *
 * Verifies:
 *   - Emitter output is parsed back to the same hunk IDs
 *   - Default state (unchecked) → "keep"
 *   - Toggled `[x]` → "revert"
 *   - Unreviewable rendered with `[!]` and parsed as "unreviewable"
 *   - Missing header sentinel → throws
 */

import { describe, it, expect } from "bun:test";
import { emitReviewMarkdown } from "../markdown-emitter.ts";
import { parseReviewMarkdown, ReviewParseError } from "../markdown-parser.ts";
import type { Hunk } from "../hunk-types.ts";

function h(partial: Partial<Hunk>): Hunk {
  return {
    id: "sess-1:/a.ts:0",
    sessionId: "sess-1",
    filePath: "/a.ts",
    opIndex: 0,
    type: "Edit",
    timestamp: "2026-05-11T14:00:00Z",
    before: "old\n",
    after: "new\n",
    unreviewable: false,
    revertKind: "patch",
    ...partial,
  };
}

describe("emit → parse round-trip", () => {
  it("default unchecked checkboxes all become 'keep'", () => {
    const hunks = [
      h({ id: "sess-1:/a.ts:0", filePath: "/a.ts", opIndex: 0 }),
      h({ id: "sess-1:/a.ts:1", filePath: "/a.ts", opIndex: 1 }),
      h({ id: "sess-1:/b.ts:0", filePath: "/b.ts", opIndex: 0 }),
    ];
    const md = emitReviewMarkdown("sess-1", hunks);
    const parsed = parseReviewMarkdown(md);

    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.decisions.size).toBe(3);
    for (const d of parsed.decisions.values()) {
      expect(d).toBe("keep");
    }
  });

  it("toggling [ ] to [x] yields 'revert'", () => {
    const hunks = [
      h({ id: "sess-1:/a.ts:0" }),
      h({ id: "sess-1:/a.ts:1", opIndex: 1 }),
    ];
    let md = emitReviewMarkdown("sess-1", hunks);

    // Toggle the FIRST occurrence only — emulate user editing 1 of 2 hunks
    md = md.replace("- [ ] **Revert this hunk**", "- [x] **Revert this hunk**");

    const parsed = parseReviewMarkdown(md);
    expect(parsed.decisions.get("sess-1:/a.ts:0")).toBe("revert");
    expect(parsed.decisions.get("sess-1:/a.ts:1")).toBe("keep");
  });

  it("uppercase [X] is also accepted as revert", () => {
    const hunks = [h({ id: "sess-1:/a.ts:0" })];
    let md = emitReviewMarkdown("sess-1", hunks);
    md = md.replace("- [ ] **Revert this hunk**", "- [X] **Revert this hunk**");
    const parsed = parseReviewMarkdown(md);
    expect(parsed.decisions.get("sess-1:/a.ts:0")).toBe("revert");
  });

  it("unreviewable hunks render [!] and parse as 'unreviewable'", () => {
    const hunks = [
      h({
        id: "sess-1:/u.ts:0",
        filePath: "/u.ts",
        unreviewable: true,
        unreviewableReason: "unknown-before",
      }),
    ];
    const md = emitReviewMarkdown("sess-1", hunks);
    expect(md).toContain("- [!]");
    expect(md).toContain("file was not read before edit");
    const parsed = parseReviewMarkdown(md);
    expect(parsed.decisions.get("sess-1:/u.ts:0")).toBe("unreviewable");
  });

  it("preserves session ID in header sentinel", () => {
    const md = emitReviewMarkdown("sess-XYZ-123", [h({ id: "sess-XYZ-123:/a.ts:0" })]);
    const parsed = parseReviewMarkdown(md);
    expect(parsed.sessionId).toBe("sess-XYZ-123");
  });

  it("captures generatedAt timestamp", () => {
    const md = emitReviewMarkdown("sess-1", [h({})], {
      generatedAt: "2026-05-11T22:00:00Z",
    });
    const parsed = parseReviewMarkdown(md);
    expect(parsed.generatedAt).toBe("2026-05-11T22:00:00Z");
  });

  it("tolerates added user comments between hunks", () => {
    const hunks = [h({ id: "sess-1:/a.ts:0" }), h({ id: "sess-1:/a.ts:1", opIndex: 1 })];
    let md = emitReviewMarkdown("sess-1", hunks);
    // Inject arbitrary user note after first hunk
    md = md.replace("```diff", "**NOTE:** I added this\n\n```diff");
    const parsed = parseReviewMarkdown(md);
    expect(parsed.decisions.size).toBe(2);
  });

  it("empty hunk list emits valid document parseable to zero decisions", () => {
    const md = emitReviewMarkdown("sess-empty", []);
    const parsed = parseReviewMarkdown(md);
    expect(parsed.sessionId).toBe("sess-empty");
    expect(parsed.decisions.size).toBe(0);
  });

  it("truncates long reasons to one line within configured max", () => {
    const longReason = "x".repeat(500);
    const md = emitReviewMarkdown("sess-1", [h({ reason: longReason })], { reasonMaxLen: 50 });
    // Look for the reason line and verify it was truncated
    const reasonLine = md.split("\n").find((l) => l.startsWith("**Reason:**"))!;
    expect(reasonLine.length).toBeLessThanOrEqual(50 + "**Reason:** ".length + 4);
    expect(reasonLine).toContain("…");
  });

  it("renders reason on a single line even with embedded newlines", () => {
    const md = emitReviewMarkdown("sess-1", [h({ reason: "line1\nline2\nline3" })]);
    const reasonLine = md.split("\n").find((l) => l.startsWith("**Reason:**"))!;
    expect(reasonLine).toBe("**Reason:** line1 line2 line3");
  });
});

describe("parser error handling", () => {
  it("throws on missing header sentinel", () => {
    const garbage = "# some random markdown\nno sentinel here\n";
    expect(() => parseReviewMarkdown(garbage)).toThrow(ReviewParseError);
  });

  it("throws with helpful message when fed wrong file", () => {
    expect(() => parseReviewMarkdown("# README\n\nThis is a readme.")).toThrow(
      /Missing ckforensics review header/
    );
  });

  it("ignores unknown hunk IDs gracefully (forward compat)", () => {
    const md =
      "# ckforensics review — session sess-1\n" +
      "<!-- ckforensics:review v1 session=sess-1 generated=now -->\n\n" +
      "## /a.ts\n\n### Hunk 1\n<!-- ckforensics:hunk id=future-format-id -->\n\n" +
      "- [x] **Revert this hunk**\n";
    const parsed = parseReviewMarkdown(md);
    expect(parsed.decisions.get("future-format-id")).toBe("revert");
  });
});
