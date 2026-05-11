/**
 * CLI command: redact <file> [--in-place] [--force]
 *
 * Applies redaction rules to a text file (e.g. exported markdown).
 * By default, writes redacted output to stdout.
 * --in-place replaces the file; requires --force unless a .bak backup is made.
 *
 * Exit codes: 0 success, 1 bad args/missing file, 2 internal error.
 */

import type { Command } from "commander";
import { existsSync, writeFileSync, copyFileSync } from "node:fs";
import { redactFile } from "../../privacy/redactor.ts";
import { DEFAULT_RULES } from "../../privacy/redaction-rules.ts";
import { red, yellow, dim, green } from "../color.ts";

export function registerRedactCommand(program: Command): void {
  program
    .command("redact <file>")
    .description("Apply redaction rules to a file; outputs to stdout by default")
    .option("--in-place", "overwrite the file (creates .bak backup unless --force)", false)
    .option("--force", "skip .bak backup when using --in-place", false)
    .option("--rules <ids>", "comma-separated rule IDs to apply (default: all)")
    .action(async (filePath: string, opts: { inPlace: boolean; force: boolean; rules?: string }) => {
      // Validate file exists
      if (!existsSync(filePath)) {
        process.stderr.write(red(`Error: file not found: ${filePath}\n`));
        process.exit(1);
      }

      // Filter rules if specific IDs requested
      let rules = DEFAULT_RULES;
      if (opts.rules) {
        const ids = new Set(opts.rules.split(",").map((s) => s.trim()));
        rules = DEFAULT_RULES.filter((r) => ids.has(r.id));
        if (rules.length === 0) {
          process.stderr.write(
            red(`Error: no rules matched IDs: ${opts.rules}\n`) +
            `Available: ${DEFAULT_RULES.map((r) => r.id).join(", ")}\n`
          );
          process.exit(1);
        }
      }

      try {
        const redacted = await redactFile(filePath, rules);

        if (opts.inPlace) {
          // Create .bak backup unless --force
          if (!opts.force) {
            const bakPath = filePath + ".bak";
            copyFileSync(filePath, bakPath);
            process.stderr.write(dim(`Backup written to ${bakPath}\n`));
          } else {
            process.stderr.write(
              yellow("Warning: --force skips backup; original cannot be recovered.\n")
            );
          }
          writeFileSync(filePath, redacted, "utf-8");
          process.stderr.write(green(`Redacted in place: ${filePath}\n`));
        } else {
          process.stdout.write(redacted);
        }
      } catch (err) {
        process.stderr.write(red("Error: ") + String(err) + "\n");
        process.exit(2);
      }
    });
}
