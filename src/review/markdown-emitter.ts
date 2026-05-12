/**
 * Emit a review markdown document from a Hunk[] — one file section per file,
 * one subsection per hunk, with a checkbox the user toggles to record decisions.
 *
 * The emitted document round-trips through `markdown-parser.parseReviewMarkdown`:
 *   - leave `- [ ]` unchecked → decision "keep" (default, safe)
 *   - toggle to `- [x]`        → decision "revert"
 *   - unreviewable hunks render `- [!]` (not editable)
 *
 * HTML comments serve as stable parse anchors and are NOT meant to be edited.
 */

import type { Hunk } from "./hunk-types.ts";
import { buildUnifiedDiff } from "./diff-builder.ts";

export interface EmitOptions {
  /** ISO-8601 timestamp recorded in the header; defaults to new Date(). */
  generatedAt?: string;
  /** Max reason length rendered (chars); default 200. */
  reasonMaxLen?: number;
}

/** Sentinel comment that markdown-parser uses to validate file authenticity. */
export const REVIEW_HEADER_SENTINEL = "ckforensics:review v1";

/** Per-hunk anchor sentinel (stable, never edited by user). */
export const HUNK_ANCHOR_PREFIX = "ckforensics:hunk id=";

/**
 * Build the review markdown document for a session's hunks.
 * Hunks are expected to be pre-sorted by file then op index (explodeHunks output).
 */
export function emitReviewMarkdown(
  sessionId: string,
  hunks: Hunk[],
  opts: EmitOptions = {}
): string {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const reasonMax = opts.reasonMaxLen ?? 200;

  const parts: string[] = [];
  parts.push(`# ckforensics review — session ${sessionId}`);
  parts.push(`<!-- ${REVIEW_HEADER_SENTINEL} session=${sessionId} generated=${generatedAt} -->`);
  parts.push("");
  parts.push(
    `> Toggle \`- [x] **Revert this hunk**\` for each change you want to undo, ` +
      `then run \`ckforensics review --batch --decisions <this-file>\`.`
  );
  parts.push("");

  if (hunks.length === 0) {
    parts.push("_No hunks to review in this session._");
    return parts.join("\n") + "\n";
  }

  // Group by file while preserving input order
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    const arr = byFile.get(h.filePath) ?? [];
    arr.push(h);
    byFile.set(h.filePath, arr);
  }

  for (const [filePath, fileHunks] of byFile) {
    parts.push(`## ${filePath}`);
    parts.push("");
    fileHunks.forEach((h, i) => {
      parts.push(renderHunk(h, i + 1, reasonMax));
    });
  }

  return parts.join("\n") + "\n";
}

// ── Hunk rendering ────────────────────────────────────────────────────────────

function renderHunk(h: Hunk, hunkNum: number, reasonMax: number): string {
  const lines: string[] = [];
  lines.push(`### Hunk ${hunkNum} — ${h.type} @ ${h.timestamp}`);
  lines.push(`<!-- ${HUNK_ANCHOR_PREFIX}${h.id} -->`);
  lines.push("");

  if (h.reason) {
    lines.push(`**Reason:** ${truncateOneLine(h.reason, reasonMax)}`);
    lines.push("");
  }

  if (h.unreviewable) {
    lines.push(`- [!] **Unreviewable** — ${humanReason(h.unreviewableReason)}`);
    lines.push("");
  } else if (h.revertKind === "delete") {
    lines.push(`- [ ] **Revert this hunk** (will **DELETE** \`${h.filePath}\`)`);
    lines.push("");
    lines.push(`> File was created during the session. Reverting removes it entirely.`);
    lines.push("");
    // Show first 20 lines of the created content so user can decide
    const preview = h.after.split("\n").slice(0, 20).join("\n");
    if (preview) {
      lines.push("```");
      lines.push(preview);
      if (h.after.split("\n").length > 20) lines.push("... (truncated)");
      lines.push("```");
      lines.push("");
    }
  } else {
    lines.push("- [ ] **Revert this hunk** (leave unchecked to keep)");
    lines.push("");
    const diff = buildUnifiedDiff(h);
    if (diff) {
      lines.push("```diff");
      lines.push(diff.trimEnd());
      lines.push("```");
      lines.push("");
    }
  }

  return lines.join("\n");
}

function truncateOneLine(s: string, max: number): string {
  const single = s.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return single.slice(0, max - 1) + "…";
}

function humanReason(r: Hunk["unreviewableReason"]): string {
  switch (r) {
    case "unknown-before":
      return "file was not read before edit; original content unknown";
    case "identical":
      return "before and after content identical (no-op edit)";
    case "binary":
      return "content appears binary; diff/revert not supported";
    default:
      return "reason unspecified";
  }
}
