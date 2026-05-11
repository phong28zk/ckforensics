/**
 * Context snapshot builder: walks session events in order and builds a flat
 * list of ContextItems representing logical entries in the context window.
 *
 * Limitations (documented — best-effort, ±20% attribution margin):
 *   - system_prompt content is not available in the JSONL transcript; emitted
 *     as a single "unknown" item if a system event is detected.
 *   - /memory entries injected by CC are not distinguishable from regular user
 *     messages in transcript alone; detected heuristically.
 *   - Token counts are set to 0 here; token-attribution.ts fills them in a
 *     second pass using cache_creation_input_tokens deltas.
 *
 * Skill load detection: system events whose content contains a <command-name>
 * XML tag (Claude Code's standard skill injection marker) are classified as
 * skill_load items.
 */

import type { HydratedEvent } from "../audit/manifest-types.ts";
import type {
  ContextItem,
  ItemSource,
  ContextSnapshot,
} from "./types.ts";
import type {
  AssistantEvent,
  UserEvent,
  SystemEvent,
  ToolUseContent,
  ToolResultContent,
  MessageContent,
} from "../parsers/event-types.ts";
import { hashItemId } from "./item-id-hasher.ts";

// ── Skill-load detection ───────────────────────────────────────────────────────

/** Regex to detect skill injection markers in system event content. */
const SKILL_MARKER_RE = /<command-name>([^<]+)<\/command-name>/;

/** Memory injection heuristics — CC injects these as user-role messages. */
const MEMORY_MARKER_RE = /^(?:Memory:|<memory>|\[memory\])/i;

// ── Public API ────────────────────────────────────────────────────────────────

export interface BuildSnapshotOptions {
  sessionId: string;
  /** ISO-8601 timestamp for snapshot creation (default: now). */
  createdAt?: string;
  /** Optional user-given name. */
  name?: string;
}

/**
 * Build a ContextSnapshot from an ordered list of hydrated session events.
 *
 * Token counts on items are initialised to 0; call fillTokenAttribution()
 * from token-attribution.ts to populate them.
 *
 * @param events  Events ordered by timestamp ASC (from session-loader.ts).
 * @param opts    Snapshot metadata options.
 */
export function buildSnapshot(
  events: HydratedEvent[],
  opts: BuildSnapshotOptions
): ContextSnapshot {
  const items: ContextItem[] = [];
  // Map from tool_use_id → tool name; populated from assistant tool_use blocks,
  // consumed when corresponding tool_result appears in the next user event.
  const toolNameMap = new Map<string, string>();
  let turnIndex = 0;

  for (const he of events) {
    const ts = he.timestamp ?? new Date().toISOString();

    switch (he.event.kind) {
      case "assistant":
        processAssistantEvent(he.event as AssistantEvent, ts, turnIndex, items, toolNameMap);
        turnIndex++;
        break;

      case "user":
        // Tool results belong to the assistant turn that issued the tool_use
        // (turnIndex was already incremented after the assistant event).
        // Pass turnIndex-1 as the tool-result turn so attribution aligns with
        // the cache_creation delta recorded at that assistant turn.
        processUserEvent(
          he.event as UserEvent,
          ts,
          turnIndex,
          Math.max(0, turnIndex - 1),
          items,
          toolNameMap
        );
        break;

      case "system":
        processSystemEvent(he.event as SystemEvent, ts, turnIndex, items);
        break;

      // file-history-snapshot, attachment, queue-operation, etc. — skip
      default:
        break;
    }
  }

  const snapshotId = hashItemId("snapshot", `${opts.sessionId}:${opts.createdAt ?? ""}`);

  return {
    id: snapshotId,
    sessionId: opts.sessionId,
    name: opts.name,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    totalTokens: 0, // filled after token attribution pass
    items,
    pinnedIds: [],
  };
}

// ── Event processors ──────────────────────────────────────────────────────────

function processAssistantEvent(
  ae: AssistantEvent,
  ts: string,
  turnIndex: number,
  items: ContextItem[],
  toolNameMap: Map<string, string>
): void {
  const msgId = ae.message.id ?? ae.uuid ?? `assistant-${turnIndex}`;

  // Collect text blocks into assistant_message item
  const textParts: string[] = [];

  for (const block of ae.message.content) {
    const b = block as MessageContent;
    if (b.type === "text") {
      textParts.push((b as { type: "text"; text: string }).text);
    } else if (b.type === "thinking") {
      textParts.push((b as { type: "thinking"; thinking: string }).thinking);
    } else if (b.type === "tool_use") {
      // Record tool name keyed by tool_use_id so paired tool_result can enrich.
      const tu = b as ToolUseContent;
      toolNameMap.set(tu.id, tu.name);
    }
  }

  if (textParts.length > 0) {
    const preview = preview200(textParts.join(" "));
    const source: ItemSource = { type: "assistant_message", messageId: msgId, preview };
    items.push({
      id: hashItemId("assistant_message", msgId),
      source,
      tokens: 0,
      turnIndex,
      timestamp: ts,
      attributionConfidence: "medium",
    });
  }

  // tool_use blocks in assistant event → paired tool_result will appear in
  // next user event; we record the tool names keyed by tool_use id.
  // (Tool results are emitted when processing the user event below.)
}

function processUserEvent(
  ue: UserEvent,
  ts: string,
  turnIndex: number,
  toolResultTurnIndex: number,
  items: ContextItem[],
  toolNameMap: Map<string, string>
): void {
  const msgId = ue.uuid ?? `user-${turnIndex}`;
  const content = ue.message.content;

  // Handle string content (plain user messages)
  if (typeof content === "string") {
    if (MEMORY_MARKER_RE.test(content)) {
      const source: ItemSource = { type: "memory", entry: preview200(content) };
      items.push({
        id: hashItemId("memory", `${turnIndex}:${content.slice(0, 40)}`),
        source,
        tokens: 0,
        turnIndex,
        timestamp: ts,
        attributionConfidence: "low",
      });
    } else {
      const source: ItemSource = { type: "user_message", messageId: msgId, preview: preview200(content) };
      items.push({
        id: hashItemId("user_message", msgId),
        source,
        tokens: 0,
        turnIndex,
        timestamp: ts,
        attributionConfidence: "medium",
      });
    }
    return;
  }

  // Handle array content (tool_result blocks + optional text)
  let hasToolResults = false;
  for (const block of content) {
    const b = block as MessageContent;
    if (b.type === "tool_result") {
      hasToolResults = true;
      const tr = b as ToolResultContent;
      const toolCallId = tr.tool_use_id;
      const rawContent = tr.content;
      const text = extractToolResultText(rawContent);
      // Tool name from preceding assistant tool_use (paired by tool_use_id).
      // Falls back to "unknown" if no matching tool_use seen (orphan result).
      // toolResultTurnIndex aligns attribution with the assistant turn's
      // cache_creation delta (the assistant turn that issued the tool_use call).
      const source: ItemSource = {
        type: "tool_result",
        toolName: toolNameMap.get(toolCallId) ?? "unknown",
        toolCallId,
        preview: preview200(text),
      };
      items.push({
        id: hashItemId("tool_result", toolCallId),
        source,
        tokens: 0,
        turnIndex: toolResultTurnIndex,
        timestamp: ts,
        attributionConfidence: "medium",
      });
    } else if (b.type === "text") {
      const text = (b as { type: "text"; text: string }).text;
      if (!hasToolResults && text.trim().length > 0) {
        const source: ItemSource = {
          type: "user_message",
          messageId: msgId,
          preview: preview200(text),
        };
        items.push({
          id: hashItemId("user_message", msgId),
          source,
          tokens: 0,
          turnIndex,
          timestamp: ts,
          attributionConfidence: "medium",
        });
      }
    }
  }
}

function processSystemEvent(
  se: SystemEvent,
  ts: string,
  turnIndex: number,
  items: ContextItem[]
): void {
  const content = se.content ?? "";

  // Skill injection via <command-name> marker
  const skillMatch = SKILL_MARKER_RE.exec(content);
  if (skillMatch) {
    const skillName = skillMatch[1]!.trim();
    const source: ItemSource = { type: "skill_load", skillName };
    items.push({
      id: hashItemId("skill_load", skillName),
      source,
      tokens: 0,
      turnIndex,
      timestamp: ts,
      attributionConfidence: "low",
    });
    return;
  }

  // System prompt: CC does not expose raw content in transcript; emit unknown
  if (se.subtype === "system_prompt" || content.includes("system_prompt")) {
    const source: ItemSource = { type: "system_prompt" };
    items.push({
      id: hashItemId("system_prompt", `turn-${turnIndex}`),
      source,
      tokens: 0,
      turnIndex,
      timestamp: ts,
      attributionConfidence: "low",
    });
    return;
  }

  // Other system events with non-trivial content → unknown bucket
  if (content.length > 10) {
    const source: ItemSource = { type: "unknown", raw: preview200(content) };
    items.push({
      id: hashItemId("unknown", `${turnIndex}:${content.slice(0, 40)}`),
      source,
      tokens: 0,
      turnIndex,
      timestamp: ts,
      attributionConfidence: "low",
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract plain text from a tool_result content field. */
function extractToolResultText(
  content: string | Array<{ type: string; text?: string }>
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join(" ");
}

/** Truncate to first 200 visible chars for preview storage. */
function preview200(s: string): string {
  const trimmed = s.trim();
  return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 197) + "...";
}
