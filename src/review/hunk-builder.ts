/**
 * Hunk builder — expand a SessionManifest's FileChange map into a flat Hunk[]
 * suitable for review (one EditOp = one hunk).
 *
 * Pure data transformation: no IO, no side effects.
 */

import type { SessionManifest, EditOp } from "../audit/manifest-types.ts";
import type { Hunk, UnreviewableReason, RevertKind } from "./hunk-types.ts";

/** Heuristic: treat content as binary if it contains a NUL byte in the first 8KB. */
function looksBinary(s: string): boolean {
  const probe = s.length > 8192 ? s.slice(0, 8192) : s;
  for (let i = 0; i < probe.length; i++) {
    if (probe.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** Classify whether an op produces a reviewable hunk + how to revert. */
function classify(op: EditOp): {
  unreviewable: boolean;
  reason?: UnreviewableReason;
  revertKind: RevertKind;
} {
  // Write with no prior state ⇒ revert means deletion. NOT unreviewable.
  if (op.type === "Write" && op.before === undefined) {
    return { unreviewable: false, revertKind: "delete" };
  }
  if (op.unknownBefore) return { unreviewable: true, reason: "unknown-before", revertKind: "patch" };
  if (op.before === undefined) return { unreviewable: true, reason: "unknown-before", revertKind: "patch" };
  if (op.before === op.after) return { unreviewable: true, reason: "identical", revertKind: "patch" };
  if (looksBinary(op.before) || looksBinary(op.after)) {
    return { unreviewable: true, reason: "binary", revertKind: "patch" };
  }
  return { unreviewable: false, revertKind: "patch" };
}

/**
 * Flatten every FileChange.ops into Hunks, preserving chronological order.
 * Hunks are returned grouped by file (in the order files appear in the Map),
 * and ordered by EditOp index within each file.
 */
export function explodeHunks(manifest: SessionManifest): Hunk[] {
  const out: Hunk[] = [];
  const sessionId = manifest.session.id;

  for (const [filePath, fc] of manifest.fileChanges) {
    fc.ops.forEach((op, opIndex) => {
      const cls = classify(op);
      out.push({
        id: `${sessionId}:${filePath}:${opIndex}`,
        sessionId,
        filePath,
        opIndex,
        type: op.type,
        timestamp: op.timestamp,
        before: op.before ?? "",
        after: op.after,
        reason: op.reason,
        toolUseId: op.toolUseId,
        unreviewable: cls.unreviewable,
        unreviewableReason: cls.reason,
        revertKind: cls.revertKind,
      });
    });
  }

  return out;
}
