/**
 * CLI command: ingest [--watch]
 *
 * Scans ~/.claude/projects/ for JSONL files, ingests new/changed content.
 * --watch polls every 5 seconds for file changes.
 *
 * Exit codes: 0 success, 2 internal error.
 */

import type { Command } from "commander";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { discoverJsonlFiles } from "../../store/discovery.ts";
import { ingestFile } from "../../store/ingest.ts";
import { green, yellow, dim, red } from "../color.ts";
import { emitJson } from "../output-formatter.ts";

interface IngestOptions {
  watch: boolean;
  json: boolean;
  verbose: boolean;
  db: string;
}

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest")
    .description("Ingest Claude Code JSONL sessions from ~/.claude/projects/")
    .option("--watch", "poll for new/changed files every 5 seconds", false)
    .action(async (opts: { watch: boolean }) => {
      const globals = program.opts<IngestOptions>();
      const options = { ...globals, ...opts };

      try {
        if (options.watch) {
          await runWatchMode(options);
        } else {
          await runOnce(options);
        }
      } catch (err) {
        process.stderr.write(red("Error: ") + String(err) + "\n");
        process.exit(2);
      }
    });
}

async function runOnce(options: IngestOptions): Promise<void> {
  const db = openDb(options.db);
  runMigrations(db);
  try {
    const result = await ingestAll(db, options);
    if (options.json) {
      emitJson(result);
    } else {
      const msg = `Ingested ${green(String(result.totalInserted))} events from ${result.filesProcessed} files`;
      process.stdout.write(msg + "\n");
    }
  } finally {
    closeDb(db);
  }
}

async function runWatchMode(options: IngestOptions): Promise<void> {
  process.stderr.write(dim("Watching for changes (Ctrl+C to stop)…\n"));
  const db = openDb(options.db);
  runMigrations(db);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await ingestAll(db, options);
    if (result.totalInserted > 0) {
      if (options.json) {
        emitJson({ ...result, mode: "watch" });
      } else {
        process.stdout.write(
          `[${new Date().toISOString()}] +${green(String(result.totalInserted))} events from ${result.filesProcessed} files\n`
        );
      }
    } else if (options.verbose) {
      process.stderr.write(dim(`[${new Date().toISOString()}] no changes\n`));
    }
    await Bun.sleep(5000);
  }
}

interface IngestAllResult {
  filesProcessed: number;
  filesSkipped: number;
  totalInserted: number;
  totalRead: number;
}

async function ingestAll(
  db: ReturnType<typeof openDb>,
  options: IngestOptions
): Promise<IngestAllResult> {
  const files = await discoverJsonlFiles();
  let filesProcessed = 0;
  let filesSkipped = 0;
  let totalInserted = 0;
  let totalRead = 0;

  for (const file of files) {
    try {
      const result = await ingestFile(db, file.path, file.projectSlug);
      if (result.linesRead > 0) {
        filesProcessed++;
        totalInserted += result.eventsInserted;
        totalRead += result.linesRead;
        if (options.verbose) {
          process.stderr.write(
            dim(`  ${file.path}: +${result.eventsInserted} events\n`)
          );
        }
      } else {
        filesSkipped++;
      }
    } catch (err) {
      process.stderr.write(
        yellow(`Warning: failed to ingest ${file.path}: ${String(err)}\n`)
      );
    }
  }

  return { filesProcessed, filesSkipped, totalInserted, totalRead };
}
