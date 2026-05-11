/**
 * Deterministic item ID generator for context map items.
 *
 * Uses a simple djb2-style hash over a stable key string so that the same
 * logical item (same tool call, same turn) always gets the same ID, enabling
 * diff and pin operations to work across snapshots.
 *
 * Format: <category>-<hex8>  e.g. "tool_result-a3f2b1c0"
 */

/**
 * Compute a deterministic 8-hex-char ID for a context item.
 *
 * @param category   Item source type string (e.g. "tool_result")
 * @param key        Stable key: toolCallId, messageId, turnIndex+preview, etc.
 */
export function hashItemId(category: string, key: string): string {
  const hash = djb2(`${category}:${key}`);
  return `${category}-${hash.toString(16).padStart(8, "0")}`;
}

/** djb2 hash — produces a 32-bit unsigned integer. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // (h << 5) + h = h * 33; keep within 32-bit unsigned
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}
