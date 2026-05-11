/**
 * Inserts derived rows for assistant events: tool_calls and token_usage.
 *
 * Called from ingest.ts after a new event row is confirmed inserted.
 * Kept in a separate file to stay under the 200-line file limit.
 */

import type { AssistantEvent } from "../parsers/event-types.ts";
import type { ToolUseContent } from "../parsers/event-content-types.ts";
import type { IngestStmts } from "./ingest-stmts.ts";

/** Max chars of serialised tool input to store as summary. */
const INPUT_SUMMARY_MAX = 256;

/**
 * Insert tool_call and token_usage rows for one assistant event.
 *
 * Both inserts use INSERT OR IGNORE so repeated calls are safe.
 *
 * @param stmts     Shared prepared statements from the parent ingest run.
 * @param event     The classified AssistantEvent.
 * @param eventId   Deterministic 16-hex event ID for FK reference.
 * @param sessionId Session UUID for FK reference.
 */
export function insertAssistantDerived(
  stmts: IngestStmts,
  event: AssistantEvent,
  eventId: string,
  sessionId: string
): void {
  insertTokenUsage(stmts, event, eventId, sessionId);
  insertToolCalls(stmts, event, eventId, sessionId);
}

function insertTokenUsage(
  stmts: IngestStmts,
  event: AssistantEvent,
  eventId: string,
  sessionId: string
): void {
  const usage = event.message.usage;
  if (!usage) return;

  stmts.insertTokenUsage.run({
    $eventId: eventId,
    $sessionId: sessionId,
    $input: usage.input_tokens,
    $output: usage.output_tokens,
    $cacheRead: usage.cache_read_input_tokens ?? 0,
    $cacheCreate: usage.cache_creation_input_tokens ?? 0,
  });
}

function insertToolCalls(
  stmts: IngestStmts,
  event: AssistantEvent,
  eventId: string,
  sessionId: string
): void {
  for (const block of event.message.content) {
    if (block.type !== "tool_use") continue;

    const tb = block as ToolUseContent;
    const inputSummary = JSON.stringify(tb.input ?? {}).slice(0, INPUT_SUMMARY_MAX);

    stmts.insertToolCall.run({
      $id: tb.id,
      $eventId: eventId,
      $sessionId: sessionId,
      $name: tb.name,
      $summary: inputSummary,
    });
  }
}
