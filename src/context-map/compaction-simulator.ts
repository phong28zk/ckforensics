/**
 * Compaction simulator: projects which context items Claude Code would drop
 * during its auto-compact operation.
 *
 * Simulator version: v1 (heuristic — may diverge from CC's actual algorithm).
 * Include simulatorVersion in all JSON output so users can track accuracy
 * over time as CC evolves.
 *
 * Documented CC compaction heuristic (as of CC v1.x):
 *   1. Trigger: context window used_percentage exceeds threshold (~80-90%).
 *   2. Drop oldest tool_results first (biggest context consumers).
 *   3. Preserve: all user messages, all assistant reasoning blocks,
 *      the N most-recent tool_results (default N=5).
 *   4. Repeat until used_percentage drops to targetPct (default 50%).
 *
 * Configuration: reads ~/.config/ckforensics/compact.toml if present.
 * Falls back to hardcoded defaults when file is absent or malformed.
 *
 * TOML schema (all keys optional):
 *   target_pct = 50
 *   context_window_tokens = 200000
 *   keep_recent_tool_results = 5
 */

import type { ContextItem, CompactionResult } from "./types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Simulator version ─────────────────────────────────────────────────────────

export const SIMULATOR_VERSION = "v1";

// ── Default config ────────────────────────────────────────────────────────────

interface CompactConfig {
  targetPct: number;
  contextWindowTokens: number;
  keepRecentToolResults: number;
}

const DEFAULT_CONFIG: CompactConfig = {
  targetPct: 50,
  contextWindowTokens: 200_000,
  keepRecentToolResults: 5,
};

// ── Public API ────────────────────────────────────────────────────────────────

export interface SimulateOptions {
  /** Target context window occupancy after compaction (0-100, default 50). */
  targetPct?: number;
  /** Assumed total context window size in tokens (default 200 000). */
  contextWindowTokens?: number;
  /** Number of most-recent tool_results to always preserve (default 5). */
  keepRecentToolResults?: number;
}

/**
 * Simulate Claude Code's context compaction on a list of context items.
 *
 * Items are assumed to represent the full current context window.
 * Returns kept/dropped split with token totals.
 *
 * @param items   Ordered context items (typically from a snapshot).
 * @param opts    Override thresholds (merged over file config then defaults).
 */
export function simulateCompaction(
  items: ContextItem[],
  opts: SimulateOptions = {}
): CompactionResult {
  const cfg = mergeConfig(opts);
  const targetTokens = Math.floor(
    (cfg.targetPct / 100) * cfg.contextWindowTokens
  );
  const totalTokens = items.reduce((s, it) => s + it.tokens, 0);

  if (totalTokens <= targetTokens) {
    // Already below target — nothing to drop
    return buildResult(items, [], cfg);
  }

  // Separate items into categories
  const toolResults = items
    .filter((it) => it.source.type === "tool_result")
    .slice() // copy — we mutate via sort
    .sort((a, b) => a.turnIndex - b.turnIndex); // oldest first

  const protected_ = items.filter((it) => it.source.type !== "tool_result");

  // Always keep the N most-recent tool_results
  const recentCount = Math.min(cfg.keepRecentToolResults, toolResults.length);
  const recentKept = toolResults.slice(-recentCount);
  const candidates = toolResults.slice(0, toolResults.length - recentCount);

  // Base tokens = everything that cannot be dropped (protected + recentKept)
  const baseTokens =
    protected_.reduce((s, it) => s + it.tokens, 0) +
    recentKept.reduce((s, it) => s + it.tokens, 0);

  // Greedily keep oldest candidates until adding one would exceed target
  let runningTokens = baseTokens;
  const dropped: ContextItem[] = [];
  const keptCandidates: ContextItem[] = [];

  // Walk candidates oldest→newest.
  // We drop items until runningTokens + remaining candidates ≤ targetTokens.
  // Simpler: accumulate from the end (newest candidates kept first, oldest dropped).
  // Reverse candidates so we evaluate newest first for keeping.
  const reversed = [...candidates].reverse();
  for (const item of reversed) {
    if (runningTokens + item.tokens <= targetTokens) {
      keptCandidates.push(item);
      runningTokens += item.tokens;
    } else {
      dropped.push(item);
    }
  }

  // Recalculate: start from protected_ + recentKept + keptCandidates
  const kept = [...protected_, ...recentKept, ...keptCandidates];

  return buildResult(kept, dropped, cfg);
}

// ── Config loading ────────────────────────────────────────────────────────────

function mergeConfig(opts: SimulateOptions): CompactConfig {
  const file = loadFileConfig();
  return {
    targetPct: opts.targetPct ?? file.targetPct ?? DEFAULT_CONFIG.targetPct,
    contextWindowTokens:
      opts.contextWindowTokens ??
      file.contextWindowTokens ??
      DEFAULT_CONFIG.contextWindowTokens,
    keepRecentToolResults:
      opts.keepRecentToolResults ??
      file.keepRecentToolResults ??
      DEFAULT_CONFIG.keepRecentToolResults,
  };
}

function loadFileConfig(): Partial<CompactConfig> {
  const configPath = join(
    homedir(),
    ".config",
    "ckforensics",
    "compact.toml"
  );
  try {
    const text = readFileSync(configPath, "utf-8");
    return parseSimpleToml(text);
  } catch {
    // File absent or unreadable — use defaults
    return {};
  }
}

/**
 * Minimal TOML parser for the three known scalar keys.
 * Full TOML parsing is not warranted for this small config surface.
 */
function parseSimpleToml(text: string): Partial<CompactConfig> {
  const result: Partial<CompactConfig> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = parseInt(trimmed.slice(eq + 1).trim(), 10);
    if (isNaN(val)) continue;
    if (key === "target_pct") result.targetPct = val;
    if (key === "context_window_tokens") result.contextWindowTokens = val;
    if (key === "keep_recent_tool_results") result.keepRecentToolResults = val;
  }
  return result;
}

// ── Result builder ────────────────────────────────────────────────────────────

function buildResult(
  kept: ContextItem[],
  dropped: ContextItem[],
  cfg: CompactConfig
): CompactionResult {
  return {
    kept,
    dropped,
    keptTokens: kept.reduce((s, it) => s + it.tokens, 0),
    droppedTokens: dropped.reduce((s, it) => s + it.tokens, 0),
    targetPct: cfg.targetPct,
    contextWindowTokens: cfg.contextWindowTokens,
    simulatorVersion: SIMULATOR_VERSION,
  };
}
