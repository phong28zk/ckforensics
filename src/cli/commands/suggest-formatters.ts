/**
 * Output formatters for the suggest command.
 * Handles all three recommendation types: skill, process, prompt.
 * Extracted to keep suggest.ts under 200 lines.
 */

import { bold, cyan, blue, yellow, green, dim } from "../color.ts";
import { truncateRight } from "../output-formatter.ts";
import type { Recommendation, SkillRecommendation, ProcessRecommendation, PromptRecommendation } from "../../recommender/types.ts";

// ── Utility helpers ───────────────────────────────────────────────────────────

export function formatUsd(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Color-coded type tag for terminal output. */
function typeTag(rec: Recommendation): string {
  switch (rec.type) {
    case "skill":   return cyan("[Skill]  ");
    case "process": return blue("[Process]");
    case "prompt":  return yellow("[Prompt] ");
  }
}

/** Short label for markdown section heading. */
function typeLabel(rec: Recommendation): string {
  switch (rec.type) {
    case "skill":   return "Skill";
    case "process": return "Process";
    case "prompt":  return "Prompt";
  }
}

// ── Text renderers ────────────────────────────────────────────────────────────

function renderSkillText(rec: SkillRecommendation, rank: number): string {
  const lines: string[] = [];
  const conf = rec.confidence >= 80 ? green : rec.confidence >= 60 ? yellow : dim;
  lines.push(`${bold(`#${rank}`)}  ${typeTag(rec)}  ${cyan(rec.invocationHint)}  — ${bold(rec.skillName)}`);
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

function renderAdviceText(rec: ProcessRecommendation | PromptRecommendation, rank: number): string {
  const lines: string[] = [];
  const conf = rec.confidence >= 80 ? green : rec.confidence >= 60 ? yellow : dim;
  lines.push(`${bold(`#${rank}`)}  ${typeTag(rec)}  ${bold(rec.title)}`);
  lines.push(`    ${dim(truncateRight(rec.description, 72))}`);
  lines.push(`    Confidence: ${conf(`${rec.confidence}%`)}`);
  if (rec.evidence.length > 0) {
    lines.push(`    Evidence:`);
    for (const ev of rec.evidence) {
      const ts = ev.timestamp ? `[${ev.timestamp.slice(0, 19).replace("T", " ")}]` : "";
      lines.push(`      ${dim(ts)} turn ${ev.turnIndex}: ${ev.toolCallSummary}`);
    }
  }
  return lines.join("\n");
}

/** Render a single recommendation as terminal text. */
export function renderTextRec(rec: Recommendation, rank: number): string {
  if (rec.type === "skill") return renderSkillText(rec, rank);
  return renderAdviceText(rec, rank);
}

// ── Markdown renderers ────────────────────────────────────────────────────────

function renderSkillMarkdown(rec: SkillRecommendation, rank: number): string {
  const lines: string[] = [];
  lines.push(`### #${rank} [${typeLabel(rec)}] \`${rec.invocationHint}\` — ${rec.skillName}`);
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

function renderAdviceMarkdown(rec: ProcessRecommendation | PromptRecommendation, rank: number): string {
  const lines: string[] = [];
  lines.push(`### #${rank} [${typeLabel(rec)}] ${rec.title}`);
  lines.push(`> ${rec.description}`);
  lines.push("");
  lines.push(`- **Confidence:** ${rec.confidence}%`);
  if (rec.evidence.length > 0) {
    lines.push("- **Evidence:**");
    for (const ev of rec.evidence) {
      const ts = ev.timestamp ? `\`${ev.timestamp.slice(0, 19)}\`` : "";
      lines.push(`  - Turn ${ev.turnIndex} ${ts}: ${ev.toolCallSummary}`);
    }
  }
  return lines.join("\n");
}

/** Render a single recommendation as Markdown. */
export function renderMarkdownRec(rec: Recommendation, rank: number): string {
  if (rec.type === "skill") return renderSkillMarkdown(rec, rank);
  return renderAdviceMarkdown(rec, rank);
}
