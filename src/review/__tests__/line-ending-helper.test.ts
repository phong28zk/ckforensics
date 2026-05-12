/**
 * Tests for line-ending detection + conversion.
 */

import { describe, it, expect } from "bun:test";
import { detectFromBuffer, toLineEnding } from "../line-ending-helper.ts";

describe("detectFromBuffer", () => {
  it("returns LF for pure LF content", () => {
    expect(detectFromBuffer(Buffer.from("line1\nline2\nline3\n"))).toBe("LF");
  });

  it("returns CRLF for pure CRLF content", () => {
    expect(detectFromBuffer(Buffer.from("line1\r\nline2\r\nline3\r\n"))).toBe("CRLF");
  });

  it("returns LF when no newlines present", () => {
    expect(detectFromBuffer(Buffer.from("singleline"))).toBe("LF");
  });

  it("returns CRLF when mixed but CRLF dominates", () => {
    expect(detectFromBuffer(Buffer.from("a\r\nb\r\nc\r\nd\ne\n"))).toBe("CRLF");
  });

  it("returns LF when mixed but LF dominates", () => {
    expect(detectFromBuffer(Buffer.from("a\nb\nc\nd\r\ne\r\n"))).toBe("LF");
  });
});

describe("toLineEnding", () => {
  it("LF target normalizes any CRLF to LF (idempotent)", () => {
    expect(toLineEnding("a\r\nb\r\nc", "LF")).toBe("a\nb\nc");
    expect(toLineEnding("a\nb\nc", "LF")).toBe("a\nb\nc");
  });

  it("CRLF target expands LF to CRLF without doubling existing CRLF", () => {
    expect(toLineEnding("a\nb\nc", "CRLF")).toBe("a\r\nb\r\nc");
    expect(toLineEnding("a\r\nb\r\nc", "CRLF")).toBe("a\r\nb\r\nc");
  });
});
