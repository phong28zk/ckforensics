/**
 * Pricing constants must stay in sync with src/store/ingest.ts SQL backfill
 * and Anthropic's published rates (https://platform.claude.com/docs/en/about-claude/pricing).
 */

import { describe, it, expect } from "bun:test";
import { getModelPricing, computeCostUsd } from "../model-pricing.ts";

describe("getModelPricing — version-aware family matching", () => {
  it("Opus 4.7 uses new pricing", () => {
    const p = getModelPricing("claude-opus-4-7");
    expect(p).toEqual({
      inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25,
    });
  });

  it("Opus 4.6 uses new pricing", () => {
    expect(getModelPricing("claude-opus-4-6")!.inputPer1M).toBe(5);
  });

  it("Opus 4.5 uses new pricing", () => {
    expect(getModelPricing("claude-opus-4-5-20251015")!.inputPer1M).toBe(5);
  });

  it("Opus 4.1 keeps legacy pricing", () => {
    expect(getModelPricing("claude-opus-4-1")!.inputPer1M).toBe(15);
  });

  it("Opus 4.0 keeps legacy pricing", () => {
    expect(getModelPricing("claude-opus-4-0")!.inputPer1M).toBe(15);
  });

  it("Opus 3 (legacy) keeps legacy pricing", () => {
    expect(getModelPricing("claude-3-opus-20240229")!.inputPer1M).toBe(15);
  });

  it("Sonnet 4.6 uses Sonnet pricing", () => {
    const p = getModelPricing("claude-sonnet-4-6");
    expect(p).toEqual({
      inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75,
    });
  });

  it("Haiku 4.5 uses new Haiku pricing", () => {
    const p = getModelPricing("claude-haiku-4-5");
    expect(p).toEqual({
      inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25,
    });
  });

  it("Haiku 3.5 uses Haiku 3.5 pricing", () => {
    expect(getModelPricing("claude-haiku-3-5")!.inputPer1M).toBe(0.8);
  });

  it("Haiku 3 (legacy) uses cheapest pricing", () => {
    expect(getModelPricing("claude-3-haiku-20240307")!.inputPer1M).toBe(0.25);
  });

  it("returns null for unknown model", () => {
    expect(getModelPricing("gpt-4")).toBeNull();
    expect(getModelPricing(null)).toBeNull();
    expect(getModelPricing(undefined)).toBeNull();
    expect(getModelPricing("")).toBeNull();
  });

  it("is case insensitive", () => {
    expect(getModelPricing("CLAUDE-OPUS-4-7")!.inputPer1M).toBe(5);
  });
});

describe("computeCostUsd — matches observed session totals", () => {
  it("Opus 4.7 session: 14h, real token counts", () => {
    // Real data from a captured session (DB row totals).
    const cost = computeCostUsd(
      { input: 2026, output: 423337, cacheRead: 204215242, cacheCreate: 6602515 },
      "claude-opus-4-7"
    );
    // Expected: 2026*5/M + 423337*25/M + 204215242*0.5/M + 6602515*6.25/M
    //         = 0.01013 + 10.583425 + 102.107621 + 41.265719 ≈ 153.97
    expect(cost!).toBeGreaterThan(153);
    expect(cost!).toBeLessThan(155);
  });

  it("Sonnet 4.6 session: small workload", () => {
    const cost = computeCostUsd(
      { input: 1000, output: 500, cacheRead: 10000, cacheCreate: 5000 },
      "claude-sonnet-4-6"
    );
    // = 1000*3/M + 500*15/M + 10000*0.3/M + 5000*3.75/M
    // = 0.003 + 0.0075 + 0.003 + 0.01875 = 0.03225
    expect(cost).toBeCloseTo(0.03225, 4);
  });

  it("returns null for unknown model", () => {
    expect(computeCostUsd({ input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }, "gpt-4")).toBeNull();
  });
});
