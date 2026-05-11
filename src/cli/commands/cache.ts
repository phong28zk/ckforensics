/**
 * CLI command: cache [--session ID|--last|--days N=7] [--format text|md|json]
 *
 * Surfaces cache hit/miss statistics from token_usage.
 *
 * Exit codes: 0 success, 1 bad args, 2 internal error, 3 session not found.
 *
 * Hit ratio colour coding:
 *   green  ≥70%   — excellent cache reuse
 *   yellow 40-69% — moderate reuse
 *   red    <40%   — poor reuse
 */

import type { Command } from "commander";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { latestSessionId } from "../../audit/session-loader.ts";
import { getCacheBreakdown } from "../queries/cache-query.ts";
import { emitRawJson } from "../output-formatter.ts";
import { bold, dim, green, yellow, red } from "../color.ts";
import type { CacheBreakdown, SessionCacheRow } from "../queries/cache-query.ts";

interface GlobalOptions { json: boolean; db: string }

interface CacheOptions {
  session?: string;
  last: boolean;
  days?: string;
  format: string;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Format token count as human-readable (e.g. 934M, 45k, 123). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** Format ratio as percentage string (e.g. "93%"). */
function fmtPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Colour-code a hit ratio string. */
function colorPct(ratio: number): string {
  const s = fmtPct(ratio);
  if (ratio >= 0.7) return green(s);
  if (ratio >= 0.4) return yellow(s);
  return red(s);
}

/** Qualitative label for a hit ratio. */
function ratioLabel(ratio: number): string {
  if (ratio >= 0.7) return "excellent — prompt cache reuse working";
  if (ratio >= 0.4) return "moderate — cache partially effective";
  return "poor — cache barely active";
}

/** Shorten session ID to first 8 hex chars. */
function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

// ── Text renderer ─────────────────────────────────────────────────────────────

function renderText(data: CacheBreakdown, label: string): string {
  const lines: string[] = [];
  lines.push(bold(`Cache Performance — ${label}`));
  lines.push(dim("─".repeat(42)));
  lines.push(`Total cache read:    ${bold(fmtTokens(data.totalCacheRead))} tokens`);
  lines.push(`Total cache write:   ${bold(fmtTokens(data.totalCacheCreate))} tokens`);
  lines.push(`Total input:         ${bold(fmtTokens(data.totalInput))} tokens`);

  const pctStr = colorPct(data.cacheHitRatio);
  lines.push(`Cache hit ratio:     ${pctStr}   (${ratioLabel(data.cacheHitRatio)})`);
  lines.push(`Estimated savings:   ${bold("$" + data.estimatedSavingsUsd.toFixed(2))}  vs pay-as-you-go input rates`);

  if (data.bySession.length > 0) {
    lines.push("");
    lines.push(bold("Top sessions by cache reuse:"));
    const top = data.bySession.slice(0, 10);
    top.forEach((row, i) => {
      const rank = `#${i + 1}`.padEnd(3);
      const id = shortId(row.sessionId).padEnd(10);
      const proj = row.projectSlug.slice(0, 20).padEnd(20);
      const reads = `${fmtTokens(row.cacheRead)} reads`.padEnd(12);
      const pct = colorPct(row.hitRatio).padEnd(5);
      const saved = `$${row.savingsUsd.toFixed(2)} saved`;
      lines.push(`${rank} ${id} ${proj} ${reads} ${pct} hit  ${saved}`);
    });
  }

  return lines.join("\n") + "\n";
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function renderMarkdown(data: CacheBreakdown, label: string): string {
  const lines: string[] = [];
  lines.push(`## Cache Performance — ${label}`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Cache read | ${fmtTokens(data.totalCacheRead)} tokens |`);
  lines.push(`| Cache write | ${fmtTokens(data.totalCacheCreate)} tokens |`);
  lines.push(`| Input | ${fmtTokens(data.totalInput)} tokens |`);
  lines.push(`| Hit ratio | ${fmtPct(data.cacheHitRatio)} |`);
  lines.push(`| Estimated savings | $${data.estimatedSavingsUsd.toFixed(2)} |`);

  if (data.bySession.length > 0) {
    lines.push("");
    lines.push("### Sessions");
    lines.push("");
    lines.push("| # | Session | Project | Cache Read | Hit % | Savings |");
    lines.push("|---|---------|---------|-----------|-------|---------|");
    data.bySession.slice(0, 10).forEach((row, i) => {
      lines.push(
        `| ${i + 1} | ${shortId(row.sessionId)} | ${row.projectSlug} | ${fmtTokens(row.cacheRead)} | ${fmtPct(row.hitRatio)} | $${row.savingsUsd.toFixed(2)} |`
      );
    });
  }

  return lines.join("\n") + "\n";
}

// ── Session resolution ────────────────────────────────────────────────────────

function resolveOpts(
  db: ReturnType<typeof openDb>,
  opts: CacheOptions
): { queryOpts: { days?: number; sessionId?: string }; label: string } {
  if (opts.session) {
    return { queryOpts: { sessionId: opts.session }, label: `Session ${shortId(opts.session)}` };
  }
  if (opts.last) {
    const id = latestSessionId(db);
    if (!id) return { queryOpts: { sessionId: "__none__" }, label: "Latest Session" };
    return { queryOpts: { sessionId: id }, label: `Latest Session (${shortId(id)})` };
  }
  const days = opts.days !== undefined ? parseInt(opts.days, 10) : 7;
  return { queryOpts: { days }, label: `Last ${days} Day${days === 1 ? "" : "s"}` };
}

// ── Register command ──────────────────────────────────────────────────────────

export function registerCacheCommand(program: Command): void {
  program
    .command("cache")
    .description("Show cache hit/miss statistics and estimated savings")
    .option("--session <id>", "analyze specific session by ID")
    .option("--last", "analyze most recent session", false)
    .option("--days <n>", "analyze sessions from the last N days (default 7)")
    .option("--format <fmt>", "output format: text|md|json", "text")
    .action(async (opts: CacheOptions) => {
      const globals = program.opts<GlobalOptions>();

      // Validate --days if provided
      if (opts.days !== undefined) {
        const d = parseInt(opts.days, 10);
        if (isNaN(d) || d < 0) {
          process.stderr.write(red("Error: --days must be a non-negative integer\n"));
          process.exit(1);
        }
      }

      const db = openDb(globals.db);
      try {
        runMigrations(db);

        const { queryOpts, label } = resolveOpts(db, opts);
        let data: CacheBreakdown;
        try {
          data = getCacheBreakdown(db, queryOpts);
        } catch (err) {
          process.stderr.write(red(`Error: ${String(err)}\n`));
          process.exit(2);
        }

        const useJson = globals.json || opts.format === "json";

        if (useJson) {
          emitRawJson({
            $schema: "ckforensics-cache-v1",
            generatedAt: new Date().toISOString(),
            label,
            data,
          });
          return;
        }

        if (opts.format === "md") {
          process.stdout.write(renderMarkdown(data, label));
          return;
        }

        // Default: text
        process.stdout.write(renderText(data, label));
      } finally {
        closeDb(db);
      }
    });
}
