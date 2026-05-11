/**
 * Subagent cost attribution: computes per-subagent token usage + USD cost
 * from a span tree produced by subagent-tracker.
 *
 * Design: "gross + visible" — parent SubagentCostNode includes child costs
 * in its totals. Children render indented so users can see the breakdown.
 *
 * Algorithm:
 *   1. Build a set of event-ids that fall within each span's open→close window.
 *   2. For each top-level span, sum all assistant-event token usage within
 *      that window (including nested spans — gross totals).
 *   3. Count tool_use blocks within the span's window.
 *   4. Recurse: child spans (depth N+1 with matching parentId) build their
 *      own SubagentCostNodes.
 *   5. Compute USD via model-pricing.ts computeCostUsd().
 */

import type { HydratedEvent, SubagentSpan, SubagentCostNode } from "./manifest-types.ts";
import type { AssistantEvent, ToolUseContent } from "../parsers/event-types.ts";
import type { UsageTokens } from "../parsers/event-content-types.ts";
import { computeCostUsd } from "../lib/model-pricing.ts";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a SubagentCostNode tree from spans and events.
 *
 * @param events  Ordered HydratedEvent list from the session.
 * @param spans   SubagentSpan[] from trackSubagents().
 * @param model   Model string used for USD pricing (e.g. "claude-sonnet-4-6").
 * @returns       Array of top-level SubagentCostNodes (depth === 0).
 */
export function computeSubagentCosts(
  events: HydratedEvent[],
  spans: SubagentSpan[],
  model: string
): SubagentCostNode[] {
  if (spans.length === 0) return [];

  // Pre-index: eventId → event for O(1) lookup
  const eventById = new Map<string, HydratedEvent>(
    events.map((e) => [e.eventId, e])
  );

  // Build event-id ordered list for window queries
  const orderedEventIds = events.map((e) => e.eventId);

  // Build span lookup by id
  const spanById = new Map<string, SubagentSpan>(spans.map((s) => [s.id, s]));

  // Build children map: parentId → child spans
  const childrenOf = new Map<string, SubagentSpan[]>();
  for (const span of spans) {
    const pid = span.parentId ?? "__root__";
    const list = childrenOf.get(pid) ?? [];
    list.push(span);
    childrenOf.set(pid, list);
  }

  // Top-level spans (depth 0)
  const roots = (childrenOf.get("__root__") ?? []).filter((s) => s.depth === 0);

  return roots.map((span) =>
    buildNode(span, events, orderedEventIds, eventById, spanById, childrenOf, model)
  );
}

// ── Internal ──────────────────────────────────────────────────────────────────

function buildNode(
  span: SubagentSpan,
  events: HydratedEvent[],
  orderedEventIds: string[],
  eventById: Map<string, HydratedEvent>,
  spanById: Map<string, SubagentSpan>,
  childrenOf: Map<string, SubagentSpan[]>,
  model: string
): SubagentCostNode {
  // Collect all events in this span's window using timestamps
  const spanEvents = collectSpanEvents(span, events);

  // Sum token usage from assistant events in window (gross — includes children)
  const tokens = sumTokens(spanEvents);

  // Count tool_use blocks in window
  const childToolCalls = countToolUseCalls(spanEvents);

  // Duration
  const durationMs = computeDurationMs(span.openedAt, span.closedAt);

  // USD cost
  const costUsd = computeCostUsd(tokens, model);

  // Recurse into child spans
  const childSpans = childrenOf.get(span.id) ?? [];
  const children = childSpans
    .map((child) =>
      buildNode(child, events, orderedEventIds, eventById, spanById, childrenOf, model)
    )
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  return {
    toolUseId: span.id,
    subagentType: span.toolName,
    description: span.inputSummary,
    startedAt: span.openedAt,
    endedAt: span.closedAt ?? null,
    durationMs,
    tokens,
    costUsd,
    childToolCalls,
    children,
  };
}

/**
 * Collect all events falling within span's open→close window using timestamps.
 * Includes the opening and closing events themselves.
 */
function collectSpanEvents(
  span: SubagentSpan,
  events: HydratedEvent[]
): HydratedEvent[] {
  const openTime = new Date(span.openedAt).getTime();
  const closeTime = span.closedAt ? new Date(span.closedAt).getTime() : Infinity;

  return events.filter((e) => {
    if (!e.timestamp) return false;
    const t = new Date(e.timestamp).getTime();
    return t >= openTime && t <= closeTime;
  });
}

/**
 * Sum token usage from assistant events in the event list.
 */
function sumTokens(events: HydratedEvent[]): SubagentCostNode["tokens"] {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

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
 * Count tool_use content blocks in all assistant events.
 */
function countToolUseCalls(events: HydratedEvent[]): number {
  let count = 0;
  for (const he of events) {
    if (he.event.kind !== "assistant") continue;
    const ae = he.event as AssistantEvent;
    for (const block of ae.message.content) {
      if ((block as ToolUseContent).type === "tool_use") count++;
    }
  }
  return count;
}

function computeDurationMs(openedAt: string, closedAt?: string): number | null {
  if (!closedAt) return null;
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  return isNaN(ms) || ms < 0 ? null : ms;
}
