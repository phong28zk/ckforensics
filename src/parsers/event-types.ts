/**
 * Discriminated union of all known Claude Code JSONL event types (schema v1).
 *
 * Content block types and shared envelope are in event-content-types.ts.
 * The `raw` field always carries the original parsed JSON object.
 * Naming: matches the literal `type` string found in .jsonl files.
 */

export type {
  UsageTokens,
  MessageContent,
  TextContent,
  ThinkingContent,
  ToolUseContent,
  ToolResultContent,
  EventEnvelope,
} from "./event-content-types.ts";

import type { EventEnvelope, MessageContent, UsageTokens } from "./event-content-types.ts";

// ── Concrete event types ──────────────────────────────────────────────────────

/** An assistant turn: contains content blocks and usage data. */
export interface AssistantEvent extends EventEnvelope {
  kind: "assistant";
  requestId?: string;
  message: {
    id?: string;
    role: "assistant";
    model?: string;
    content: MessageContent[];
    stop_reason?: string;
    stop_sequence?: string | null;
    usage?: UsageTokens;
  };
  raw: unknown;
}

/** A user turn: may carry tool_result content blocks or plain text. */
export interface UserEvent extends EventEnvelope {
  kind: "user";
  isMeta?: boolean;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
  message: {
    role: "user";
    content: string | MessageContent[];
  };
  raw: unknown;
}

/** System event: lifecycle hooks, stop reasons, local commands. */
export interface SystemEvent extends EventEnvelope {
  kind: "system";
  subtype?: string;
  level?: string;
  content?: string;
  stopReason?: string;
  toolUseID?: string;
  hookCount?: number;
  hookInfos?: unknown[];
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  raw: unknown;
}

/** File snapshot: state of edited files at a point in conversation. */
export interface FileHistorySnapshotEvent {
  kind: "file-history-snapshot";
  messageId?: string;
  isSnapshotUpdate?: boolean;
  snapshot?: unknown;
  raw: unknown;
}

/** Attachment: file or image attached to conversation. */
export interface AttachmentEvent extends EventEnvelope {
  kind: "attachment";
  attachment?: unknown;
  raw: unknown;
}

/** Queue operation: task queue enqueue/dequeue markers. */
export interface QueueOperationEvent {
  kind: "queue-operation";
  operation?: string;
  sessionId?: string;
  timestamp?: string;
  content?: unknown;
  raw: unknown;
}

/** Permission mode change event. */
export interface PermissionModeEvent {
  kind: "permission-mode";
  permissionMode?: string;
  sessionId?: string;
  raw: unknown;
}

/** Last-prompt marker stored at end of session. */
export interface LastPromptEvent {
  kind: "last-prompt";
  lastPrompt?: string;
  sessionId?: string;
  raw: unknown;
}

/** Progress event from hooks/subagents. */
export interface ProgressEvent extends EventEnvelope {
  kind: "progress";
  toolUseID?: string;
  parentToolUseID?: string;
  agentId?: string;
  slug?: string;
  data?: unknown;
  raw: unknown;
}

/**
 * Catch-all for any `type` value not yet handled.
 * Ensures forward-compatibility without throwing on unknown events.
 */
export interface UnknownEvent {
  kind: "unknown";
  originalType: string;
  raw: unknown;
}

// ── Union ─────────────────────────────────────────────────────────────────────

export type ParsedEvent =
  | AssistantEvent
  | UserEvent
  | SystemEvent
  | FileHistorySnapshotEvent
  | AttachmentEvent
  | QueueOperationEvent
  | PermissionModeEvent
  | LastPromptEvent
  | ProgressEvent
  | UnknownEvent;

export type EventKind = ParsedEvent["kind"];
