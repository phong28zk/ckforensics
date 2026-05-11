/**
 * Pattern detector: mines repeated tool-use sequences from session events.
 *
 * Detects 5 pattern types with configurable thresholds.
 * Threshold logic and per-pattern functions live in pattern-detector-helpers.ts.
 * This module handles event → AssistantTurn conversion and orchestration.
 *
 * Runs <1s on 100k events (single linear pass per pattern).
 */

import type { AssistantEvent, ToolUseContent } from "../parsers/event-types.ts";
import type { HydratedEvent } from "../audit/manifest-types.ts";
import type { Pattern } from "./types.ts";
import type { AssistantTurn } from "./pattern-detector-types.ts";
import {
  detectReadFanout,
  detectTestLoop,
  detectManualDiffCycle,
  detectGrepWalk,
  detectSubagentSkip,
} from "./pattern-detector-helpers.ts";

// ── Turn extraction ───────────────────────────────────────────────────────────

function getToolUses(event: AssistantEvent): ToolUseContent[] {
  return event.message.content.filter(
    (c): c is ToolUseContent => c.type === "tool_use"
  );
}

function roughTokens(event: AssistantEvent): number {
  const usage = event.message.usage;
  if (usage) return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  return Math.ceil(JSON.stringify(event.message.content).length / 4);
}

function extractAssistantTurns(events: HydratedEvent[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  let idx = 0;
  for (const he of events) {
    if (he.event.kind !== "assistant") continue;
    const ae = he.event as AssistantEvent;
    turns.push({
      index: idx++,
      timestamp: he.event.timestamp ?? new Date(0).toISOString(),
      toolUses: getToolUses(ae),
      tokens: roughTokens(ae),
    });
  }
  return turns;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect all behavioral patterns in a session's hydrated events.
 * Returns array of detected patterns (may be empty).
 */
export function detectPatterns(events: HydratedEvent[]): Pattern[] {
  const turns = extractAssistantTurns(events);
  if (turns.length === 0) return [];

  const patterns: Pattern[] = [];

  const readFanout = detectReadFanout(turns);
  if (readFanout) patterns.push(readFanout);

  const testLoop = detectTestLoop(turns);
  if (testLoop) patterns.push(testLoop);

  const diffCycle = detectManualDiffCycle(turns);
  if (diffCycle) patterns.push(diffCycle);

  const grepWalk = detectGrepWalk(turns);
  if (grepWalk) patterns.push(grepWalk);

  const subagentSkip = detectSubagentSkip(turns);
  if (subagentSkip) patterns.push(subagentSkip);

  return patterns;
}
