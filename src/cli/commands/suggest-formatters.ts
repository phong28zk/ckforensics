/**
 * Output formatters for the suggest command.
 * Extracted to keep suggest.ts under 200 lines.
 */

import { bold, cyan, green, yellow, dim } from "../color.ts";
import { truncateRight } from "../output-formatter.ts";
import type { Recommendation } from "../../recommender/types.ts";

export function formatUsd(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function renderTextRec(rec: Recommendation, rank: number): string {
  const lines: string[] = [];
  const conf = rec.confidence >= 80 ? green : rec.confidence >= 60 ? yellow : dim;
  lines.push(`${bold(`#${rank}`)}  ${cyan(rec.invocationHint)}  — ${bold(rec.skillName)}`);
  if (rec.description) {
    lines.push(`    ${dim(truncateRight(rec.description, 72))}`);
  }
  const savings =
    rec.estimatedTokensSaved > 0
      ? `  |  Est. savings: ${green(formatTokens(rec.estimatedTokensSaved))} tokens` +
        (rec.estimatedUsdSaved > 0 ? ` (${green(formatUsd(rec.estimatedUsdSaved))})` : "")
      : "";
  lines.push(`    Confidence: ${conf(`${rec.confidence}%`)}${savings}`);
  if (rec.evidence.length > 0) {
    lines.push(`    Evidence:`);
    for (const ev of rec.evidence) {
      const ts = ev.timestamp ? `[${ev.timestamp.slice(0, 19).replace("T", " ")}]` : "";
      lines.push(`      ${dim(ts)} turn ${ev.turnIndex}: ${ev.toolCallSummary}`);
    }
  }
  return lines.join("\n");
}

export function renderMarkdownRec(rec: Recommendation, rank: number): string {
  const lines: string[] = [];
  lines.push(`### #${rank} \`${rec.invocationHint}\` — ${rec.skillName}`);
  if (rec.description) lines.push(`> ${rec.description}`);
  lines.push("");
  lines.push(`- **Confidence:** ${rec.confidence}%`);
  if (rec.estimatedTokensSaved > 0) {
    lines.push(
      `- **Est. savings:** ${formatTokens(rec.estimatedTokensSaved)} tokens` +
      (rec.estimatedUsdSaved > 0 ? ` (${formatUsd(rec.estimatedUsdSaved)})` : "")
    );
  }
  if (rec.evidence.length > 0) {
    lines.push("- **Evidence:**");
    for (const ev of rec.evidence) {
      const ts = ev.timestamp ? `\`${ev.timestamp.slice(0, 19)}\`` : "";
      lines.push(`  - Turn ${ev.turnIndex} ${ts}: ${ev.toolCallSummary}`);
    }
  }
  return lines.join("\n");
}
