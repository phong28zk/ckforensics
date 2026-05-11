/**
 * Shared output formatter: handles --json mode and text table rendering.
 *
 * --json flag forces machine-readable output on every subcommand.
 * Text mode renders aligned column tables using ANSI when color enabled.
 */

import { bold, dim } from "./color.ts";

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/** Visible character length, ignoring ANSI escape sequences. */
function visibleLength(s: string): number {
  return s.replace(ANSI_REGEX, "").length;
}

/** Truncate string to width, using ellipsis at the END (right). */
export function truncateRight(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  return s.slice(0, width - 1) + "…";
}

/** Pad a string to visible width, accounting for ANSI codes. */
function padVisible(s: string, width: number, align: "left" | "right"): string {
  const vl = visibleLength(s);
  if (vl >= width) return s;
  const pad = " ".repeat(width - vl);
  return align === "right" ? pad + s : s + pad;
}

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

  // Compute column widths (visible length, ANSI-stripped)
  const widths = columns.map((col) => {
    const maxVal = Math.max(
      ...rows.map((r) => visibleLength(String(r[col.key] ?? "")))
    );
    return col.width ?? Math.max(col.header.length, maxVal);
  });

  const sep = "  ";
  const header = columns
    .map((col, i) => bold(padVisible(col.header, widths[i]!, "left")))
    .join(sep);
  const divider = widths.map((w) => "─".repeat(w)).join(sep);

  const body = rows.map((row) =>
    columns
      .map((col, i) => {
        const raw = String(row[col.key] ?? "");
        const w = widths[i]!;
        const truncated = visibleLength(raw) > w ? truncateRight(raw, w) : raw;
        return padVisible(truncated, w, col.align ?? "left");
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
