/**
 * Detects the schema version of a Claude Code JSONL session file by peeking
 * at the first N lines.
 *
 * Current known versions:
 *   v1 — current CC format (has `version` field on most rows, `uuid` UUIDs,
 *         `message.usage` with input/output/cache_* token fields)
 *
 * Returns "v1" for all files that look like known CC output.
 * Returns "unknown" if the file is empty or has no recognisable markers.
 */

import { peekLines } from "./jsonl-reader.ts";

export type SchemaVersion = "v1" | "unknown";

interface VersionMarkers {
  /** Any row carries a `version` string field */
  hasVersionField: boolean;
  /** Any row carries a `uuid` field matching UUID-like pattern */
  hasUuidField: boolean;
  /** Any row has type "assistant" or "user" */
  hasCcTypes: boolean;
  /** Any assistant row has message.usage.input_tokens */
  hasUsageTokens: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CC_TYPES = new Set(["assistant", "user", "system", "file-history-snapshot", "progress"]);

function collectMarkers(lines: string[]): VersionMarkers {
  const m: VersionMarkers = {
    hasVersionField: false,
    hasUuidField: false,
    hasCcTypes: false,
    hasUsageTokens: false,
  };

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof obj["version"] === "string") m.hasVersionField = true;
    if (typeof obj["uuid"] === "string" && UUID_RE.test(obj["uuid"])) m.hasUuidField = true;
    if (typeof obj["type"] === "string" && CC_TYPES.has(obj["type"])) m.hasCcTypes = true;

    if (obj["type"] === "assistant") {
      const msg = obj["message"];
      if (msg && typeof msg === "object") {
        const usage = (msg as Record<string, unknown>)["usage"];
        if (usage && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          if (typeof u["input_tokens"] === "number") m.hasUsageTokens = true;
        }
      }
    }
  }

  return m;
}

/**
 * Detect schema version by peeking the first `peekCount` lines of the file.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @param peekCount - Number of lines to inspect (default: 10)
 */
export async function detectSchemaVersion(
  filePath: string,
  peekCount = 10
): Promise<SchemaVersion> {
  const lines = await peekLines(filePath, peekCount);
  if (lines.length === 0) return "unknown";

  const m = collectMarkers(lines);

  // v1 criteria: has CC-type rows AND either uuid or version field
  if (m.hasCcTypes && (m.hasVersionField || m.hasUuidField)) {
    return "v1";
  }

  return "unknown";
}

/**
 * Synchronous version operating on already-peeked lines.
 * Useful in tests or when lines have already been loaded.
 */
export function detectSchemaVersionFromLines(lines: string[]): SchemaVersion {
  if (lines.length === 0) return "unknown";
  const m = collectMarkers(lines);
  if (m.hasCcTypes && (m.hasVersionField || m.hasUuidField)) return "v1";
  return "unknown";
}
