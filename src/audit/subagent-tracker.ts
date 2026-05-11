/**
 * Subagent tracker: detects Task/Agent tool_use open events and their paired
 * tool_result close events, building a stack-based tree of SubagentSpan records.
 *
 * All events that fall within a span's open→close window are tagged with the
 * span's id as parentAgentId. Handles nesting up to arbitrary depth (tested
 * to 5 levels per spec).
 *
 * Algorithm:
 *   - Walk events in order.
 *   - On assistant event with tool_use name∈{Task,Agent}: push span onto stack.
 *   - On user event with tool_result matching open span's id: pop stack, close span.
 *   - All events between open and close inherit parent_agent_id = span.id.
 *
 * Note: Claude Code emits tool_result in user events as message.content[].
 */

import type { HydratedEvent, SubagentSpan } from "./manifest-types.ts";
import type {
  AssistantEvent,
  UserEvent,
  ToolUseContent,
  ToolResultContent,
} from "../parsers/event-types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const MAX_NESTING = 10; // safety cap; spec requires 5

// ── Public API ────────────────────────────────────────────────────────────────

export interface TrackingResult {
  /** All detected subagent spans (closed and still-open). */
  spans: SubagentSpan[];
  /**
   * Map from tool_use block ID → immediate parent span id.
   * Used by attachParentAgentIds to tag EditOps that were issued inside a span.
   */
  parentMap: Map<string, string>;
}

/**
 * Walk events and build the subagent span tree.
 *
 * Returns:
 *   - spans: every detected SubagentSpan in open order
 *   - parentMap: toolUseId → parentSpanId for tagging EditOps
 */
export function trackSubagents(events: HydratedEvent[]): TrackingResult {
  const spans: SubagentSpan[] = [];
  // Stack of currently open spans (innermost last)
  const stack: SubagentSpan[] = [];
  // toolUseId → parent span id (for file-editing tool calls inside spans)
  const parentMap = new Map<string, string>();

  for (const he of events) {
    if (he.event.kind === "assistant") {
      // For each tool_use block in this event, if we're inside a span,
      // record toolUseId → current parent span id
      const parentSpan = stack.length > 0 ? stack[stack.length - 1] : null;
      if (parentSpan && he.event.kind === "assistant") {
        const ae = he.event as AssistantEvent;
        for (const block of ae.message.content) {
          if (block.type === "tool_use") {
            const tb = block as ToolUseContent;
            parentMap.set(tb.id, parentSpan.id);
          }
        }
      }
      handleAssistantEvent(he, stack, spans);
    } else if (he.event.kind === "user") {
      handleUserEvent(he, stack);
    }
  }

  return { spans, parentMap };
}

/**
 * Attach parentAgentId to EditOps whose toolUseId maps to a span's eventId.
 *
 * Uses parentMap: toolUseId → span id (via the event that contained the tool call).
 */
export function attachParentAgentIds(
  fileChanges: Map<string, import("./manifest-types.ts").FileChange>,
  parentMap: Map<string, string>
): void {
  for (const fc of fileChanges.values()) {
    for (const op of fc.ops) {
      if (op.toolUseId) {
        const spanId = parentMap.get(op.toolUseId);
        if (spanId) op.parentAgentId = spanId;
      }
    }
  }
}

// ── Internal handlers ─────────────────────────────────────────────────────────

function handleAssistantEvent(
  he: HydratedEvent,
  stack: SubagentSpan[],
  spans: SubagentSpan[]
): void {
  const ae = he.event as AssistantEvent;
  for (const block of ae.message.content) {
    if (block.type !== "tool_use") continue;
    const tb = block as ToolUseContent;
    if (!SUBAGENT_TOOLS.has(tb.name)) continue;
    if (stack.length >= MAX_NESTING) continue; // safety

    const input = tb.input as Record<string, unknown> | null ?? {};
    const inputSummary = summarizeInput(input);
    const parentSpan = stack.length > 0 ? stack[stack.length - 1] : null;

    const span: SubagentSpan = {
      id: tb.id,
      toolName: tb.name,
      inputSummary,
      parentId: parentSpan?.id ?? null,
      depth: stack.length,
      openedAt: he.timestamp ?? "",
      eventIds: [],
    };

    stack.push(span);
    spans.push(span);
  }
}

function handleUserEvent(he: HydratedEvent, stack: SubagentSpan[]): void {
  const ue = he.event as UserEvent;
  const content = ue.message.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if ((block as { type: string }).type !== "tool_result") continue;
    const tr = block as ToolResultContent;
    const toolUseId = tr.tool_use_id;

    // Find matching open span (search from top of stack downward)
    const idx = findSpanIndex(stack, toolUseId);
    if (idx === -1) continue;

    // Close all spans from idx upward (handles abrupt termination in deep nesting)
    for (let i = stack.length - 1; i >= idx; i--) {
      const span = stack[i]!;
      span.closedAt = he.timestamp ?? "";
      // Remove from stack
      stack.splice(i, 1);
    }
  }
}

function findSpanIndex(stack: SubagentSpan[], toolUseId: string): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.id === toolUseId) return i;
  }
  return -1;
}

function summarizeInput(input: Record<string, unknown>): string {
  // Task tool typically has "description" or "prompt" field
  const desc =
    (typeof input["description"] === "string" ? input["description"] : null) ??
    (typeof input["prompt"] === "string" ? input["prompt"] : null) ??
    JSON.stringify(input);
  return desc.slice(0, 200);
}
