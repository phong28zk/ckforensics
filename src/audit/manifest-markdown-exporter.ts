/**
 * Markdown exporter: converts a SessionManifest to a GitHub-pasteable
 * markdown report suitable for PR review comments.
 *
 * Sections:
 *   1. Header   — session id, date, model, cost, duration
 *   2. Summary  — file count, lines +/-, tool call count
 *   3. Per-file — chronological edits with reasoning quotes and diffs
 *   4. Subagent breakdown — nested spans with their file changes
 *
 * No ANSI escape codes — plain text only (markdown fenced blocks for diffs).
 */

import type { SessionManifest, FileChange, EditOp, SubagentSpan } from "./manifest-types.ts";
import { formatDiff } from "./diff-formatter.ts";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a SessionManifest as a markdown string.
 *
 * The output is safe to paste into a GitHub PR comment:
 * - No terminal escape codes
 * - Diffs in fenced ```diff blocks
 * - Collapsible per-file sections via <details>
 */
export function exportManifestMarkdown(manifest: SessionManifest): string {
  const parts: string[] = [];

  parts.push(renderHeader(manifest));
  parts.push(renderSummary(manifest));

  if (manifest.fileChanges.size > 0) {
    parts.push("## File Changes\n");
    for (const fc of manifest.fileChanges.values()) {
      parts.push(renderFileSection(fc));
    }
  }

  if (manifest.subagentSpans.length > 0) {
    parts.push(renderSubagentSection(manifest.subagentSpans));
  }

  parts.push(renderFooter());

  return parts.join("\n");
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderHeader(manifest: SessionManifest): string {
  const { session, estimatedCostUsd } = manifest;
  const date = session.startedAt
    ? new Date(session.startedAt).toUTCString()
    : "unknown";
  const duration = computeDuration(session.startedAt, session.endedAt);
  const cost = estimatedCostUsd !== null
    ? `$${estimatedCostUsd.toFixed(4)}`
    : "unknown";

  return [
    "# Session Change Manifest",
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Session ID** | \`${session.id}\` |`,
    `| **Project** | ${session.projectSlug} |`,
    `| **Date** | ${date} |`,
    `| **Model** | ${session.model || "unknown"} |`,
    `| **Duration** | ${duration} |`,
    `| **Estimated Cost** | ${cost} |`,
    `| **Total Events** | ${session.totalEvents} |`,
    "",
  ].join("\n");
}

function renderSummary(manifest: SessionManifest): string {
  const { fileChanges, tokenTotals } = manifest;

  let totalAdded = 0;
  let totalRemoved = 0;
  let totalOps = 0;
  let newFiles = 0;

  for (const fc of fileChanges.values()) {
    totalAdded += fc.linesAdded;
    totalRemoved += fc.linesRemoved;
    totalOps += fc.ops.length;
    if (fc.isNew) newFiles++;
  }

  const totalTokens = tokenTotals.input + tokenTotals.output;

  return [
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Files changed | ${fileChanges.size} (${newFiles} new) |`,
    `| Lines added | +${totalAdded} |`,
    `| Lines removed | -${totalRemoved} |`,
    `| Edit operations | ${totalOps} |`,
    `| Tokens (in/out) | ${tokenTotals.input.toLocaleString()} / ${tokenTotals.output.toLocaleString()} (${totalTokens.toLocaleString()} total) |`,
    `| Cache read | ${tokenTotals.cacheRead.toLocaleString()} |`,
    "",
  ].join("\n");
}

function renderFileSection(fc: FileChange): string {
  const badge = fc.isNew ? " *(new)*" : "";
  const delta = formatDelta(fc.linesAdded, fc.linesRemoved);
  const lines: string[] = [];

  lines.push(`<details>`);
  lines.push(`<summary><strong>${escapeHtml(fc.path)}</strong>${badge} ${delta}</summary>`);
  lines.push("");

  for (let i = 0; i < fc.ops.length; i++) {
    const op = fc.ops[i]!;
    lines.push(renderEditOp(op, i + 1, fc.ops.length));
  }

  lines.push(`</details>`);
  lines.push("");

  return lines.join("\n");
}

function renderEditOp(op: EditOp, idx: number, total: number): string {
  const lines: string[] = [];
  const ts = op.timestamp ? formatTime(op.timestamp) : "unknown time";

  lines.push(`### Edit ${idx}/${total} — ${op.type} at ${ts}`);
  lines.push("");

  if (op.parentAgentId) {
    lines.push(`> **Subagent:** \`${op.parentAgentId}\``);
    lines.push("");
  }

  if (op.reason) {
    const truncated = op.reason.length > 300
      ? op.reason.slice(0, 300) + "…"
      : op.reason;
    lines.push(`> **Reasoning:** ${truncated}`);
    lines.push("");
  }

  if (op.unknownBefore) {
    lines.push(`> ⚠️ File state before this edit was unknown — diff shown against empty.`);
    lines.push("");
  }

  const diff = formatDiff(op.before ?? "", op.after, {
    plain: true,
    fromLabel: "before",
    toLabel: "after",
  });

  if (diff.trim()) {
    lines.push("```diff");
    lines.push(diff.trimEnd());
    lines.push("```");
  } else {
    lines.push("*(no diff — content unchanged)*");
  }
  lines.push("");

  return lines.join("\n");
}

function renderSubagentSection(spans: SubagentSpan[]): string {
  const lines: string[] = [];
  lines.push("## Subagent Dispatches");
  lines.push("");

  for (const span of spans) {
    const indent = "  ".repeat(span.depth);
    const duration = span.closedAt
      ? computeDuration(span.openedAt, span.closedAt)
      : "still open";
    const parent = span.parentId ? ` ↳ parent: \`${span.parentId.slice(0, 8)}…\`` : "";

    lines.push(`${indent}- **${span.toolName}** \`${span.id.slice(0, 8)}…\`${parent}`);
    lines.push(`${indent}  - Input: ${escapeHtml(span.inputSummary)}`);
    lines.push(`${indent}  - Duration: ${duration} | Events: ${span.eventIds.length}`);
  }

  lines.push("");
  return lines.join("\n");
}

function renderFooter(): string {
  return [
    "---",
    "",
    "> ⚠️ This report may contain sensitive information. Review before sharing.",
    "> Generated by **ckforensics** — session change manifest.",
    "",
  ].join("\n");
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function computeDuration(start?: string, end?: string): string {
  if (!start || !end) return "unknown";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (isNaN(ms) || ms < 0) return "unknown";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function formatDelta(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.length > 0 ? `(${parts.join(" ")})` : "";
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
