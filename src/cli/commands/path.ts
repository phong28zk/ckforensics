/**
 * CLI command: path
 *
 * Prints the resolved DB path and config directory to stdout.
 * Useful for scripting and debugging path resolution across platforms.
 *
 * Exit codes: 0 always.
 */

import type { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveDataDir } from "../../store/path-resolver.ts";
import { resolveLogDir } from "../../lib/log-path-resolver.ts";
import { emitJson, renderKv } from "../output-formatter.ts";

interface GlobalOptions {
  json: boolean;
  db: string;
  logDir: string;
}

export function registerPathCommand(program: Command): void {
  program
    .command("path")
    .description("Print resolved DB and config directory paths")
    .action(() => {
      const globals = program.opts<GlobalOptions>();
      const dataDir = resolveDataDir();
      const logDir = globals.logDir ?? resolveLogDir();
      const jsonlDir = join(homedir(), ".claude", "projects");
      const configDir = join(homedir(), ".config", "ckforensics");

      const paths = {
        db: globals.db,
        dataDir,
        logDir,
        jsonlDir,
        configDir,
      };

      if (globals.json) {
        emitJson(paths);
        return;
      }

      process.stdout.write(
        renderKv([
          ["DB", paths.db],
          ["Data dir", paths.dataDir],
          ["Logs", paths.logDir],
          ["JSONL dir", paths.jsonlDir],
          ["Config dir", paths.configDir],
        ])
      );
    });
}
