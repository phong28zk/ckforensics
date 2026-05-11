/**
 * Streaming JSONL line reader using Bun native APIs.
 *
 * Yields one non-empty line at a time via async iteration.
 * Handles multi-byte UTF-8 boundaries correctly via TextDecoderStream.
 * Memory usage: O(line_length), not O(file_size).
 */

/**
 * Async iterator that yields individual non-empty lines from a JSONL file.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @yields Non-empty string lines (trimmed of trailing whitespace)
 * @throws If the file cannot be opened or read
 */
export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const file = Bun.file(filePath);

  // Bun.file().stream() returns a ReadableStream<Uint8Array>
  const byteStream = file.stream();

  // Decode bytes to text — UTF-8 is the default encoding for TextDecoderStream.
  // The Bun @types declaration omits the label parameter; use no-arg form.
  const textStream = byteStream.pipeThrough(new TextDecoderStream());

  let buffer = "";

  for await (const chunk of textStream) {
    buffer += chunk;

    // Scan for complete lines — split on LF, keep remainder in buffer
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trimEnd(); // strip CR on Windows
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length > 0) {
        yield line;
      }
    }
  }

  // Flush any trailing content without a final newline
  const remainder = buffer.trimEnd();
  if (remainder.length > 0) {
    yield remainder;
  }
}

/**
 * Peek at the first N lines of a JSONL file without consuming the entire stream.
 * Used by schema-detector to sniff version markers.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @param count - Maximum number of lines to return (default: 10)
 */
export async function peekLines(
  filePath: string,
  count = 10
): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readJsonlLines(filePath)) {
    lines.push(line);
    if (lines.length >= count) break;
  }
  return lines;
}
