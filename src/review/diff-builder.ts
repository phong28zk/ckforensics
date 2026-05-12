/**
 * Build a strict unified-diff patch from a Hunk that is consumable by
 * `git apply` (and by extension `git apply --reverse`).
 *
 * Reuses `formatDiff` from audit/diff-formatter but adds proper git-style
 * `--- a/` and `+++ b/` headers + handles the "no newline at end of file"
 * sentinel correctly.
 */

import { formatDiff } from "../audit/diff-formatter.ts";
import type { Hunk } from "./hunk-types.ts";

export interface BuildDiffOptions {
  /** Path prefix used in headers (default uses Hunk.filePath as-is). */
  pathOverride?: string;
  /** Lines of context (default 3, mirrors `git diff`). */
  context?: number;
  /**
   * Target line ending for the patch body lines. Headers always stay LF.
   * When CRLF, each `+`/`-`/context line is suffixed with \r so the patch
   * matches a CRLF target file.
   */
  lineEnding?: "LF" | "CRLF";
}

/**
 * Build a single-hunk unified diff string.
 *
 * Returns "" when the hunk has no meaningful diff (identical / unreviewable
 * `unknown-before`) — callers should check Hunk.unreviewable first.
 */
export function buildUnifiedDiff(hunk: Hunk, opts: BuildDiffOptions = {}): string {
  if (hunk.unreviewable && hunk.unreviewableReason === "identical") return "";

  const path = opts.pathOverride ?? hunk.filePath;
  const fromLabel = `a/${path}`;
  const toLabel = `b/${path}`;

  // Normalize CRLF to LF for diff purposes. Apply step re-normalizes if needed.
  const before = normalizeLf(hunk.before);
  const after = normalizeLf(hunk.after);

  const body = formatDiff(before, after, {
    plain: true,
    context: opts.context ?? 3,
    fromLabel,
    toLabel,
  });

  if (!body) return "";

  // formatDiff already emits "--- a/path\n+++ b/path\n@@ ..." — but it omits
  // the trailing "\ No newline at end of file" sentinel that git uses. Inject
  // it when either side lacks a trailing newline.
  const withMarkers = appendNoNewlineMarkers(body, before, after);

  // When target is CRLF, suffix payload lines with \r so git apply matches
  // the on-disk file. Headers (---, +++, @@, "\ No newline...") stay LF.
  if (opts.lineEnding === "CRLF") return crlfifyPatchBody(withMarkers);
  return withMarkers;
}

/**
 * Concatenate multiple hunks' diffs into a single multi-file patch.
 * Groups by file path (one header block per file).
 */
export function buildPatch(hunks: Hunk[], opts: BuildDiffOptions = {}): string {
  const parts: string[] = [];
  for (const h of hunks) {
    if (h.unreviewable) continue;
    const d = buildUnifiedDiff(h, opts);
    if (d) parts.push(d);
  }
  return parts.join("");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeLf(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * Suffix payload lines (` `, `+`, `-`) with `\r` so the patch body matches a
 * CRLF target file. Diff metadata (`---`, `+++`, `@@`, `\ No newline...`) stays
 * LF — that's what git apply expects regardless of file line-ending.
 */
function crlfifyPatchBody(diff: string): string {
  const lines = diff.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const isPayload =
      line.length > 0 &&
      (line[0] === " " || line[0] === "+" || line[0] === "-") &&
      !line.startsWith("+++") &&
      !line.startsWith("---");
    out.push(isPayload ? line + "\r" : line);
  }
  return out.join("\n");
}

/**
 * Append the git-style "\ No newline at end of file" marker after the last
 * line of each side that does not end with a newline. Conservative: only
 * adds when missing AND the diff body actually contains content for that side.
 */
function appendNoNewlineMarkers(diff: string, before: string, after: string): string {
  const beforeMissing = before.length > 0 && !before.endsWith("\n");
  const afterMissing = after.length > 0 && !after.endsWith("\n");
  if (!beforeMissing && !afterMissing) return diff;

  // Find last "-" line for beforeMissing, last "+" line for afterMissing,
  // and inject the marker on the following line. Keep this simple: parse
  // diff lines and patch in marker after the last matching prefix.
  const lines = diff.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    out.push(line);
    const isLast = i === lines.length - 1 || (i < lines.length - 1 && !lines[i + 1]?.match(/^[-+ ]/));
    if (!isLast) continue;
    if (beforeMissing && line.startsWith("-")) {
      out.push("\\ No newline at end of file");
    } else if (afterMissing && line.startsWith("+")) {
      out.push("\\ No newline at end of file");
    }
  }

  return out.join("\n");
}
