/**
 * Internal types for pattern-detector: AssistantTurn intermediate structure.
 * Kept separate to avoid circular imports between detector and helpers.
 */

import type { ToolUseContent } from "../parsers/event-types.ts";

export interface AssistantTurn {
  /** 0-based index within the session's assistant event sequence. */
  index: number;
  /** ISO-8601 timestamp from the event envelope. */
  timestamp: string;
  /** All tool_use content blocks from this assistant turn. */
  toolUses: ToolUseContent[];
  /** Approximate token count (from usage if present, else char-based estimate). */
  tokens: number;
}
