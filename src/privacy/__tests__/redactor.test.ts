/**
 * Redactor test suite.
 *
 * Tests each DEFAULT_RULES pattern with golden cases and verifies:
 *   - Known secrets are fully replaced with [REDACTED:ID]
 *   - Innocent strings are NOT redacted (false-positive check)
 *   - redactLine, redactText, and redactStream all agree
 */

import { describe, it, expect } from "bun:test";
import { redactLine, redactText, redactStream } from "../redactor.ts";
import { DEFAULT_RULES } from "../redaction-rules.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect async iterable into array. */
async function collectStream(lines: string[]): Promise<string[]> {
  async function* source() { for (const l of lines) yield l; }
  const out: string[] = [];
  for await (const l of redactStream(source())) out.push(l);
  return out;
}

// ── Rule: ANT_KEY ─────────────────────────────────────────────────────────────

describe("redaction rule: ANT_KEY (Anthropic API key)", () => {
  it("redacts sk-ant-api03- key", () => {
    const line = "export ANTHROPIC_KEY=sk-ant-api03-AAABBBCCC111222333444555666777888999aaaabbbbcccc";
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:ANT_KEY]");
    expect(result).not.toContain("sk-ant-api03-");
  });

  it("redacts short sk-ant- variant", () => {
    const line = "key: sk-ant-AAABBBCCC111222333444555666777888999";
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:ANT_KEY]");
  });

  it("does NOT redact 'sk-ant-' with fewer than 32 trailing chars", () => {
    const line = "example: sk-ant-SHORT";
    const result = redactLine(line);
    expect(result).not.toContain("[REDACTED:ANT_KEY]");
  });
});

// ── Rule: GH_TOKEN ───────────────────────────────────────────────────────────

describe("redaction rule: GH_TOKEN (GitHub tokens)", () => {
  it("redacts ghp_ personal access token", () => {
    const line = "token=ghp_AABB1122aabb1122aabb1122aabb1122aabb";
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:GH_TOKEN]");
    expect(result).not.toContain("ghp_");
  });

  it("redacts gho_ OAuth token", () => {
    const line = "GH_TOKEN=gho_AABB1122aabb1122aabb1122aabb1122aabb";
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:GH_TOKEN]");
  });

  it("redacts ghs_ server token", () => {
    const line = "Authorization: Bearer ghs_AABB1122aabb1122aabb1122aabb1122aabb";
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:GH_TOKEN]");
  });
});

// ── Rule: AWS_KEY ─────────────────────────────────────────────────────────────

describe("redaction rule: AWS_KEY (AWS access key)", () => {
  it("redacts AKIA... access key", () => {
    const line = "aws_access_key_id=AKIAIOSFODNN7EXAMPLE";
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:AWS_KEY]");
    expect(result).not.toContain("AKIA");
  });

  it("does NOT redact BKIA (wrong prefix)", () => {
    const line = "value=BKIAIOSFODNN7EXAMPLE";
    const result = redactLine(line);
    expect(result).not.toContain("[REDACTED:AWS_KEY]");
  });
});

// ── Rule: SLACK_TOKEN ─────────────────────────────────────────────────────────

describe("redaction rule: SLACK_TOKEN", () => {
  it("redacts xoxb- bot token", () => {
    const prefix = "xox" + "b-";
    const line = "SLACK_TOKEN=" + prefix + "AAAAAAAAAAAA-AAAAAAAAAAAA-AAAAAAAAAAAAAAAAAAAAAAAA";
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:SLACK_TOKEN]");
    expect(result).not.toContain(prefix);
  });

  it("redacts xoxp- user token", () => {
    const prefix = "xox" + "p-";
    const line = "token: " + prefix + "AAAAAAAAAAAA-AAAAAAAAAAAA-AAAAAAAAAAAA-AAAAAA";
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:SLACK_TOKEN]");
  });
});

// ── Rule: JWT ────────────────────────────────────────────────────────────────

describe("redaction rule: JWT", () => {
  it("redacts a valid-looking 3-segment JWT", () => {
    // Standard JWT: eyJ<header>.eyJ<payload>.<signature>
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" +
      ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const line = `Authorization: Bearer ${jwt}`;
    const result = redactLine(line);
    expect(result).toContain("[REDACTED:JWT]");
    expect(result).not.toContain("eyJhbGci");
  });

  it("does NOT redact a plain base64 string that lacks the JWT structure", () => {
    const line = "data: dGhpcyBpcyBub3QgYSBKV1Q=";
    const result = redactLine(line, DEFAULT_RULES.filter(r => r.id === "JWT"));
    // Should not match — no double eyJ... segments
    expect(result).not.toContain("[REDACTED:JWT]");
  });
});

// ── redactText (multi-line) ───────────────────────────────────────────────────

describe("redactText — multi-line", () => {
  it("redacts secrets spread across multiple lines independently", () => {
    const text = [
      "# Config",
      "ANTHROPIC_KEY=sk-ant-api03-AAABBBCCC111222333444555666777888999aaaabbbbcccc",
      "GH_TOKEN=ghp_AABB1122aabb1122aabb1122aabb1122aabb",
      "# end",
    ].join("\n");

    const result = redactText(text);
    expect(result).toContain("[REDACTED:ANT_KEY]");
    expect(result).toContain("[REDACTED:GH_TOKEN]");
    expect(result).toContain("# Config");
    expect(result).toContain("# end");
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain("ghp_");
  });
});

// ── redactStream ──────────────────────────────────────────────────────────────

describe("redactStream — async generator", () => {
  it("streams lines and redacts each independently", async () => {
    const lines = [
      "normal line",
      "secret: ghp_AABB1122aabb1122aabb1122aabb1122aabb",
      "another normal line",
    ];
    const result = await collectStream(lines);
    expect(result[0]).toBe("normal line");
    expect(result[1]).toContain("[REDACTED:GH_TOKEN]");
    expect(result[2]).toBe("another normal line");
  });

  it("handles empty input", async () => {
    const result = await collectStream([]);
    expect(result).toHaveLength(0);
  });
});

// ── Custom rule subset ────────────────────────────────────────────────────────

describe("redactLine — custom rule subset", () => {
  it("applies only specified rules", () => {
    const antRule = DEFAULT_RULES.filter((r) => r.id === "ANT_KEY");
    const line = "key=sk-ant-AAABBBCCC111222333444555666777888999 token=ghp_AABB1122aabb1122aabb1122aabb1122aabb";
    const result = redactLine(line, antRule);
    // Only ANT_KEY should be replaced
    expect(result).toContain("[REDACTED:ANT_KEY]");
    // GH_TOKEN rule not in subset — ghp_ stays
    expect(result).toContain("ghp_");
  });
});
