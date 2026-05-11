/**
 * Schema v1 reducer: processes a stream of ParsedEvents from a CC session file
 * and accumulates a SessionSummary.
 *
 * "Reducer" means it is a pure fold over the event stream — no I/O.
 * Consumers call `reduceEvent()` per event, then read `build()` at end.
 */

import type {
  ParsedEvent,
  AssistantEvent,
  ToolUseContent,
  UsageTokens,
} from "./event-types.ts";

// ── Output types ──────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  id: string;
  name: string;
  /** ISO timestamp of the assistant turn that issued this call */
  timestamp?: string;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface SessionSummary {
  sessionId?: string;
  version?: string;
  /** Number of assistant turns */
  assistantTurns: number;
  /** Number of user turns (excludes tool_result-only turns when isMeta=true) */
  userTurns: number;
  /** Cumulative token usage across all assistant turns */
  tokens: TokenTotals;
  /** All tool_use blocks extracted from assistant content */
  toolCalls: ToolCallRecord[];
  /** Count of events that fell through to UnknownEvent */
  unknownEventCount: number;
  /** Total events processed */
  totalEventCount: number;
}

// ── Reducer class ─────────────────────────────────────────────────────────────

/**
 * Stateful reducer for a single CC session file (schema v1).
 *
 * Usage:
 * ```ts
 * const reducer = new SchemaV1Reducer();
 * for await (const event of parseFile(path)) {
 *   reducer.reduceEvent(event);
 * }
 * const summary = reducer.build();
 * ```
 */
export class SchemaV1Reducer {
  private sessionId: string | undefined;
  private version: string | undefined;
  private assistantTurns = 0;
  private userTurns = 0;
  private tokens: TokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  private toolCalls: ToolCallRecord[] = [];
  private unknownEventCount = 0;
  private totalEventCount = 0;

  reduceEvent(event: ParsedEvent): void {
    this.totalEventCount++;

    switch (event.kind) {
      case "assistant":
        this.reduceAssistant(event);
        break;

      case "user":
        // isMeta=true rows are internal tool_result plumbing; count separately
        if (!event.isMeta) this.userTurns++;
        // Capture session metadata from first user row
        if (!this.sessionId && event.sessionId) this.sessionId = event.sessionId;
        if (!this.version && event.version) this.version = event.version;
        break;

      case "unknown":
        this.unknownEventCount++;
        break;

      // Other event types carry no token/tool data — no-op for now
      default:
        if (!this.sessionId) {
          // Some event types have sessionId at top level
          const e = event as { sessionId?: string };
          if (e.sessionId) this.sessionId = e.sessionId;
        }
    }
  }

  private reduceAssistant(event: AssistantEvent): void {
    this.assistantTurns++;

    if (!this.sessionId && event.sessionId) this.sessionId = event.sessionId;
    if (!this.version && event.version) this.version = event.version;

    this.accumulateUsage(event.message.usage);
    this.extractToolCalls(event);
  }

  private accumulateUsage(usage: UsageTokens | undefined): void {
    if (!usage) return;
    this.tokens.inputTokens += usage.input_tokens;
    this.tokens.outputTokens += usage.output_tokens;
    this.tokens.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
    this.tokens.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  }

  private extractToolCalls(event: AssistantEvent): void {
    for (const block of event.message.content) {
      if (block.type === "tool_use") {
        const tb = block as ToolUseContent;
        this.toolCalls.push({
          id: tb.id,
          name: tb.name,
          timestamp: event.timestamp,
        });
      }
    }
  }

  build(): SessionSummary {
    return {
      sessionId: this.sessionId,
      version: this.version,
      assistantTurns: this.assistantTurns,
      userTurns: this.userTurns,
      tokens: { ...this.tokens },
      toolCalls: [...this.toolCalls],
      unknownEventCount: this.unknownEventCount,
      totalEventCount: this.totalEventCount,
    };
  }

  /** Reset internal state — allows reuse of the same instance across files. */
  reset(): void {
    this.sessionId = undefined;
    this.version = undefined;
    this.assistantTurns = 0;
    this.userTurns = 0;
    this.tokens = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    this.toolCalls = [];
    this.unknownEventCount = 0;
    this.totalEventCount = 0;
  }
}
