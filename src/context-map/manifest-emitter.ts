/**
 * Manifest emitter: given a set of pinned ContextItems, emit a paste-ready
 * markdown block the user can drop into a Claude Code prompt to instruct CC
 * not to drop those items on next auto-compact.
 *
 * Output target: stdout (default) or a file path via --out.
 * Redaction: applies DEFAULT_RULES from privacy/redactor before emitting
 * to avoid leaking secrets in the manifest.
 *
 * Manifest format:
 *   <!-- ckforensics keep-manifest -->
 *   Keep these in context (please don't drop on next compact):
 *   - <category>: <label> (<tokens>k tokens, turn <N>)
 *   ...
 *
 * Size constraint: kept ≤ 2 KB for paste-friendliness.
 */

import { writeFileSync } from "node:fs";
import type { ContextItem } from "./types.ts";
import { redactText } from "../privacy/redactor.ts";
import { DEFAULT_RULES } from "../privacy/redaction-rules.ts";

// ── Public API ────────────────────────────────────────────────────────────────

export interface EmitManifestOptions {
  /** Absolute path to write manifest to. If omitted, returns string only. */
  outFile?: string;
  /** Whether to apply redaction rules (default true). */
  redact?: boolean;
}

/**
 * Build and optionally write a keep-manifest markdown block.
 *
 * @param items   Context items marked as pinned.
 * @param opts    Output options.
 * @returns       The manifest string (always returned regardless of outFile).
 */
export function emitManifest(
  items: ContextItem[],
  opts: EmitManifestOptions = {}
): string {
  const applyRedact = opts.redact !== false;
  const lines: string[] = [
    "<!-- ckforensics keep-manifest -->",
    "Keep these in context (please don't drop on next compact):",
  ];

  for (const item of items) {
    const label = buildLabel(item);
    const redacted = applyRedact ? redactText(label, DEFAULT_RULES) : label;
    const tokens = item.tokens > 0
      ? `${(item.tokens / 1000).toFixed(1)}k tokens`
      : "unknown tokens";
    lines.push(`- ${redacted} (${tokens}, turn ${item.turnIndex})`);
  }

  const manifest = lines.join("\n") + "\n";

  // Warn if manifest exceeds 2 KB paste-friendly limit
  if (manifest.length > 2048) {
    process.stderr.write(
      `Warning: manifest is ${manifest.length} bytes (>${2048}). ` +
        "Consider pinning fewer items.\n"
    );
  }

  if (opts.outFile) {
    writeFileSync(opts.outFile, manifest, { encoding: "utf-8", mode: 0o600 });
  }

  return manifest;
}

// ── Label builder ─────────────────────────────────────────────────────────────

function buildLabel(item: ContextItem): string {
  const src = item.source;
  switch (src.type) {
    case "tool_result":
      return `Tool result (${src.toolName}): ${truncate(src.preview, 80)}`;
    case "assistant_message":
      return `Assistant: ${truncate(src.preview, 80)}`;
    case "user_message":
      return `User: ${truncate(src.preview, 80)}`;
    case "system_prompt":
      return "System prompt";
    case "memory":
      return `Memory: ${truncate(src.entry, 80)}`;
    case "skill_load":
      return `Skill: ${src.skillName}`;
    case "unknown":
      return `Unknown: ${truncate(src.raw, 80)}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
