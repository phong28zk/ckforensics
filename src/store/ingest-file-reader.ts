/**
 * Low-level byte-offset file reader for the ingest pipeline.
 *
 * Reads a file from a given byte offset and returns all lines with their
 * byte lengths. Uses a single readSync call for throughput, then splits
 * the buffer on newline bytes without decoding the entire content at once.
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";

export interface LineWithBytes {
  /** The decoded line content (empty string for blank lines). */
  line: string;
  /** Byte length of this line including the newline character. */
  byteLen: number;
}

/**
 * Read all lines from filePath starting at startOffset bytes.
 *
 * Returns an empty array if startOffset >= file size (nothing new to read).
 * Lines without a trailing newline (end of file) are included.
 *
 * @param filePath     Absolute path to the file.
 * @param startOffset  Byte offset to begin reading from.
 */
export async function readLinesFromOffset(
  filePath: string,
  startOffset: number
): Promise<LineWithBytes[]> {
  const stat = statSync(filePath);
  const fileSize = stat.size;
  if (startOffset >= fileSize) return [];

  const remaining = fileSize - startOffset;
  const buf = Buffer.allocUnsafe(remaining);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buf, 0, remaining, startOffset);
  } finally {
    closeSync(fd);
  }

  return splitBufferIntoLines(buf, remaining);
}

/**
 * Split a UTF-8 buffer into lines, tracking byte lengths.
 *
 * Operates on the buffer directly (indexOf on bytes) to avoid decoding the
 * entire buffer into a single JS string — faster for large files.
 */
function splitBufferIntoLines(buf: Buffer, length: number): LineWithBytes[] {
  const results: LineWithBytes[] = [];
  let bytePos = 0;

  while (bytePos < length) {
    let nlPos = buf.indexOf(0x0a, bytePos); // 0x0a = '\n'
    if (nlPos === -1) nlPos = length;       // trailing line without \n

    const segLen = nlPos - bytePos;
    const seg = buf.subarray(bytePos, bytePos + segLen);
    // Strip carriage return for Windows-style line endings
    const line = seg.toString("utf-8").replace(/\r$/, "");
    const byteLen = segLen + (nlPos < length ? 1 : 0); // +1 for the \n byte

    results.push({ line, byteLen });
    bytePos = nlPos + 1;
  }

  return results;
}
