/**
 * Content block types that appear inside message.content[] arrays.
 * Extracted from event-types.ts to keep files under 200 lines.
 */

// ── Usage / token tracking ──────────────────────────────────────────────────

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Nested breakdown returned by newer API versions */
  cache_creation?: Record<string, number>;
}

// ── Message content block types ─────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  /** Arbitrary JSON input — kept as unknown for safety */
  input: unknown;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  /** Content may be a string or an array of text blocks */
  content: string | Array<{ type: string; text?: string }>;
}

export type MessageContent =
  | TextContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent
  | { type: string; [k: string]: unknown }; // catch-all for future block types

// ── Shared envelope fields present on most event rows ───────────────────────

export interface EventEnvelope {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  userType?: string;
  entrypoint?: string;
}
