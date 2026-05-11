/**
 * Rendering helpers for the `ckforensics map` command.
 *
 * Extracted from map.ts to keep file sizes under 200 lines.
 * Handles heatmap row building, text heatmap rendering, and item display helpers.
 */

import type { ContextItem, HeatmapRow } from "../../context-map/types.ts";
import { truncateRight } from "../output-formatter.ts";
import { cyan, blue, green, yellow, dim } from "../color.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const BAR_WIDTH = 20;

// ── Category helpers (shared across map.ts and map-renderers.ts) ──────────────

export function itemCategory(item: ContextItem): string {
  const src = item.source;
  switch (src.type) {
    case "tool_result":       return `tool:${src.toolName}`;
    case "assistant_message": return "assistant";
    case "user_message":      return "user";
    case "system_prompt":     return "system";
    case "memory":            return "memory";
    case "skill_load":        return `skill:${src.skillName}`;
    case "unknown":           return "unknown";
  }
}

export function itemPreview(item: ContextItem): string {
  const src = item.source;
  switch (src.type) {
    case "tool_result":       return src.preview;
    case "assistant_message": return src.preview;
    case "user_message":      return src.preview;
    case "system_prompt":     return "(system prompt)";
    case "memory":            return src.entry;
    case "skill_load":        return src.skillName;
    case "unknown":           return src.raw;
  }
}

export function itemSummary(it: ContextItem) {
  return {
    id: it.id,
    category: itemCategory(it),
    tokens: it.tokens,
    turnIndex: it.turnIndex,
    preview: itemPreview(it).slice(0, 80),
  };
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

function colorForCategory(cat: string): (s: string) => string {
  if (cat.startsWith("tool:"))  return cyan;
  if (cat === "assistant")      return blue;
  if (cat === "user")           return green;
  if (cat === "system")         return yellow;
  if (cat === "memory")         return yellow;
  if (cat.startsWith("skill:")) return green;
  return dim;
}

export function buildHeatmapRows(items: ContextItem[], topN: number): HeatmapRow[] {
  const byCategory = new Map<string, { count: number; tokens: number }>();
  for (const it of items) {
    const cat = itemCategory(it);
    const cur = byCategory.get(cat) ?? { count: 0, tokens: 0 };
    cur.count++;
    cur.tokens += it.tokens;
    byCategory.set(cat, cur);
  }

  const total = [...byCategory.values()].reduce((s, v) => s + v.tokens, 0) || 1;
  const rows: HeatmapRow[] = [...byCategory.entries()].map(([cat, v]) => {
    const pct = (v.tokens / total) * 100;
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    return { category: cat, itemCount: v.count, tokens: v.tokens, pct, bar };
  });

  rows.sort((a, b) => b.tokens - a.tokens);
  return rows.slice(0, topN);
}

export function renderHeatmap(rows: HeatmapRow[], totalTokens: number): string {
  const lines: string[] = [];
  for (const row of rows) {
    const color = colorForCategory(row.category);
    const cat = color(truncateRight(row.category, 22).padEnd(22));
    const pct = `${row.pct.toFixed(1).padStart(5)}%`;
    const tok = dim(`${row.tokens.toLocaleString()} tok`);
    const cnt = dim(`(${row.itemCount})`);
    lines.push(`${cat}  ${row.bar}  ${pct}  ${tok} ${cnt}`);
  }
  lines.push("");
  lines.push(
    dim(`Total: ${totalTokens.toLocaleString()} tokens  `) +
    dim("(±20% attribution margin — heuristic)")
  );
  return lines.join("\n") + "\n";
}
