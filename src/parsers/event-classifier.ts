/**
 * Classifies raw parsed JSON objects into typed ParsedEvent variants.
 *
 * Switch on the `type` field from the raw JSONL line.
 * Unknown types are bucketed into UnknownEvent for forward-compatibility.
 * Per-type classifier functions live in event-classifier-helpers.ts.
 * No throwing — every line produces an event.
 */

import type { ParsedEvent, UnknownEvent } from "./event-types.ts";
import {
  classifyAssistant,
  classifyUser,
  classifySystem,
  classifySnapshot,
  classifyAttachment,
  classifyQueueOperation,
  classifyPermissionMode,
  classifyLastPrompt,
  classifyProgress,
  asStr,
} from "./event-classifier-helpers.ts";

// ── Main classifier ───────────────────────────────────────────────────────────

/**
 * Classify a single raw JSON object (already parsed from one JSONL line)
 * into a strongly-typed ParsedEvent.
 *
 * Never throws — unknown types become UnknownEvent.
 */
export function classifyEvent(raw: unknown): ParsedEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "unknown",
      originalType: "(non-object)",
      raw,
    } satisfies UnknownEvent;
  }

  const r = raw as Record<string, unknown>;
  const type = asStr(r["type"]) ?? "";

  switch (type) {
    case "assistant":        return classifyAssistant(r);
    case "user":             return classifyUser(r);
    case "system":           return classifySystem(r);
    case "file-history-snapshot": return classifySnapshot(r);
    case "attachment":       return classifyAttachment(r);
    case "queue-operation":  return classifyQueueOperation(r);
    case "permission-mode":  return classifyPermissionMode(r);
    case "last-prompt":      return classifyLastPrompt(r);
    case "progress":         return classifyProgress(r);
    default:
      return {
        kind: "unknown",
        originalType: type,
        raw: r,
      } satisfies UnknownEvent;
  }
}

/**
 * Parse a raw JSONL line string into a typed ParsedEvent.
 * Returns UnknownEvent on JSON parse failure (bad line).
 */
export function classifyLine(line: string): ParsedEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {
      kind: "unknown",
      originalType: "(json-parse-error)",
      raw: line,
    } satisfies UnknownEvent;
  }
  return classifyEvent(raw);
}
