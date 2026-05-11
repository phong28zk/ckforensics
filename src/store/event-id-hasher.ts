/**
 * Deterministic event ID generator for ckforensics ingest.
 *
 * Algorithm: SHA-256( timestamp + raw_json_string ), truncated to first
 * 16 hex characters (64-bit collision space — sufficient for session-scoped
 * deduplication where the primary key is (session_id, event_id)).
 *
 * Uses the Bun-native Bun.CryptoHasher for zero-dependency hashing.
 * Falls back to the Node.js `crypto` module if CryptoHasher is absent
 * (future-proofing for non-Bun runtimes in tests).
 */

/** Length of the hex prefix kept as the event ID (16 chars = 64 bits). */
const HEX_PREFIX_LEN = 16;

/**
 * Compute a deterministic 16-char hex event ID.
 *
 * @param timestamp  ISO-8601 timestamp string (may be empty/undefined).
 * @param rawJson    The raw JSONL line string for this event.
 */
export function computeEventId(
  timestamp: string | undefined,
  rawJson: string
): string {
  const input = (timestamp ?? "") + rawJson;

  // Bun.CryptoHasher is the fastest path in the Bun runtime
  if (typeof Bun !== "undefined" && Bun.CryptoHasher) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input);
    return hasher.digest("hex").slice(0, HEX_PREFIX_LEN);
  }

  // Fallback: Node.js crypto (available in Bun too, but slower)
  // Dynamic import avoided here — use synchronous createHash
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(input).digest("hex").slice(0, HEX_PREFIX_LEN);
}
