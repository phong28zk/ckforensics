/**
 * Core type definitions for the Session Change Manifest.
 *
 * These types form the data backbone passed between audit modules:
 * loader → aggregator → correlator → tracker → builder → exporter
 */

import type { ParsedEvent } from "../parsers/event-types.ts";

// ── Edit operations ───────────────────────────────────────────────────────────

/** The type of file-modifying tool that generated an EditOp. */
export type EditOpType =
  | "Edit"        // old_string → new_string replacement
  | "Write"       // full file write (no before content)
  | "MultiEdit"   // ordered array of edit sub-operations
  | "NotebookEdit"; // Jupyter notebook cell replacement

/** One discrete edit applied to a file during a session. */
export interface EditOp {
  /** ISO-8601 timestamp of the assistant event that triggered this op. */
  timestamp: string;
  /** Tool that performed the edit. */
  type: EditOpType;
  /** Content before the edit (undefined for Write with no prior state). */
  before?: string;
  /** Content after the edit. */
  after: string;
  /** Optional line range hint for diffing large files. */
  lineRange?: { start: number; end: number };
  /** Reasoning text from preceding assistant message (filled by correlator). */
  reason?: string;
  /** ID of parent subagent Task/Agent tool call, if applicable. */
  parentAgentId?: string;
  /** Tool-use block ID for cross-referencing. */
  toolUseId?: string;
  /** Warning flag: file was not read before edit (diff vs empty may be wrong). */
  unknownBefore?: boolean;
}

// ── Per-file change record ────────────────────────────────────────────────────

/** Aggregated change record for one file path within a session. */
export interface FileChange {
  /** Normalized absolute file path. */
  path: string;
  /** True if the file was created (Write with no prior Edit/Read). */
  isNew: boolean;
  /** Chronological list of edits applied to this file. */
  ops: EditOp[];
  /** Net lines added (last state vs empty / first known state). */
  linesAdded: number;
  /** Net lines removed. */
  linesRemoved: number;
}

// ── Subagent span ─────────────────────────────────────────────────────────────

/** Tracks a Task or Agent tool call and all events within its span. */
export interface SubagentSpan {
  /** Tool-use block ID of the Task/Agent invocation. */
  id: string;
  /** "Task" | "Agent" */
  toolName: string;
  /** Input summary (task description, truncated). */
  inputSummary: string;
  /** ID of the parent span, or null for top-level. */
  parentId: string | null;
  /** Nesting depth (0 = top-level subagent). */
  depth: number;
  /** Timestamp of the tool_use event opening this span. */
  openedAt: string;
  /** Timestamp of the tool_result event closing this span (if closed). */
  closedAt?: string;
  /** event_ids of all events falling within this span. */
  eventIds: string[];
}

// ── Session manifest ──────────────────────────────────────────────────────────

/** Session metadata from the sessions table. */
export interface SessionInfo {
  id: string;
  projectSlug: string;
  startedAt: string;
  endedAt: string;
  model: string;
  totalEvents: number;
}

/** Fully hydrated events row, raw_json parsed into ParsedEvent. */
export interface HydratedEvent {
  eventId: string;
  sessionId: string;
  type: string;
  timestamp: string | null;
  event: ParsedEvent;
}

// ── Subagent cost tree ────────────────────────────────────────────────────────

/**
 * A tree node representing one subagent dispatch with its recursive cost.
 * Parent nodes include child costs in their totals (gross, not net).
 * Children render indented underneath for user visibility.
 */
export interface SubagentCostNode {
  /** Tool-use block ID (matches SubagentSpan.id). */
  toolUseId: string;
  /** "Task" | "Agent" */
  subagentType: string;
  /** First arg / task description (from inputSummary). */
  description: string;
  /** ISO-8601 timestamp when span opened. */
  startedAt: string;
  /** ISO-8601 timestamp when span closed (null if still open). */
  endedAt: string | null;
  /** Wall-clock duration in milliseconds (null if still open). */
  durationMs: number | null;
  /** Gross token counts for this span (INCLUDES nested child tokens). */
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  /** Gross USD cost estimate (INCLUDES nested children; null if model unknown). */
  costUsd: number | null;
  /** Count of tool_use blocks inside span (all depths). */
  childToolCalls: number;
  /** Nested subagent nodes, sorted by cost DESC. */
  children: SubagentCostNode[];
}

/** Top-level manifest assembled from one session. */
export interface SessionManifest {
  session: SessionInfo;
  /** All hydrated events ordered by timestamp. */
  events: HydratedEvent[];
  /** File changes keyed by normalized path. */
  fileChanges: Map<string, FileChange>;
  /** Subagent spans detected in this session. */
  subagentSpans: SubagentSpan[];
  /** Total input/output token counts across all assistant events. */
  tokenTotals: { input: number; output: number; cacheRead: number; cacheCreate: number };
  /** Estimated cost in USD (null if pricing unknown). */
  estimatedCostUsd: number | null;
  /** Per-subagent cost breakdown tree (empty array if no subagents). */
  subagentCosts?: SubagentCostNode[];
}
