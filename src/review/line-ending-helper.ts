/**
 * Line-ending detection + preservation for cross-platform revert correctness.
 *
 * Why: ckforensics' diff layer normalizes to LF for portability, but `git apply`
 * (and our direct-rewrite fallback) operates on the file as-is on disk. If the
 * target file is CRLF (Windows-edited, MQL5, .bat, legacy C#) but our patch is
 * LF, `git apply` typically rejects with "patch does not apply" or silently
 * mangles line endings.
 *
 * Strategy:
 *   1. Read the target file's current bytes (no encoding transform).
 *   2. Heuristic: if >50% of newlines are CRLF, treat as CRLF; else LF.
 *   3. Patch builder converts LF → CRLF for both `before` and `after` lines
 *      when the detected style is CRLF. Headers stay LF (RFC).
 */

import { readFileSync, existsSync } from "node:fs";

export type LineEnding = "LF" | "CRLF";

/**
 * Detect the dominant line ending of a file by reading its raw bytes.
 * Returns "LF" by default (when file missing or has no newlines).
 */
export function detectLineEnding(absPath: string): LineEnding {
  if (!existsSync(absPath)) return "LF";
  let raw: Buffer;
  try {
    raw = readFileSync(absPath);
  } catch {
    return "LF";
  }
  return detectFromBuffer(raw);
}

/** Heuristic over a buffer. Exported for testing. */
export function detectFromBuffer(buf: Buffer): LineEnding {
  let crlf = 0;
  let lfOnly = 0;
  const CR = 0x0d;
  const LF = 0x0a;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF) {
      if (i > 0 && buf[i - 1] === CR) crlf++;
      else lfOnly++;
    }
  }
  const total = crlf + lfOnly;
  if (total === 0) return "LF";
  return crlf / total > 0.5 ? "CRLF" : "LF";
}

/**
 * Convert all LF in a string to CRLF, but leave existing CRLF untouched
 * (idempotent). Returns the input unchanged when `target === "LF"`.
 */
export function toLineEnding(text: string, target: LineEnding): string {
  if (target === "LF") return text.replace(/\r\n/g, "\n");
  // CRLF target: normalize to LF first, then expand
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}
