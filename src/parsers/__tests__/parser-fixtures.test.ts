/**
 * Fixture-driven correctness tests: token sums, tool counts, unknown rate.
 * Ground-truth values computed via jq on the sanitized fixture files.
 */

import { describe, test, expect } from "bun:test";
import path from "node:path";
import { readJsonlLines } from "../jsonl-reader.ts";
import { classifyLine } from "../event-classifier.ts";
import { detectSchemaVersion } from "../schema-detector.ts";
import { SchemaV1Reducer } from "../schema-v1.ts";
import type { TokenTotals } from "../schema-v1.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "__fixtures__");

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function parseFixture(filename: string) {
  const reducer = new SchemaV1Reducer();
  let totalLines = 0;
  for await (const line of readJsonlLines(fixturePath(filename))) {
    totalLines++;
    reducer.reduceEvent(classifyLine(line));
  }
  return { summary: reducer.build(), totalLines };
}

interface FixtureExpectation {
  file: string;
  tokens: TokenTotals;
  toolCallCount: number;
  totalLines: number;
}

// Ground truth from: jq -s '[.[] | select(.type=="assistant") | .message.usage // empty | ...] | add' fixture
const EXPECTATIONS: FixtureExpectation[] = [
  {
    file: "sample-01.jsonl",
    tokens: { inputTokens: 10, outputTokens: 407, cacheCreationInputTokens: 72675, cacheReadInputTokens: 96975 },
    toolCallCount: 1,
    totalLines: 10,
  },
  {
    file: "sample-02.jsonl",
    tokens: { inputTokens: 20, outputTokens: 1110, cacheCreationInputTokens: 108262, cacheReadInputTokens: 517794 },
    toolCallCount: 7,
    totalLines: 33,
  },
  {
    file: "sample-03.jsonl",
    tokens: { inputTokens: 36, outputTokens: 616, cacheCreationInputTokens: 55090, cacheReadInputTokens: 127596 },
    toolCallCount: 1,
    totalLines: 20,
  },
  {
    file: "sample-04.jsonl",
    tokens: { inputTokens: 26, outputTokens: 12, cacheCreationInputTokens: 43917, cacheReadInputTokens: 130948 },
    toolCallCount: 3,
    totalLines: 45,
  },
  {
    file: "sample-05.jsonl",
    tokens: { inputTokens: 49, outputTokens: 1134, cacheCreationInputTokens: 56415, cacheReadInputTokens: 103528 },
    toolCallCount: 5,
    totalLines: 61,
  },
];

describe("schema-detector — all fixtures are v1", () => {
  for (const { file } of EXPECTATIONS) {
    test(`detects v1 for ${file}`, async () => {
      expect(await detectSchemaVersion(fixturePath(file))).toBe("v1");
    });
  }

  test("returns 'unknown' for empty file", async () => {
    const tmpPath = path.join(FIXTURES_DIR, ".tmp-empty.jsonl");
    await Bun.write(tmpPath, "");
    try {
      expect(await detectSchemaVersion(tmpPath)).toBe("unknown");
    } finally {
      try { (await import("node:fs")).unlinkSync(tmpPath); } catch { /* ok */ }
    }
  });
});

describe("fixture correctness", () => {
  for (const exp of EXPECTATIONS) {
    test(`${exp.file}: all ${exp.totalLines} lines parse without throwing`, async () => {
      const { totalLines } = await parseFixture(exp.file);
      expect(totalLines).toBe(exp.totalLines);
    });

    test(`${exp.file}: UnknownEvent count < 1%`, async () => {
      const { summary } = await parseFixture(exp.file);
      const pct = summary.totalEventCount === 0 ? 0
        : summary.unknownEventCount / summary.totalEventCount;
      expect(pct).toBeLessThan(0.01);
    });

    test(`${exp.file}: token sums match jq ground truth`, async () => {
      const { summary } = await parseFixture(exp.file);
      const t = exp.tokens;
      expect(summary.tokens.inputTokens).toBe(t.inputTokens);
      expect(summary.tokens.outputTokens).toBe(t.outputTokens);
      expect(summary.tokens.cacheCreationInputTokens).toBe(t.cacheCreationInputTokens);
      expect(summary.tokens.cacheReadInputTokens).toBe(t.cacheReadInputTokens);
    });

    test(`${exp.file}: tool call count = ${exp.toolCallCount}`, async () => {
      const { summary } = await parseFixture(exp.file);
      expect(summary.toolCalls.length).toBe(exp.toolCallCount);
    });
  }
});
