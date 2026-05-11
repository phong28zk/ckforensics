/**
 * CLI command: export <view> --format=md|json|csv [--out FILE]
 *
 * Views: summary | sessions | audit
 *
 * For audit view, a session ID or --last is required.
 * Output goes to stdout unless --out FILE is specified.
 *
 * Exit codes: 0 success, 1 bad args, 2 internal error, 3 no data.
 */

import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { getSummary } from "../queries/summary-query.ts";
import { listSessions } from "../queries/sessions-query.ts";
import { buildManifest } from "../../audit/manifest-builder.ts";
import { latestSessionId } from "../../audit/session-loader.ts";
import { exportManifestMarkdown } from "../../audit/manifest-markdown-exporter.ts";
import { toJsonEnvelope, manifestToJsonSafe } from "../exporters/json-exporter.ts";
import { toCsv, SUMMARY_CSV_COLUMNS, SESSIONS_CSV_COLUMNS } from "../exporters/csv-exporter.ts";
import { summaryToMarkdown, sessionsToMarkdown } from "../exporters/markdown-exporter.ts";
import { red, dim } from "../color.ts";

type ViewName = "summary" | "sessions" | "audit";
type Format = "md" | "json" | "csv";

interface GlobalOptions { db: string; json: boolean; }

export function registerExportCommand(program: Command): void {
  program
    .command("export <view>")
    .description("Export a view (summary|sessions|audit) in md, json, or csv format")
    .option("--format <fmt>", "output format: md|json|csv", "json")
    .option("--out <file>", "write to FILE instead of stdout")
    .option("--days <n>", "days window for summary view", "7")
    .option("--limit <n>", "max sessions for sessions view", "20")
    .option("--session <id>", "session ID for audit view")
    .option("--last", "use latest session for audit view", false)
    .action(async (
      view: string,
      opts: { format: string; out?: string; days: string; limit: string; session?: string; last: boolean }
    ) => {
      const globals = program.opts<GlobalOptions>();
      const format = (globals.json ? "json" : opts.format) as Format;

      if (!["summary", "sessions", "audit"].includes(view)) {
        process.stderr.write(red(`Error: unknown view "${view}". Use: summary, sessions, audit\n`));
        process.exit(1);
      }

      if (!["md", "json", "csv"].includes(format)) {
        process.stderr.write(red(`Error: unknown format "${format}". Use: md, json, csv\n`));
        process.exit(1);
      }

      const db = openDb(globals.db);
      runMigrations(db);

      try {
        const output = await buildOutput(db, view as ViewName, format, opts);
        if (opts.out) {
          writeFileSync(opts.out, output, "utf-8");
          process.stderr.write(dim(`Exported to ${opts.out}\n`));
        } else {
          process.stdout.write(output + "\n");
        }
      } catch (err) {
        const msg = String(err);
        if (msg.includes("not found")) {
          process.stderr.write(red(`Error: ${msg}\n`));
          process.exit(3);
        }
        process.stderr.write(red("Error: ") + msg + "\n");
        process.exit(2);
      } finally {
        closeDb(db);
      }
    });
}

async function buildOutput(
  db: ReturnType<typeof openDb>,
  view: ViewName,
  format: Format,
  opts: { days: string; limit: string; session?: string; last: boolean }
): Promise<string> {
  if (view === "summary") {
    const days = Math.max(1, parseInt(opts.days, 10) || 7);
    const summary = getSummary(db, days);
    if (format === "json") return toJsonEnvelope(summary);
    if (format === "csv") return toCsv([summary as unknown as Record<string, unknown>], SUMMARY_CSV_COLUMNS);
    return summaryToMarkdown(summary);
  }

  if (view === "sessions") {
    const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
    const sessions = listSessions(db, { limit });
    if (format === "json") return toJsonEnvelope(sessions);
    if (format === "csv") return toCsv(sessions as unknown as Record<string, unknown>[], SESSIONS_CSV_COLUMNS);
    return sessionsToMarkdown(sessions);
  }

  // audit view — requires session ID
  let sessionId: string;
  if (opts.last) {
    const latest = latestSessionId(db);
    if (!latest) throw new Error("no sessions in database");
    sessionId = latest;
  } else if (opts.session) {
    sessionId = opts.session;
  } else {
    process.stderr.write(red("Error: audit view requires --session <id> or --last\n"));
    process.exit(1);
  }

  const manifest = buildManifest(db, sessionId);
  if (format === "json") return toJsonEnvelope(manifestToJsonSafe(manifest));
  if (format === "csv") {
    process.stderr.write(red("Error: csv format is not supported for audit view\n"));
    process.exit(1);
  }
  return exportManifestMarkdown(manifest);
}
