/**
 * Type definitions for the Post-Session Edit Review feature.
 *
 * A Hunk is one reviewable edit derived from a SessionManifest's FileChange/EditOp.
 * MultiEdit expands into multiple Hunks (one per sub-op).
 */

import type { EditOpType } from "../audit/manifest-types.ts";

/** Decision a user (or batch file) records for a hunk. */
export type HunkDecision = "keep" | "revert" | "skip" | "unreviewable";

/** Reason a hunk cannot be reverted. */
export type UnreviewableReason =
  | "unknown-before"        // file not read before edit; no safe `before` content
  | "identical"             // before === after (nothing to revert)
  | "binary";               // looks binary; refuse heuristically

/** How a revert should be performed. */
export type RevertKind = "patch" | "delete";

/** One reviewable unit derived from an EditOp. */
export interface Hunk {
  /** Stable, deterministic ID: `${sessionId}:${filePath}:${opIndex}`. */
  id: string;
  /** Session this hunk belongs to. */
  sessionId: string;
  /** Normalized absolute file path. */
  filePath: string;
  /** Index of the EditOp inside FileChange.ops (0-based). */
  opIndex: number;
  /** Tool type that generated the underlying EditOp. */
  type: EditOpType;
  /** ISO-8601 timestamp from the EditOp. */
  timestamp: string;
  /** Pre-edit content. Empty string when creating a new file. */
  before: string;
  /** Post-edit content. */
  after: string;
  /** Correlated assistant reasoning (truncated upstream by aggregator). */
  reason?: string;
  /** Tool-use block ID, useful for cross-referencing manifest. */
  toolUseId?: string;
  /** If true, hunk cannot be safely reverted (see unreviewableReason). */
  unreviewable: boolean;
  /** Machine-readable reason set when unreviewable=true. */
  unreviewableReason?: UnreviewableReason;
  /** How a revert is applied. "patch" = git apply --reverse; "delete" = rm file. */
  revertKind: RevertKind;
}
