/**
 * Extracts file-touch operations from assistant tool calls and inserts into
 * the `files_touched` table during ingest.
 *
 * Approximations:
 *  - action: "create" for Write, "edit" for Edit/MultiEdit/NotebookEdit
 *  - lines_added: newline count in new content (Write content / Edit new_string / etc.)
 *  - lines_removed: newline count in replaced/prior content
 *
 * Exact net diffs are computed at audit time; ingest values are summary-grade.
 */

import type { AssistantEvent } from "../parsers/event-types.ts";
import type { ToolUseContent } from "../parsers/event-content-types.ts";
import type { IngestStmts } from "./ingest-stmts.ts";

interface FileTouch {
  path: string;
  action: "create" | "edit";
  linesAdded: number;
  linesRemoved: number;
}

function countLines(s: string | null | undefined): number {
  if (!s) return 0;
  // Count newlines + 1 if non-empty; matches "lines of content" intuition.
  const newlines = (s.match(/\n/g) ?? []).length;
  return s.length > 0 ? newlines + (s.endsWith("\n") ? 0 : 1) : 0;
}

function extractFromTool(tool: ToolUseContent): FileTouch[] {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  switch (tool.name) {
    case "Write": {
      const path = input.file_path as string | undefined;
      if (!path) return [];
      return [{ path, action: "create", linesAdded: countLines(input.content as string), linesRemoved: 0 }];
    }
    case "Edit": {
      const path = input.file_path as string | undefined;
      if (!path) return [];
      return [{
        path,
        action: "edit",
        linesAdded: countLines(input.new_string as string),
        linesRemoved: countLines(input.old_string as string),
      }];
    }
    case "MultiEdit": {
      const path = input.file_path as string | undefined;
      const edits = input.edits as Array<{ old_string?: string; new_string?: string }> | undefined;
      if (!path || !Array.isArray(edits)) return [];
      let added = 0;
      let removed = 0;
      for (const e of edits) {
        added += countLines(e.new_string);
        removed += countLines(e.old_string);
      }
      return [{ path, action: "edit", linesAdded: added, linesRemoved: removed }];
    }
    case "NotebookEdit": {
      const path = input.notebook_path as string | undefined;
      if (!path) return [];
      return [{
        path,
        action: "edit",
        linesAdded: countLines(input.new_source as string),
        linesRemoved: countLines(input.old_source as string),
      }];
    }
    default:
      return [];
  }
}

/**
 * Insert files_touched rows for each Edit/Write/MultiEdit/NotebookEdit
 * tool_use block inside an assistant event.
 */
export function insertFilesTouched(
  stmts: IngestStmts,
  event: AssistantEvent,
  eventId: string,
  sessionId: string
): void {
  for (const block of event.message.content) {
    if (block.type !== "tool_use") continue;
    const touches = extractFromTool(block as ToolUseContent);
    for (const t of touches) {
      stmts.insertFileTouched.run({
        $eventId: eventId,
        $sessionId: sessionId,
        $path: t.path,
        $action: t.action,
        $linesAdded: t.linesAdded,
        $linesRemoved: t.linesRemoved,
      });
    }
  }
}
