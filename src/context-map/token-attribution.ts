/**
 * Token attribution: fills in ContextItem.tokens using heuristics derived
 * from assistant event usage fields.
 *
 * ACCURACY WARNING: ±20% attribution margin.
 * Claude Code reports cache_creation_input_tokens per assistant turn, not per
 * individual tool result. This module distributes the per-turn delta
 * proportionally across tool_result items in that turn by output content
 * length (bytes). Message items receive residual budget.
 *
 * Fallback: when cache_creation_input_tokens is absent (older CC versions),
 * attribution falls back to character-count heuristic:
 *   estimated_tokens ≈ charCount / 3.5   (empirically ~3.5 chars/token)
 *
 * Attribution confidence:
 *   high   — single tool_result in turn; full delta assigned directly
 *   medium — proportional distribution across multiple items
 *   low    — character-count fallback (no cache data)
 */

import type { HydratedEvent } from "../audit/manifest-types.ts";
import type { ContextItem, ContextSnapshot, AttributionConfidence } from "./types.ts";
import type { AssistantEvent, UserEvent, MessageContent, ToolResultContent } from "../parsers/event-types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Approximate characters per token (GPT/Claude empirical average). */
const CHARS_PER_TOKEN = 3.5;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mutates snapshot.items in-place, setting tokens and attributionConfidence.
 * Also updates snapshot.totalTokens.
 *
 * @param snapshot  Snapshot built by context-snapshot-builder (tokens = 0).
 * @param events    The same ordered events used to build the snapshot.
 */
export function fillTokenAttribution(
  snapshot: ContextSnapshot,
  events: HydratedEvent[]
): void {
  // Build a map of turnIndex → cache_creation delta and tool_result sizes
  const turnData = buildTurnData(events);

  // Index items by id for quick lookup
  const itemById = new Map<string, ContextItem>(
    snapshot.items.map((it) => [it.id, it])
  );

  // Group items by turnIndex
  const itemsByTurn = new Map<number, ContextItem[]>();
  for (const item of snapshot.items) {
    const list = itemsByTurn.get(item.turnIndex) ?? [];
    list.push(item);
    itemsByTurn.set(item.turnIndex, list);
  }

  // Distribute tokens per turn
  for (const [turnIdx, turnItems] of itemsByTurn) {
    const td = turnData.get(turnIdx);
    const cacheDelta = td?.cacheDelta ?? 0;
    const hasCacheData = cacheDelta > 0;

    const toolResults = turnItems.filter((it) => it.source.type === "tool_result");
    const others = turnItems.filter((it) => it.source.type !== "tool_result");

    if (hasCacheData && toolResults.length > 0) {
      // Distribute cache delta proportionally across tool_results by content length
      const sizes = toolResults.map((it) => {
        const key = it.id;
        return td!.toolResultSizes.get(extractToolCallId(it)) ?? estimateFromPreview(it);
      });
      const totalSize = sizes.reduce((a, b) => a + b, 0) || 1;

      const confidence: AttributionConfidence =
        toolResults.length === 1 ? "high" : "medium";

      toolResults.forEach((item, i) => {
        item.tokens = Math.round((sizes[i]! / totalSize) * cacheDelta);
        item.attributionConfidence = confidence;
      });

      // Residual budget to other items (assistant text, user messages)
      distributeResidual(others, td?.outputTokens ?? 0);
    } else {
      // Fallback: character count heuristic for all items in turn
      for (const item of turnItems) {
        item.tokens = charCountFallback(item);
        item.attributionConfidence = "low";
      }
    }
  }

  // Recompute totalTokens
  snapshot.totalTokens = snapshot.items.reduce((sum, it) => sum + it.tokens, 0);

  void itemById; // used implicitly via mutation
}

// ── Turn data extraction ──────────────────────────────────────────────────────

interface TurnData {
  /** Cache creation delta for this turn (tokens newly written to cache). */
  cacheDelta: number;
  /** Output tokens for assistant message in this turn. */
  outputTokens: number;
  /** Byte-length of each tool_result content, keyed by tool_use_id. */
  toolResultSizes: Map<string, number>;
}

function buildTurnData(events: HydratedEvent[]): Map<number, TurnData> {
  const result = new Map<number, TurnData>();
  let turnIndex = 0;
  let prevCacheCreate = 0;

  for (const he of events) {
    if (he.event.kind === "assistant") {
      const ae = he.event as AssistantEvent;
      const usage = ae.message.usage;
      const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
      const delta = Math.max(0, cacheCreate - prevCacheCreate);
      prevCacheCreate = cacheCreate;

      result.set(turnIndex, {
        cacheDelta: delta,
        outputTokens: usage?.output_tokens ?? 0,
        toolResultSizes: new Map(), // filled below by paired user event
      });
      turnIndex++;
    }

    if (he.event.kind === "user") {
      const ue = he.event as UserEvent;
      const content = ue.message.content;
      if (Array.isArray(content)) {
        // Tool results belong to the assistant turn that issued the tool_use.
        // snapshot-builder assigns tool_result items turnIndex = turnIndex-1
        // (the assistant's turn), so we store sizes under that same key.
        const prevTurn = turnIndex - 1;
        const td = result.get(prevTurn);
        if (td) {
          for (const block of content) {
            const b = block as MessageContent;
            if (b.type === "tool_result") {
              const tr = b as ToolResultContent;
              const size = toolResultByteSize(tr.content);
              td.toolResultSizes.set(tr.tool_use_id, size);
            }
          }
        }
      }
    }
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toolResultByteSize(
  content: string | Array<{ type: string; text?: string }>
): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, b) => sum + (b.text?.length ?? 0), 0);
}

function estimateFromPreview(item: ContextItem): number {
  const src = item.source;
  if (src.type === "tool_result") return src.preview.length;
  if (src.type === "assistant_message") return src.preview.length;
  if (src.type === "user_message") return src.preview.length;
  return 100;
}

/** Extract the raw tool_use_id for lookup in toolResultSizes map. */
function extractToolCallId(item: ContextItem): string {
  // source.toolCallId is the original tool_use_id from the JSONL event,
  // which matches the key stored in TurnData.toolResultSizes.
  return item.source.type === "tool_result" ? item.source.toolCallId : item.id;
}

/**
 * Distribute output tokens among non-tool-result items (assistant text,
 * user messages) proportionally by preview length.
 */
function distributeResidual(items: ContextItem[], outputTokens: number): void {
  if (items.length === 0) return;
  const budget = outputTokens > 0 ? outputTokens : estimateTotalFromItems(items);
  const sizes = items.map((it) => estimateFromPreview(it));
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  items.forEach((item, i) => {
    item.tokens = Math.round((sizes[i]! / total) * budget);
    item.attributionConfidence = "medium";
  });
}

function estimateTotalFromItems(items: ContextItem[]): number {
  return items.reduce((sum, it) => sum + charCountFallback(it), 0);
}

function charCountFallback(item: ContextItem): number {
  return Math.round(estimateFromPreview(item) / CHARS_PER_TOKEN);
}
