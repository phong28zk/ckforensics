/**
 * CLI command: audit <id|--last> [--out FILE] [--format md|json]
 *
 * Builds a SessionManifest for the given session ID and outputs it.
 * Default format is markdown to stdout. --format json emits the envelope.
 * --out FILE writes output to disk instead of stdout.
 *
 * Exit codes: 0 success, 1 bad args, 3 session not found, 2 internal error.
 */

import type { Command } from "commander";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { buildManifest } from "../../audit/manifest-builder.ts";
import { latestSessionId } from "../../audit/session-loader.ts";
import { exportManifestMarkdown } from "../../audit/manifest-markdown-exporter.ts";
import { toJsonEnvelope, manifestToJsonSafe } from "../exporters/json-exporter.ts";
import { red, dim } from "../color.ts";
import { writeFileSync } from "node:fs";

interface GlobalOptions {
  json: boolean;
  db: string;
}

export function registerAuditCommand(program: Command): void {
  program
    .command("audit [id]")
    .description("Build and display a session change manifest")
    .option("--last", "use the most recent session in the DB")
    .option("--format <fmt>", "output format: md|json", "md")
    .option("--out <file>", "write output to FILE instead of stdout")
    .action(async (id: string | undefined, opts: { last: boolean; format: string; out?: string }) => {
      const globals = program.opts<GlobalOptions>();

      const db = openDb(globals.db);
      runMigrations(db);

      try {
        // Resolve session ID
        let sessionId: string;

        if (opts.last) {
          const latest = latestSessionId(db);
          if (!latest) {
            process.stderr.write(red("Error: no sessions in database\n"));
            process.exit(3);
          }
          sessionId = latest;
        } else if (id) {
          sessionId = id;
        } else {
          process.stderr.write(
            red("Error: provide a session ID or --last\n")
          );
          process.exit(1);
        }

        // Build manifest — throws if session not found
        let manifest: Awaited<ReturnType<typeof buildManifest>>;
        try {
          manifest = buildManifest(db, sessionId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("not found")) {
            process.stderr.write(red(`Error: session not found: ${sessionId}\n`));
            process.exit(3);
          }
          throw err;
        }

        // Format output
        const useJson = globals.json || opts.format === "json";
        const output = useJson
          ? toJsonEnvelope(manifestToJsonSafe(manifest))
          : exportManifestMarkdown(manifest);

        if (opts.out) {
          writeFileSync(opts.out, output, "utf-8");
          process.stderr.write(dim(`Written to ${opts.out}\n`));
        } else {
          process.stdout.write(output + "\n");
        }
      } catch (err) {
        process.stderr.write(red("Error: ") + String(err) + "\n");
        process.exit(2);
      } finally {
        closeDb(db);
      }
    });
}
