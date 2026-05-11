/**
 * Shared output formatter: handles --json mode and text table rendering.
 *
 * --json flag forces machine-readable output on every subcommand.
 * Text mode renders aligned column tables using ANSI when color enabled.
 */

import { bold, dim } from "./color.ts";

/** Write JSON to stdout with the standard ckforensics envelope. */
export function emitJson(data: unknown): void {
  const envelope = {
    $schema: "ckforensics-export-v1",
    generatedAt: new Date().toISOString(),
    data,
  };
  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
}

/** Write raw JSON (no envelope) — for audit export which has its own structure. */
export function emitRawJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export interface Column {
  header: string;
  key: string;
  width?: number;
  align?: "left" | "right";
}

/** Render a list of records as an aligned text table. */
export function renderTable(
  rows: Record<string, string | number>[],
  columns: Column[]
): string {
  if (rows.length === 0) return dim("(no data)") + "\n";

  // Compute column widths
  const widths = columns.map((col) => {
    const maxVal = Math.max(
      ...rows.map((r) => String(r[col.key] ?? "").length)
    );
    return col.width ?? Math.max(col.header.length, maxVal);
  });

  const sep = "  ";
  const header = columns
    .map((col, i) => bold(col.header.padEnd(widths[i]!)))
    .join(sep);
  const divider = widths.map((w) => "─".repeat(w)).join(sep);

  const body = rows.map((row) =>
    columns
      .map((col, i) => {
        const val = String(row[col.key] ?? "");
        return col.align === "right"
          ? val.padStart(widths[i]!)
          : val.padEnd(widths[i]!);
      })
      .join(sep)
  );

  return [header, divider, ...body].join("\n") + "\n";
}

/** Print a key-value list (for doctor, path, etc.). */
export function renderKv(pairs: [string, string][]): string {
  const keyWidth = Math.max(...pairs.map(([k]) => k.length));
  return pairs
    .map(([k, v]) => `${bold(k.padEnd(keyWidth))}  ${v}`)
    .join("\n") + "\n";
}
