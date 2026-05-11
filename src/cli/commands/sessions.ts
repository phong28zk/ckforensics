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
import { red, dim, bold, cyan, green, yellow } from "../color.ts";

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

        // Default text table — compact, color-tiered, smart truncation
        process.stdout.write(bold(cyan("Recent Sessions\n")));
        const tableRows = sessions.map((s) => ({
          id: s.id.slice(0, 8),
          project: shortProject(s.cwd, s.projectSlug),
          started: s.startedAt ? fmtDate(s.startedAt) : "—",
          model: shortModel(s.model),
          events: String(s.totalEvents),
          cost: colorCost(s.estimatedCostUsd),
          duration: fmtDuration(s.durationMs),
        }));

        process.stdout.write(
          renderTable(tableRows, [
            { header: "ID",       key: "id",       width: 8 },
            { header: "Project",  key: "project",  width: 28 },
            { header: "Started",  key: "started",  width: 16 },
            { header: "Model",    key: "model",    width: 10 },
            { header: "Events",   key: "events",   width: 6,  align: "right" },
            { header: "Cost",     key: "cost",     width: 10, align: "right" },
            { header: "Duration", key: "duration", width: 8,  align: "right" },
          ])
        );
        process.stdout.write(
          dim(`\n${sessions.length} sessions shown · use --limit N to change · costs are API-rate equivalent\n`)
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
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;
}

/**
 * Compact project label: basename of cwd (preferred) or slug fallback.
 *   cwd = "/media/sandro8/GM/0.Work/ckforensics"     → "ckforensics"
 *   cwd = "/home/.../project-noname"                 → "project-noname"
 *   no cwd, slug = "-media-...-ckforensics"          → "ckforensics" (heuristic)
 *   no cwd, slug = "test-project"                    → "test-project"
 *
 * Migration 002 added `cwd` so new ingests get accurate basenames. Older
 * sessions ingested before migration may have null cwd → slug heuristic.
 */
function shortProject(cwd: string | null, slug: string): string {
  if (cwd) {
    const parts = cwd.split("/").filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  if (!slug) return "—";
  if (!slug.startsWith("-")) return slug;
  const parts = slug.replace(/^-/, "").split("-").filter(Boolean);
  return parts.length === 0 ? slug : parts[parts.length - 1]!;
}

/** "claude-opus-4-7" → "Opus 4.7"; "claude-sonnet-4-6" → "Sonnet 4.6" */
function shortModel(model: string | null): string {
  if (!model) return "—";
  const m = model.toLowerCase();
  const match = m.match(/(opus|sonnet|haiku)-?(\d+)-?(\d+)?/);
  if (!match) return model;
  const [, fam, maj, min] = match;
  const name = fam!.charAt(0).toUpperCase() + fam!.slice(1);
  return `${name} ${maj}${min ? "." + min : ""}`;
}

/** Color-code cost by tier and format as $X.YY */
function colorCost(cost: number | null): string {
  if (cost == null || cost === 0) return dim("—");
  const formatted = `$${cost.toFixed(cost >= 1 ? 2 : 4)}`;
  if (cost >= 10) return red(formatted);
  if (cost >= 1) return yellow(formatted);
  return green(formatted);
}
