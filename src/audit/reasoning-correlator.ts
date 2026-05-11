/**
 * Reasoning correlator: for each tool_use block in an assistant event, finds
 * the last assistant text content block in the same "turn" and attaches it as
 * the reasoning string on the corresponding EditOp entries.
 *
 * Turn boundary: a sequence of events bounded by user messages (kind="user").
 * Any user event resets the current turn's assistant text buffer.
 *
 * Algorithm:
 *   1. Walk events in order, tracking lastAssistantText per turn.
 *   2. On each assistant event that contains tool_use blocks, record
 *      toolUseId → reason in a Map.
 *   3. Callers use lookupReason(toolUseId) to annotate EditOps.
 */

import type { HydratedEvent } from "./manifest-types.ts";
import type { AssistantEvent, TextContent, ToolUseContent } from "../parsers/event-types.ts";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a Map<toolUseId, reasonText> by correlating tool_use blocks with the
 * last assistant text message in the same conversation turn.
 *
 * A turn ends at every user event (role="user", not isMeta system events).
 */
export function buildReasonMap(events: HydratedEvent[]): Map<string, string> {
  const reasonMap = new Map<string, string>();
  // Buffer: last non-empty assistant text seen in current turn
  let lastAssistantText = "";

  for (const he of events) {
    const { event } = he;

    // User event (non-meta) resets the turn text buffer
    if (event.kind === "user" && !(event as { isMeta?: boolean }).isMeta) {
      lastAssistantText = "";
      continue;
    }

    if (event.kind !== "assistant") continue;
    const ae = event as AssistantEvent;

    // Collect text and tool_use blocks in content order
    for (const block of ae.message.content) {
      if (block.type === "text") {
        const text = (block as TextContent).text.trim();
        if (text) {
          lastAssistantText = text;
        }
      } else if (block.type === "tool_use") {
        const tb = block as ToolUseContent;
        // Associate the tool call with the assistant text seen so far in this turn
        if (lastAssistantText) {
          reasonMap.set(tb.id, lastAssistantText);
        }
      }
    }
  }

  return reasonMap;
}

/**
 * Attach reasoning strings from reasonMap to EditOps in fileChanges.
 * Mutates EditOp.reason in place.
 */
export function attachReasons(
  fileChanges: Map<string, import("./manifest-types.ts").FileChange>,
  reasonMap: Map<string, string>
): void {
  for (const fc of fileChanges.values()) {
    for (const op of fc.ops) {
      if (op.toolUseId) {
        const reason = reasonMap.get(op.toolUseId);
        if (reason) op.reason = reason;
      }
    }
  }
}
