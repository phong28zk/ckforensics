/**
 * Parse a review markdown document (produced by markdown-emitter) and extract
 * per-hunk user decisions.
 *
 * Strategy: locate each `<!-- ckforensics:hunk id=ID -->` anchor, then look
 * for the nearest following checkbox line and read its state:
 *   - `[ ]`  → "keep"   (default; unchecked)
 *   - `[x]`  → "revert" (user toggled)
 *   - `[!]`  → "unreviewable" (rendered by emitter; cannot toggle)
 *
 * Tolerates extra user-added comments / whitespace; only requires the anchors
 * and the header sentinel to be present.
 */

import type { HunkDecision } from "./hunk-types.ts";
import { REVIEW_HEADER_SENTINEL, HUNK_ANCHOR_PREFIX } from "./markdown-emitter.ts";

export interface ParsedReview {
  /** Session ID extracted from the header sentinel. */
  sessionId: string;
  /** ISO-8601 timestamp from the header (best-effort; "" if absent). */
  generatedAt: string;
  /** Per-hunk decisions, keyed by Hunk.id. */
  decisions: Map<string, HunkDecision>;
}

export class ReviewParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ReviewParseError";
  }
}

/**
 * Parse a review markdown document. Throws ReviewParseError when the header
 * sentinel is missing (refuses to silently accept random markdown files).
 */
export function parseReviewMarkdown(text: string): ParsedReview {
  const header = extractHeaderSentinel(text);
  if (!header) {
    throw new ReviewParseError(
      `Missing ckforensics review header sentinel — file does not look like a review document.`
    );
  }

  const decisions = new Map<string, HunkDecision>();
  const anchorRegex = new RegExp(
    `<!--\\s*${HUNK_ANCHOR_PREFIX.replace(":", "\\:")}([^\\s>]+)\\s*-->`,
    "g"
  );

  let m: RegExpExecArray | null;
  while ((m = anchorRegex.exec(text)) !== null) {
    const id = m[1]!;
    const decision = findCheckboxAfter(text, m.index + m[0].length);
    decisions.set(id, decision);
  }

  return {
    sessionId: header.sessionId,
    generatedAt: header.generatedAt,
    decisions,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface HeaderInfo {
  sessionId: string;
  generatedAt: string;
}

function extractHeaderSentinel(text: string): HeaderInfo | null {
  // Match: <!-- ckforensics:review v1 session=ID generated=ISO -->
  const re = new RegExp(
    `<!--\\s*${REVIEW_HEADER_SENTINEL.replace(/\s/g, "\\s+")}` +
      `\\s+session=([^\\s>]+)` +
      `(?:\\s+generated=([^\\s>]+))?` +
      `\\s*-->`
  );
  const m = re.exec(text);
  if (!m) return null;
  return { sessionId: m[1]!, generatedAt: m[2] ?? "" };
}

/**
 * Starting from `startIdx`, scan forward up to 2KB for the first checkbox
 * line `- [ ]` / `- [x]` / `- [!]`. Returns the decision derived from its state.
 * If no checkbox is found within window, defaults to "keep" (safe).
 */
function findCheckboxAfter(text: string, startIdx: number): HunkDecision {
  const window = text.slice(startIdx, startIdx + 2048);
  const re = /^\s*-\s+\[([ xX!])\]/m;
  const m = re.exec(window);
  if (!m) return "keep";
  const mark = m[1];
  if (mark === "x" || mark === "X") return "revert";
  if (mark === "!") return "unreviewable";
  return "keep";
}
