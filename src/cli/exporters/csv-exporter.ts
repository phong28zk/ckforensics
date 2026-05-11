/**
 * CSV exporter: converts tabular data to CSV with no external dependencies.
 *
 * Escaping rules (RFC 4180):
 *   - Fields containing comma, double-quote, or newline are quoted.
 *   - Double-quotes inside fields are escaped as "".
 *   - All values are coerced to strings.
 */

/** Escape a single CSV field value per RFC 4180. */
function escapeCsvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  // Quote if contains comma, double-quote, or newline
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convert an array of records to a CSV string.
 *
 * @param rows     Array of plain objects (values coerced to string).
 * @param columns  Ordered list of column keys and headers.
 */
export function toCsv(
  rows: Record<string, unknown>[],
  columns: { key: string; header: string }[]
): string {
  const header = columns.map((c) => escapeCsvField(c.header)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => escapeCsvField(row[c.key])).join(",")
  );
  return [header, ...body].join("\r\n") + "\r\n";
}

/** CSV column definitions for the summary view. */
export const SUMMARY_CSV_COLUMNS = [
  { key: "periodDays", header: "Period (days)" },
  { key: "sessionCount", header: "Sessions" },
  { key: "totalInputTokens", header: "Input Tokens" },
  { key: "totalOutputTokens", header: "Output Tokens" },
  { key: "totalTokens", header: "Total Tokens" },
  { key: "estimatedCostUsd", header: "Est. Cost USD" },
  { key: "filesTouched", header: "Files Touched" },
  { key: "editOps", header: "Edit Ops" },
];

/** CSV column definitions for the sessions list view. */
export const SESSIONS_CSV_COLUMNS = [
  { key: "id", header: "Session ID" },
  { key: "projectSlug", header: "Project" },
  { key: "startedAt", header: "Started At" },
  { key: "endedAt", header: "Ended At" },
  { key: "model", header: "Model" },
  { key: "totalEvents", header: "Events" },
  { key: "inputTokens", header: "Input Tokens" },
  { key: "outputTokens", header: "Output Tokens" },
  { key: "estimatedCostUsd", header: "Est. Cost USD" },
];
