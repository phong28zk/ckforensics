/**
 * CLI command: sessions [--project SLUG] [--limit N]
 *
 * Lists recent sessions with id, project, date, cost, duration.
 * Supports --json and --format md|csv|text.
 *
 * Exit codes: 0 success, 3 no data, 2 internal error.
 */

import type { Command } from "commander";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { listSessions } from "../queries/sessions-query.ts";
import { sessionsToMarkdown } from "../exporters/markdown-exporter.ts";
import { toCsv, SESSIONS_CSV_COLUMNS } from "../exporters/csv-exporter.ts";
import { emitJson, renderTable } from "../output-formatter.ts";
import { red, dim, bold, cyan } from "../color.ts";

interface GlobalOptions {
  json: boolean;
  db: string;
}

export function registerSessionsCommand(program: Command): void {
  program
    .command("sessions")
    .description("List recent sessions with metadata")
    .option("--project <slug>", "filter by project slug")
    .option("--limit <n>", "maximum number of sessions to show", "20")
    .option("--format <fmt>", "output format: text|md|csv|json", "text")
    .action(async (opts: { project?: string; limit: string; format: string }) => {
      const globals = program.opts<GlobalOptions>();

      const limit = parseInt(opts.limit, 10);
      if (isNaN(limit) || limit < 1) {
        process.stderr.write(red("Error: --limit must be a positive integer\n"));
        process.exit(1);
      }

      const db = openDb(globals.db);
      runMigrations(db);

      try {
        const sessions = listSessions(db, {
          projectSlug: opts.project,
          limit,
        });

        if (sessions.length === 0) {
          if (globals.json || opts.format === "json") {
            emitJson([]);
          } else {
            process.stdout.write(dim("No sessions found.\n"));
          }
          process.exit(3);
        }

        if (globals.json || opts.format === "json") {
          emitJson(sessions);
          return;
        }

        if (opts.format === "md") {
          process.stdout.write(sessionsToMarkdown(sessions));
          return;
        }

        if (opts.format === "csv") {
          const rows = sessions.map((s) => ({
            ...s,
            estimatedCostUsd: s.estimatedCostUsd != null
              ? s.estimatedCostUsd.toFixed(4)
              : "",
          }));
          process.stdout.write(toCsv(rows as Record<string, unknown>[], SESSIONS_CSV_COLUMNS));
          return;
        }

        // Default text table
        process.stdout.write(bold(cyan("Recent Sessions\n")));
        const tableRows = sessions.map((s) => ({
          id: s.id.slice(0, 8) + "…",
          project: s.projectSlug,
          started: s.startedAt ? fmtDate(s.startedAt) : "—",
          model: s.model ?? "—",
          events: String(s.totalEvents),
          cost: s.estimatedCostUsd != null
            ? `$${s.estimatedCostUsd.toFixed(4)}`
            : "—",
          duration: fmtDuration(s.durationMs),
        }));

        process.stdout.write(
          renderTable(tableRows, [
            { header: "ID", key: "id", width: 10 },
            { header: "Project", key: "project", width: 24 },
            { header: "Started", key: "started", width: 19 },
            { header: "Model", key: "model", width: 20 },
            { header: "Events", key: "events", width: 7, align: "right" },
            { header: "Cost", key: "cost", width: 10, align: "right" },
            { header: "Duration", key: "duration", width: 10 },
          ])
        );
      } finally {
        closeDb(db);
      }
    });
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return iso;
  }
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
