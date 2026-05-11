#!/usr/bin/env bun
/**
 * ckforensics CLI entry point.
 *
 * Global flags (inherited by all subcommands):
 *   --db PATH       Override default SQLite DB location
 *   --no-color      Disable ANSI colour output
 *   -v, --verbose   Verbose logging to stderr
 *   --json          Force JSON output on every subcommand
 *
 * Subcommands: ingest | summary | sessions | audit | export | redact | doctor | path
 *
 * Exit codes:
 *   0  success
 *   1  user error (bad args, missing required param)
 *   2  internal error (exception)
 *   3  no data found (empty DB, session not found)
 */

import { Command } from "commander";
import { disableColor } from "./color.ts";
import { resolveDbPath } from "../store/path-resolver.ts";
import { resolveLogDir } from "../lib/log-path-resolver.ts";
import { registerIngestCommand } from "./commands/ingest.ts";
import { registerSummaryCommand } from "./commands/summary.ts";
import { registerSessionsCommand } from "./commands/sessions.ts";
import { registerAuditCommand } from "./commands/audit.ts";
import { registerExportCommand } from "./commands/export.ts";
import { registerRedactCommand } from "./commands/redact.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerPathCommand } from "./commands/path.ts";
import { registerSuggestCommand } from "./commands/suggest.ts";
import { registerSkillsCommand } from "./commands/skills.ts";
import { registerMapCommand } from "./commands/map.ts";

// ── Build program ──────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("ckforensics")
  .description(
    "Forensic analysis and audit tool for Claude Code session logs.\n" +
    "Ingests JSONL sessions, queries usage, and exports reports."
  )
  .version("0.2.1", "-V, --version", "print version and exit")
  // Global flags — available on all subcommands via program.opts()
  .option("--db <path>", "override SQLite database path", resolveDbPath())
  .option("--no-color", "disable ANSI colour output")
  .option("-v, --verbose", "verbose logging to stderr", false)
  // Commander requires single-char short flags; --debug has no short alias.
  .option("--debug", "debug logging (implies --verbose)", false)
  .option("--log-dir <path>", "override log directory", resolveLogDir())
  .option("--json", "force JSON output (overrides --format)", false)
  // Apply --no-color as early as possible; resolve effective log level
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{ color: boolean; json: boolean; debug: boolean; verbose: boolean }>();
    if (!opts.color) disableColor();
  });

// ── Register subcommands ───────────────────────────────────────────────────────

registerIngestCommand(program);
registerSummaryCommand(program);
registerSessionsCommand(program);
registerAuditCommand(program);
registerExportCommand(program);
registerRedactCommand(program);
registerDoctorCommand(program);
registerPathCommand(program);
registerSuggestCommand(program);
registerSkillsCommand(program);
registerMapCommand(program);

// ── Parse & run ────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write("Fatal: " + String(err) + "\n");
  process.exit(2);
});
