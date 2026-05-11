/**
 * Redactor: applies RedactionRule patterns line-by-line to text content.
 *
 * Two surfaces:
 *   redactLine(line, rules)   — synchronous single-line redaction
 *   redactText(text, rules)   — synchronous full-text redaction
 *   redactStream(...)         — async generator for streaming large files
 *
 * Each match is replaced with [REDACTED:ID] where ID is the rule's id field.
 * Rules are applied in order; earlier rules shadow later overlapping matches.
 *
 * WARNING: Best-effort only. Users must verify output before sharing.
 */

import type { RedactionRule } from "./redaction-rules.ts";
import { DEFAULT_RULES } from "./redaction-rules.ts";

/**
 * Redact a single line of text applying all given rules in order.
 * Each rule's pattern must have the global flag set.
 *
 * @param line   A single line (no trailing newline expected but tolerated).
 * @param rules  Ordered list of rules to apply.
 */
export function redactLine(
  line: string,
  rules: RedactionRule[] = DEFAULT_RULES
): string {
  let result = line;
  for (const rule of rules) {
    // Reset lastIndex between calls — required for /g patterns reused across lines
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, `[REDACTED:${rule.id}]`);
  }
  return result;
}

/**
 * Redact a full multi-line text string.
 * Lines are split on \n and each is passed through redactLine.
 *
 * @param text   Full text content (string).
 * @param rules  Rules to apply (defaults to DEFAULT_RULES).
 */
export function redactText(
  text: string,
  rules: RedactionRule[] = DEFAULT_RULES
): string {
  return text
    .split("\n")
    .map((line) => redactLine(line, rules))
    .join("\n");
}

/**
 * Async generator that redacts an async iterable of lines.
 *
 * Usage:
 *   for await (const line of redactStream(source, rules)) { ... }
 *
 * @param input   Async iterable yielding one line per iteration.
 * @param rules   Rules to apply (defaults to DEFAULT_RULES).
 */
export async function* redactStream(
  input: AsyncIterable<string>,
  rules: RedactionRule[] = DEFAULT_RULES
): AsyncIterable<string> {
  for await (const line of input) {
    yield redactLine(line, rules);
  }
}

/**
 * Redact a file on disk, returning the redacted content as a string.
 *
 * @param filePath  Absolute path to the file to read.
 * @param rules     Rules to apply (defaults to DEFAULT_RULES).
 */
export async function redactFile(
  filePath: string,
  rules: RedactionRule[] = DEFAULT_RULES
): Promise<string> {
  const content = await Bun.file(filePath).text();
  return redactText(content, rules);
}
