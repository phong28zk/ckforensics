/**
 * Change aggregator: walks hydrated events and builds a Map<filepath, EditOp[]>
 * from Edit, Write, MultiEdit, and NotebookEdit tool calls.
 *
 * Tool input shapes (from Claude Code JSONL):
 *   Edit:        { file_path, old_string, new_string }
 *   Write:       { file_path, content }
 *   MultiEdit:   { file_path, edits: [{ old_string, new_string }] }
 *   NotebookEdit:{ notebook_path, ... new_source }
 */

import type { HydratedEvent, EditOp, EditOpType, FileChange } from "./manifest-types.ts";
import type { AssistantEvent, ToolUseContent } from "../parsers/event-types.ts";

// ── File-touching tool names ──────────────────────────────────────────────────

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Aggregate all file-editing tool calls from a session's events into a
 * Map<filepath, FileChange>.
 *
 * Reads previously-seen file state by tracking the latest "after" content
 * per path so each subsequent Edit can populate `before` correctly.
 */
export function aggregateChanges(
  events: HydratedEvent[]
): Map<string, FileChange> {
  // Tracks the last known content per file path (used to set `before` on edits)
  const lastContent = new Map<string, string>();
  // Result accumulator
  const changes = new Map<string, FileChange>();

  for (const he of events) {
    if (he.event.kind !== "assistant") continue;
    const ae = he.event as AssistantEvent;

    for (const block of ae.message.content) {
      if (block.type !== "tool_use") continue;
      const tb = block as ToolUseContent;
      if (!FILE_EDIT_TOOLS.has(tb.name)) continue;

      const ops = extractOps(tb, he.timestamp ?? "", lastContent);
      for (const op of ops) {
        const key = op.path;
        // Capture isNew BEFORE updating lastContent (so first-ever Write = new file)
        const isFirstSeen = !lastContent.has(key);
        let fc = changes.get(key);
        if (!fc) {
          fc = {
            path: key,
            isNew: isFirstSeen && op.edit.type === "Write",
            ops: [],
            linesAdded: 0,
            linesRemoved: 0,
          };
          changes.set(key, fc);
        }
        fc.ops.push(op.edit);
        // Update last known content
        lastContent.set(key, op.edit.after);
      }
    }
  }

  // Compute net line deltas for each file
  for (const fc of changes.values()) {
    computeLineDelta(fc);
  }

  return changes;
}

// ── Internal extraction ───────────────────────────────────────────────────────

interface ExtractedOp {
  path: string;
  edit: EditOp;
}

function extractOps(
  tb: ToolUseContent,
  timestamp: string,
  lastContent: Map<string, string>
): ExtractedOp[] {
  const input = tb.input as Record<string, unknown> | null ?? {};

  switch (tb.name as EditOpType | string) {
    case "Edit":
      return extractEdit(tb.id, input, timestamp, lastContent);
    case "Write":
      return extractWrite(tb.id, input, timestamp, lastContent);
    case "MultiEdit":
      return extractMultiEdit(tb.id, input, timestamp, lastContent);
    case "NotebookEdit":
      return extractNotebookEdit(tb.id, input, timestamp, lastContent);
    default:
      return [];
  }
}

function extractEdit(
  toolUseId: string,
  input: Record<string, unknown>,
  timestamp: string,
  lastContent: Map<string, string>
): ExtractedOp[] {
  const path = str(input["file_path"]);
  if (!path) return [];

  const oldStr = str(input["old_string"]) ?? "";
  const newStr = str(input["new_string"]) ?? "";

  // Derive `after` by applying the replacement to last known content
  const knownBefore = lastContent.get(path);
  const before = knownBefore ?? oldStr;
  const after = knownBefore
    ? knownBefore.replace(oldStr, newStr)
    : newStr;

  const edit: EditOp = {
    timestamp,
    type: "Edit",
    before,
    after,
    toolUseId,
    unknownBefore: knownBefore === undefined,
  };

  return [{ path, edit }];
}

function extractWrite(
  toolUseId: string,
  input: Record<string, unknown>,
  timestamp: string,
  lastContent: Map<string, string>
): ExtractedOp[] {
  const path = str(input["file_path"]);
  if (!path) return [];

  const after = str(input["content"]) ?? "";
  const before = lastContent.get(path);

  const edit: EditOp = {
    timestamp,
    type: "Write",
    before,
    after,
    toolUseId,
    unknownBefore: before === undefined,
  };

  return [{ path, edit }];
}

function extractMultiEdit(
  toolUseId: string,
  input: Record<string, unknown>,
  timestamp: string,
  lastContent: Map<string, string>
): ExtractedOp[] {
  const path = str(input["file_path"]);
  if (!path) return [];

  const edits = input["edits"];
  if (!Array.isArray(edits)) return [];

  // Apply edits in order to build a single net EditOp
  const initialContent = lastContent.get(path);
  let current = initialContent ?? "";
  const unknownBefore = initialContent === undefined;

  for (const e of edits as Record<string, unknown>[]) {
    const oldStr = str(e["old_string"]) ?? "";
    const newStr = str(e["new_string"]) ?? "";
    current = current.replace(oldStr, newStr);
  }

  const edit: EditOp = {
    timestamp,
    type: "MultiEdit",
    before: initialContent,
    after: current,
    toolUseId,
    unknownBefore,
  };

  return [{ path, edit }];
}

function extractNotebookEdit(
  toolUseId: string,
  input: Record<string, unknown>,
  timestamp: string,
  lastContent: Map<string, string>
): ExtractedOp[] {
  const path = str(input["notebook_path"]);
  if (!path) return [];

  // NotebookEdit replaces a cell's source; represent as text content change
  const newSource = str(input["new_source"]) ?? "";
  const cellId = str(input["cell_id"]) ?? "";
  const marker = `[cell:${cellId}]`;
  const after = `${marker}\n${newSource}`;
  const before = lastContent.get(path);

  const edit: EditOp = {
    timestamp,
    type: "NotebookEdit",
    before,
    after,
    toolUseId,
    unknownBefore: before === undefined,
  };

  return [{ path, edit }];
}

// ── Line delta computation ────────────────────────────────────────────────────

function computeLineDelta(fc: FileChange): void {
  if (fc.ops.length === 0) return;

  const first = fc.ops[0];
  const last = fc.ops[fc.ops.length - 1];

  // Count non-empty lines to handle trailing newline artefacts
  const countLines = (s: string): number =>
    s === "" ? 0 : s.split("\n").filter((l) => l !== "").length;

  const beforeLines = countLines(first?.before ?? "");
  const afterLines = countLines(last?.after ?? "");

  fc.linesAdded = Math.max(0, afterLines - beforeLines);
  fc.linesRemoved = Math.max(0, beforeLines - afterLines);
}

// ── Micro-helpers ─────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
