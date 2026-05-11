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
import { Logger } from "../../lib/logger.ts";
import type { LogLevel } from "../../lib/logger.ts";

interface IngestOptions {
  watch: boolean;
  json: boolean;
  verbose: boolean;
  debug: boolean;
  db: string;
  logDir: string;
}

function resolveLevel(opts: { verbose: boolean; debug: boolean }): LogLevel {
  if (opts.debug) return "debug";
  if (opts.verbose) return "info";
  return "error";
}

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest")
    .description("Ingest Claude Code JSONL sessions from ~/.claude/projects/")
    .option("--watch", "poll for new/changed files every 5 seconds", false)
    .action(async (opts: { watch: boolean }) => {
      const globals = program.opts<IngestOptions>();
      const options = { ...globals, ...opts };
      const log = new Logger({
        command: "ingest",
        level: resolveLevel(options),
        logDir: options.logDir,
      });

      log.info("start", { watch: options.watch });
      const t0 = Date.now();

      try {
        if (options.watch) {
          await runWatchMode(options, log);
        } else {
          await runOnce(options, log);
        }
        log.info("done", { durationMs: Date.now() - t0 });
      } catch (err) {
        log.error("failed", { error: String(err), durationMs: Date.now() - t0 });
        process.stderr.write(red("Error: ") + String(err) + "\n");
        process.exit(2);
      }
    });
}

async function runOnce(options: IngestOptions, log: Logger): Promise<void> {
  const db = openDb(options.db);
  runMigrations(db);
  try {
    const result = await ingestAll(db, options, log);
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

async function runWatchMode(options: IngestOptions, log: Logger): Promise<void> {
  process.stderr.write(dim("Watching for changes (Ctrl+C to stop)…\n"));
  const db = openDb(options.db);
  runMigrations(db);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await ingestAll(db, options, log);
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
  options: IngestOptions,
  log: Logger
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
        log.debug("file ingested", { path: file.path, eventsInserted: result.eventsInserted });
        if (options.verbose) {
          process.stderr.write(
            dim(`  ${file.path}: +${result.eventsInserted} events\n`)
          );
        }
      } else {
        filesSkipped++;
        log.debug("file skipped", { path: file.path });
      }
    } catch (err) {
      log.error("file ingest failed", { path: file.path, error: String(err) });
      process.stderr.write(
        yellow(`Warning: failed to ingest ${file.path}: ${String(err)}\n`)
      );
    }
  }

  return { filesProcessed, filesSkipped, totalInserted, totalRead };
}
