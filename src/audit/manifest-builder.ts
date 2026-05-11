/**
 * Manifest builder: orchestrates loader → aggregator → correlator → tracker
 * to produce a complete SessionManifest from a session ID.
 *
 * This is the single entry-point callers should use to get a manifest.
 */

import type { Database } from "bun:sqlite";
import type { SessionManifest } from "./manifest-types.ts";
import { loadSession } from "./session-loader.ts";
import { aggregateChanges } from "./change-aggregator.ts";
import { buildReasonMap, attachReasons } from "./reasoning-correlator.ts";
import { trackSubagents, attachParentAgentIds } from "./subagent-tracker.ts";
import { computeSubagentCosts } from "./subagent-cost.ts";
import type { AssistantEvent } from "../parsers/event-types.ts";
import type { UsageTokens } from "../parsers/event-content-types.ts";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a complete SessionManifest for the given session ID.
 *
 * Pipeline:
 *   1. loadSession      — query + hydrate events from DB
 *   2. aggregateChanges — group edits per file path
 *   3. buildReasonMap   — correlate tool_use → preceding assistant text
 *   4. attachReasons    — annotate EditOps with reasoning
 *   5. trackSubagents   — detect Task/Agent spans, build parent map
 *   6. attachParentAgentIds — tag EditOps with parent span id
 *   7. computeTokenTotals — sum usage across all assistant events
 *   8. computeSubagentCosts — per-subagent cost attribution tree
 *
 * @throws Error if sessionId not found in DB.
 */
export function buildManifest(db: Database, sessionId: string): SessionManifest {
  // Step 1: load all events
  const { session, events } = loadSession(db, sessionId);

  // Step 2: aggregate file changes from tool_use blocks
  const fileChanges = aggregateChanges(events);

  // Step 3 + 4: reason correlation
  const reasonMap = buildReasonMap(events);
  attachReasons(fileChanges, reasonMap);

  // Step 5 + 6: subagent tracking
  const { spans, parentMap } = trackSubagents(events);
  attachParentAgentIds(fileChanges, parentMap);

  // Step 7: token totals
  const tokenTotals = computeTokenTotals(events);
  const estimatedCostUsd = computeCostUsd(tokenTotals, session.model);

  // Step 8: per-subagent cost attribution tree
  const subagentCosts = computeSubagentCosts(events, spans, session.model);

  return {
    session,
    events,
    fileChanges,
    subagentSpans: spans,
    tokenTotals,
    estimatedCostUsd,
    subagentCosts,
  };
}

// ── Token accounting ──────────────────────────────────────────────────────────

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

function computeTokenTotals(
  events: import("./manifest-types.ts").HydratedEvent[]
): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

  for (const he of events) {
    if (he.event.kind !== "assistant") continue;
    const ae = he.event as AssistantEvent;
    const usage = ae.message.usage as UsageTokens | undefined;
    if (!usage) continue;

    totals.input += usage.input_tokens ?? 0;
    totals.output += usage.output_tokens ?? 0;
    totals.cacheRead += usage.cache_read_input_tokens ?? 0;
    totals.cacheCreate += usage.cache_creation_input_tokens ?? 0;
  }

  return totals;
}

/**
 * Rough cost estimate based on Anthropic published pricing (May 2026).
 * Returns null for unknown model strings.
 *
 * Prices per million tokens (USD):
 *   claude-opus-4*   input=15, output=75, cacheRead=1.50, cacheWrite=18.75
 *   claude-sonnet-4* input=3,  output=15, cacheRead=0.30, cacheWrite=3.75
 *   claude-haiku-3*  input=0.25,output=1.25
 */
function computeCostUsd(totals: TokenTotals, model: string): number | null {
  const m = model.toLowerCase();

  let inputPer1M: number;
  let outputPer1M: number;
  let cacheReadPer1M: number;
  let cacheWritePer1M: number;

  if (m.includes("opus")) {
    inputPer1M = 15; outputPer1M = 75; cacheReadPer1M = 1.5; cacheWritePer1M = 18.75;
  } else if (m.includes("sonnet")) {
    inputPer1M = 3; outputPer1M = 15; cacheReadPer1M = 0.3; cacheWritePer1M = 3.75;
  } else if (m.includes("haiku")) {
    inputPer1M = 0.25; outputPer1M = 1.25; cacheReadPer1M = 0.03; cacheWritePer1M = 0.3;
  } else {
    return null;
  }

  const M = 1_000_000;
  return (
    (totals.input * inputPer1M) / M +
    (totals.output * outputPer1M) / M +
    (totals.cacheRead * cacheReadPer1M) / M +
    (totals.cacheCreate * cacheWritePer1M) / M
  );
}
