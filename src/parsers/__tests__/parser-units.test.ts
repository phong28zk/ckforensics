/**
 * Unit tests for jsonl-reader, event-classifier, and SchemaV1Reducer.
 * No fixtures needed — all inputs are inline.
 */

import { describe, test, expect } from "bun:test";
import path from "node:path";
import { readJsonlLines } from "../jsonl-reader.ts";
import { classifyLine } from "../event-classifier.ts";
import { SchemaV1Reducer } from "../schema-v1.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "__fixtures__");

describe("jsonl-reader", () => {
  test("reads all lines from sample-01.jsonl without error", async () => {
    const lines: string[] = [];
    for await (const line of readJsonlLines(path.join(FIXTURES_DIR, "sample-01.jsonl"))) {
      lines.push(line);
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("handles non-existent file by throwing", async () => {
    const gen = readJsonlLines(path.join(FIXTURES_DIR, "does-not-exist.jsonl"));
    await expect(gen.next()).rejects.toThrow();
  });
});

describe("event-classifier", () => {
  test("classifies assistant line with usage", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "11111111-1111-1111-1111-111111111111",
      sessionId: "test-session",
      timestamp: "2024-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 5, output_tokens: 10 },
      },
    });
    const event = classifyLine(line);
    expect(event.kind).toBe("assistant");
    if (event.kind === "assistant") {
      expect(event.message.usage?.input_tokens).toBe(5);
      expect(event.message.usage?.output_tokens).toBe(10);
    }
  });

  test("classifies user line", () => {
    const event = classifyLine(JSON.stringify({
      type: "user",
      uuid: "22222222-2222-2222-2222-222222222222",
      sessionId: "test-session",
      message: { role: "user", content: "hello" },
    }));
    expect(event.kind).toBe("user");
  });

  test("classifies system line", () => {
    const event = classifyLine(JSON.stringify({
      type: "system",
      subtype: "stop_hook_summary",
      hookCount: 1,
    }));
    expect(event.kind).toBe("system");
    if (event.kind === "system") expect(event.subtype).toBe("stop_hook_summary");
  });

  test("classifies progress line", () => {
    const event = classifyLine(JSON.stringify({
      type: "progress",
      toolUseID: "toolu_abc",
      data: { type: "hook_progress" },
    }));
    expect(event.kind).toBe("progress");
  });

  test("classifies permission-mode line", () => {
    const event = classifyLine(JSON.stringify({
      type: "permission-mode",
      permissionMode: "bypassPermissions",
      sessionId: "s1",
    }));
    expect(event.kind).toBe("permission-mode");
  });

  test("returns UnknownEvent for unrecognised type", () => {
    const event = classifyLine(JSON.stringify({ type: "future-event-xyz", data: 1 }));
    expect(event.kind).toBe("unknown");
    if (event.kind === "unknown") expect(event.originalType).toBe("future-event-xyz");
  });

  test("returns UnknownEvent for malformed JSON", () => {
    const event = classifyLine("{not valid json}");
    expect(event.kind).toBe("unknown");
    if (event.kind === "unknown") expect(event.originalType).toBe("(json-parse-error)");
  });

  test("returns UnknownEvent for JSON array", () => {
    expect(classifyLine("[1,2,3]").kind).toBe("unknown");
  });
});

describe("SchemaV1Reducer", () => {
  test("reset() clears all accumulated state", async () => {
    const reducer = new SchemaV1Reducer();
    for await (const line of readJsonlLines(path.join(FIXTURES_DIR, "sample-01.jsonl"))) {
      reducer.reduceEvent(classifyLine(line));
    }
    expect(reducer.build().totalEventCount).toBeGreaterThan(0);

    reducer.reset();
    const after = reducer.build();
    expect(after.totalEventCount).toBe(0);
    expect(after.assistantTurns).toBe(0);
    expect(after.tokens.inputTokens).toBe(0);
    expect(after.toolCalls.length).toBe(0);
  });

  test("handles assistant event with no usage gracefully", () => {
    const reducer = new SchemaV1Reducer();
    reducer.reduceEvent(classifyLine(JSON.stringify({
      type: "assistant",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      message: { role: "assistant", content: [] },
    })));
    const s = reducer.build();
    expect(s.assistantTurns).toBe(1);
    expect(s.tokens.inputTokens).toBe(0);
    expect(s.tokens.outputTokens).toBe(0);
  });

  test("counts tool_use blocks from assistant content", () => {
    const reducer = new SchemaV1Reducer();
    reducer.reduceEvent(classifyLine(JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_001", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_002", name: "Read", input: { file_path: "/tmp" } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })));
    const s = reducer.build();
    expect(s.toolCalls.length).toBe(2);
    expect(s.toolCalls[0]?.name).toBe("Bash");
    expect(s.toolCalls[1]?.name).toBe("Read");
  });

  test("isMeta user turns are not counted as userTurns", () => {
    const reducer = new SchemaV1Reducer();
    reducer.reduceEvent(classifyLine(JSON.stringify({
      type: "user", isMeta: true,
      message: { role: "user", content: "" },
    })));
    reducer.reduceEvent(classifyLine(JSON.stringify({
      type: "user", isMeta: false,
      message: { role: "user", content: "hello" },
    })));
    expect(reducer.build().userTurns).toBe(1);
  });
});
