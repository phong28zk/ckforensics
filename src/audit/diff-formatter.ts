/**
 * Unified diff formatter using LCS (Myers-style) algorithm.
 *
 * No external diff library — pure TypeScript LCS implementation in <100 lines.
 * Output:
 *   - Terminal: ANSI green (+) / red (-) / dim (@@ hunk header)
 *   - Piped / markdown: plain text (no escape codes)
 *
 * Structure matches standard unified diff:
 *   @@ -startA,countA +startB,countB @@
 *   -removed line
 *   +added line
 *    context line
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiffOptions {
  /** Lines of context around each change hunk. Default: 3. */
  context?: number;
  /** Force plain output even in a terminal. Default: auto-detect. */
  plain?: boolean;
  /** Label for "before" side (e.g. filename). */
  fromLabel?: string;
  /** Label for "after" side. */
  toLabel?: string;
}

export interface DiffLine {
  type: "context" | "add" | "remove" | "hunk";
  content: string;
  /** 1-based line number in the "before" file, if applicable */
  lineA?: number;
  /** 1-based line number in the "after" file, if applicable */
  lineB?: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute a unified diff between `before` and `after` strings.
 * Returns structured DiffLine[] for programmatic use.
 */
export function computeDiff(before: string, after: string): DiffLine[] {
  const aLines = splitLines(before);
  const bLines = splitLines(after);
  return buildDiffLines(aLines, bLines);
}

/** Split text into lines, stripping the trailing empty element from a trailing newline. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  // Remove the single empty string at end caused by a trailing newline
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Render a unified diff as a string.
 *
 * Auto-detects whether stdout is a TTY; pass plain=true to suppress ANSI.
 */
export function formatDiff(
  before: string,
  after: string,
  opts: DiffOptions = {}
): string {
  const lines = computeDiff(before, after);
  if (lines.length === 0) return "";

  const usePlain = opts.plain ?? !isTty();
  const ctx = opts.context ?? 3;
  const hunks = groupHunks(lines, ctx);

  const header = buildHeader(opts.fromLabel, opts.toLabel, usePlain);
  const body = hunks.map((h) => renderHunk(h, usePlain)).join("\n");
  return header + body;
}

// ── LCS core ─────────────────────────────────────────────────────────────────

type EditTag = "equal" | "add" | "remove";

interface Edit {
  tag: EditTag;
  aLine?: string;
  bLine?: string;
  aIdx: number;
  bIdx: number;
}

/** Compute LCS table (length only) — O(N*M) time and space. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  // Use flat array for performance
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
  const w = n + 1;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      // Indices are always in bounds by loop construction — non-null assertions are safe
      dp[i * w + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * w + (j - 1)]! + 1
          : Math.max(dp[(i - 1) * w + j]!, dp[i * w + (j - 1)]!);
    }
  }
  return [dp, [m, n, w]] as unknown as number[][];
}

/** Backtrack LCS table into Edit sequence. */
function backtrack(
  dp: number[],
  a: string[],
  b: string[],
  m: number,
  n: number,
  w: number
): Edit[] {
  const edits: Edit[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      edits.push({ tag: "equal", aLine: a[i - 1], bLine: b[j - 1], aIdx: i - 1, bIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * w + (j - 1)]! >= dp[(i - 1) * w + j]!)) {
      edits.push({ tag: "add", bLine: b[j - 1], aIdx: i, bIdx: j - 1 });
      j--;
    } else {
      edits.push({ tag: "remove", aLine: a[i - 1], aIdx: i - 1, bIdx: j });
      i--;
    }
  }

  return edits.reverse();
}

function buildDiffLines(a: string[], b: string[]): DiffLine[] {
  if (a.length === 0 && b.length === 0) return [];

  const [dpFlat, meta] = lcsTable(a, b) as unknown as [number[], number[]];
  const [m, n, w] = meta as [number, number, number];
  const edits = backtrack(dpFlat, a, b, m, n, w);

  const result: DiffLine[] = [];
  let aNum = 1;
  let bNum = 1;

  for (const e of edits) {
    if (e.tag === "equal") {
      result.push({ type: "context", content: ` ${e.aLine ?? ""}`, lineA: aNum, lineB: bNum });
      aNum++; bNum++;
    } else if (e.tag === "remove") {
      result.push({ type: "remove", content: `-${e.aLine ?? ""}`, lineA: aNum });
      aNum++;
    } else {
      result.push({ type: "add", content: `+${e.bLine ?? ""}`, lineB: bNum });
      bNum++;
    }
  }

  return result;
}

// ── Hunk grouping ─────────────────────────────────────────────────────────────

interface Hunk {
  lines: DiffLine[];
  startA: number;
  startB: number;
  countA: number;
  countB: number;
}

function groupHunks(lines: DiffLine[], ctx: number): Hunk[] {
  // Find indices of changed lines
  const changed: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type !== "context") changed.push(i);
  }
  if (changed.length === 0) return [];

  // Build hunk windows: [start, end] index ranges including context
  const windows: Array<[number, number]> = [];
  let wStart = Math.max(0, changed[0]! - ctx);
  let wEnd = Math.min(lines.length - 1, changed[0]! + ctx);

  for (let ci = 1; ci < changed.length; ci++) {
    const next = changed[ci]!;
    if (next - ctx <= wEnd + 1) {
      wEnd = Math.min(lines.length - 1, next + ctx);
    } else {
      windows.push([wStart, wEnd]);
      wStart = Math.max(0, next - ctx);
      wEnd = Math.min(lines.length - 1, next + ctx);
    }
  }
  windows.push([wStart, wEnd]);

  return windows.map(([s, e]) => buildHunk(lines.slice(s, e + 1)));
}

function buildHunk(slice: DiffLine[]): Hunk {
  let countA = 0;
  let countB = 0;
  let startA = slice[0]?.lineA ?? slice[0]?.lineB ?? 1;
  let startB = slice[0]?.lineB ?? slice[0]?.lineA ?? 1;

  for (const l of slice) {
    if (l.type === "context") { countA++; countB++; }
    else if (l.type === "remove") countA++;
    else if (l.type === "add") countB++;
    if (l.lineA && l.type !== "add") startA = Math.min(startA, l.lineA);
    if (l.lineB && l.type !== "remove") startB = Math.min(startB, l.lineB);
  }

  return { lines: slice, startA, startB, countA, countB };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function buildHeader(from?: string, to?: string, plain?: boolean): string {
  if (!from && !to) return "";
  const a = `--- ${from ?? "a"}`;
  const b = `+++ ${to ?? "b"}`;
  if (plain) return `${a}\n${b}\n`;
  return `${dim(a)}\n${dim(b)}\n`;
}

function renderHunk(hunk: Hunk, plain: boolean): string {
  const header = `@@ -${hunk.startA},${hunk.countA} +${hunk.startB},${hunk.countB} @@`;
  const renderedHeader = plain ? header : dim(header);
  const renderedLines = hunk.lines.map((l) => renderLine(l, plain)).join("\n");
  return `${renderedHeader}\n${renderedLines}\n`;
}

function renderLine(line: DiffLine, plain: boolean): string {
  if (plain) return line.content;
  if (line.type === "add") return green(line.content);
  if (line.type === "remove") return red(line.content);
  return line.content;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

function isTty(): boolean {
  return process.stdout.isTTY === true;
}

function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string   { return `\x1b[31m${s}\x1b[0m`; }
function dim(s: string): string   { return `\x1b[2m${s}\x1b[0m`; }
