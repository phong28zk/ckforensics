/**
 * CLI command: summary [--days N]
 *
 * Queries DB for aggregated stats over the last N days (default 7).
 * Outputs a table or JSON (--json flag).
 *
 * Exit codes: 0 success, 2 internal error.
 */

import type { Command } from "commander";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { getSummary } from "../queries/summary-query.ts";
import { summaryToMarkdown } from "../exporters/markdown-exporter.ts";
import { emitJson, renderKv } from "../output-formatter.ts";
import { red, bold, cyan } from "../color.ts";

interface SummaryOptions {
  days: string;
  json: boolean;
  db: string;
}

export function registerSummaryCommand(program: Command): void {
  program
    .command("summary")
    .description("Show usage summary (sessions, tokens, cost) for the last N days")
    .option("--days <n>", "rolling window in days", "7")
    .option("--format <fmt>", "output format: text|md|json", "text")
    .action(async (opts: { days: string; format: string }) => {
      const globals = program.opts<SummaryOptions>();
      const days = parseInt(opts.days, 10);

      if (isNaN(days) || days < 1) {
        process.stderr.write(red("Error: --days must be a positive integer\n"));
        process.exit(1);
      }

      const db = openDb(globals.db);
      runMigrations(db);

      try {
        const summary = getSummary(db, days);

        if (globals.json || opts.format === "json") {
          emitJson(summary);
          return;
        }

        if (opts.format === "md") {
          process.stdout.write(summaryToMarkdown(summary));
          return;
        }

        // Default: text table
        const cost = summary.estimatedCostUsd > 0
          ? `$${summary.estimatedCostUsd.toFixed(4)}`
          : "unknown";

        process.stdout.write(
          bold(cyan(`Usage Summary — Last ${summary.periodDays} Days\n`))
        );
        process.stdout.write(
          renderKv([
            ["Sessions", String(summary.sessionCount)],
            ["Input tokens", summary.totalInputTokens.toLocaleString()],
            ["Output tokens", summary.totalOutputTokens.toLocaleString()],
            ["Cache read", summary.totalCacheRead.toLocaleString()],
            ["Total tokens", summary.totalTokens.toLocaleString()],
            ["Estimated cost", cost],
            ["Files touched", String(summary.filesTouched)],
            ["Edit operations", String(summary.editOps)],
          ])
        );
      } finally {
        closeDb(db);
      }
    });
}
