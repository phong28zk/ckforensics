/**
 * Per-type classifier functions used by event-classifier.ts.
 * Separated to keep each file under 200 lines.
 */

import type {
  AssistantEvent,
  UserEvent,
  SystemEvent,
  FileHistorySnapshotEvent,
  AttachmentEvent,
  QueueOperationEvent,
  PermissionModeEvent,
  LastPromptEvent,
  ProgressEvent,
  MessageContent,
  UsageTokens,
} from "./event-types.ts";

// ── Micro-helpers ─────────────────────────────────────────────────────────────

export function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function asNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export function parseUsage(raw: unknown): UsageTokens | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  return {
    input_tokens: asNum(u["input_tokens"]) ?? 0,
    output_tokens: asNum(u["output_tokens"]) ?? 0,
    cache_creation_input_tokens: asNum(u["cache_creation_input_tokens"]),
    cache_read_input_tokens: asNum(u["cache_read_input_tokens"]),
    cache_creation: u["cache_creation"] as Record<string, number> | undefined,
  };
}

export function parseContent(raw: unknown): MessageContent[] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  if (!Array.isArray(raw)) return [];
  return raw as MessageContent[];
}

function envelope(r: Record<string, unknown>) {
  return {
    uuid: asStr(r["uuid"]),
    parentUuid: asStr(r["parentUuid"]) ?? null,
    sessionId: asStr(r["sessionId"]),
    timestamp: asStr(r["timestamp"]),
    cwd: asStr(r["cwd"]),
    version: asStr(r["version"]),
    gitBranch: asStr(r["gitBranch"]),
    isSidechain: asBool(r["isSidechain"]),
    userType: asStr(r["userType"]),
    entrypoint: asStr(r["entrypoint"]),
  };
}

// ── Per-type classifiers ──────────────────────────────────────────────────────

export function classifyAssistant(r: Record<string, unknown>): AssistantEvent {
  const msg = (r["message"] ?? {}) as Record<string, unknown>;
  return {
    kind: "assistant",
    ...envelope(r),
    requestId: asStr(r["requestId"]),
    message: {
      id: asStr(msg["id"]),
      role: "assistant",
      model: asStr(msg["model"]),
      content: parseContent(msg["content"]),
      stop_reason: asStr(msg["stop_reason"]),
      stop_sequence: msg["stop_sequence"] != null ? asStr(msg["stop_sequence"]) : undefined,
      usage: parseUsage(msg["usage"] ?? msg["usageMetadata"]),
    },
    raw: r,
  };
}

export function classifyUser(r: Record<string, unknown>): UserEvent {
  const msg = (r["message"] ?? {}) as Record<string, unknown>;
  return {
    kind: "user",
    ...envelope(r),
    isMeta: asBool(r["isMeta"]),
    toolUseResult: r["toolUseResult"],
    sourceToolAssistantUUID: asStr(r["sourceToolAssistantUUID"]),
    message: { role: "user", content: parseContent(msg["content"]) },
    raw: r,
  };
}

export function classifySystem(r: Record<string, unknown>): SystemEvent {
  return {
    kind: "system",
    ...envelope(r),
    subtype: asStr(r["subtype"]),
    level: asStr(r["level"]),
    content: asStr(r["content"]),
    stopReason: asStr(r["stopReason"]),
    toolUseID: asStr(r["toolUseID"]),
    hookCount: asNum(r["hookCount"]),
    hookInfos: Array.isArray(r["hookInfos"]) ? r["hookInfos"] : undefined,
    hookErrors: Array.isArray(r["hookErrors"]) ? r["hookErrors"] : undefined,
    preventedContinuation: asBool(r["preventedContinuation"]),
    raw: r,
  };
}

export function classifySnapshot(r: Record<string, unknown>): FileHistorySnapshotEvent {
  return {
    kind: "file-history-snapshot",
    messageId: asStr(r["messageId"]),
    isSnapshotUpdate: asBool(r["isSnapshotUpdate"]),
    snapshot: r["snapshot"],
    raw: r,
  };
}

export function classifyAttachment(r: Record<string, unknown>): AttachmentEvent {
  return { kind: "attachment", ...envelope(r), attachment: r["attachment"], raw: r };
}

export function classifyQueueOperation(r: Record<string, unknown>): QueueOperationEvent {
  return {
    kind: "queue-operation",
    operation: asStr(r["operation"]),
    sessionId: asStr(r["sessionId"]),
    timestamp: asStr(r["timestamp"]),
    content: r["content"],
    raw: r,
  };
}

export function classifyPermissionMode(r: Record<string, unknown>): PermissionModeEvent {
  return {
    kind: "permission-mode",
    permissionMode: asStr(r["permissionMode"]),
    sessionId: asStr(r["sessionId"]),
    raw: r,
  };
}

export function classifyLastPrompt(r: Record<string, unknown>): LastPromptEvent {
  return {
    kind: "last-prompt",
    lastPrompt: asStr(r["lastPrompt"]),
    sessionId: asStr(r["sessionId"]),
    raw: r,
  };
}

export function classifyProgress(r: Record<string, unknown>): ProgressEvent {
  return {
    kind: "progress",
    ...envelope(r),
    toolUseID: asStr(r["toolUseID"]),
    parentToolUseID: asStr(r["parentToolUseID"]),
    agentId: asStr(r["agentId"]),
    slug: asStr(r["slug"]),
    data: r["data"],
    raw: r,
  };
}
