/**
 * Streaming benchmark: 100k synthetic assistant lines must complete < 5s
 * with heap growth < 100MB. Validates constant-memory streaming behaviour.
 */

import { describe, test, expect } from "bun:test";
import { readJsonlLines } from "../jsonl-reader.ts";
import { classifyLine } from "../event-classifier.ts";
import { SchemaV1Reducer } from "../schema-v1.ts";

const BENCH_LINE = JSON.stringify({
  type: "assistant",
  uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  sessionId: "bench-session",
  timestamp: "2024-01-01T00:00:00Z",
  version: "1.0.0",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello world" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
});

describe("streaming benchmark", () => {
  test(
    "100k lines complete in < 5s with heap growth < 100MB",
    async () => {
      const tmpPath = "/tmp/ckforensics-bench-100k.jsonl";
      await Bun.write(tmpPath, (BENCH_LINE + "\n").repeat(100_000));

      const heapBefore = process.memoryUsage().heapUsed;
      const start = performance.now();

      const reducer = new SchemaV1Reducer();
      let count = 0;
      for await (const line of readJsonlLines(tmpPath)) {
        reducer.reduceEvent(classifyLine(line));
        count++;
      }

      const elapsed = performance.now() - start;
      const heapDeltaMB = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

      try { (await import("node:fs")).unlinkSync(tmpPath); } catch { /* ok */ }

      expect(count).toBe(100_000);
      expect(elapsed).toBeLessThan(5_000);    // < 5 seconds
      expect(heapDeltaMB).toBeLessThan(100);  // heap growth < 100MB

      const summary = reducer.build();
      expect(summary.tokens.inputTokens).toBe(1_000_000);  // 100k × 10
      expect(summary.tokens.outputTokens).toBe(500_000);   // 100k × 5
    },
    10_000 // 10s timeout for slower CI
  );
});
