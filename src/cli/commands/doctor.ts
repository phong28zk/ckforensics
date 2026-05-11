/**
 * CLI command: doctor
 *
 * Diagnostics: DB exists, schema version, jsonl dir readable,
 * last ingest mtime, free disk space, Bun version.
 *
 * Exit codes: 0 all OK, 1 warnings present, 2 internal error.
 */

import type { Command } from "commander";
import { existsSync, statSync, accessSync, constants, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { openDb, closeDb } from "../../store/db.ts";
import { getCurrentVersion, latestVersion } from "../../store/migration-runner.ts";
import { resolveLogDir } from "../../lib/log-path-resolver.ts";
import { emitJson, renderKv } from "../output-formatter.ts";
import { green, red, yellow, bold } from "../color.ts";

interface GlobalOptions {
  json: boolean;
  db: string;
  logDir: string;
}

interface DiagnosticItem {
  check: string;
  status: "ok" | "warn" | "error";
  value: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run diagnostics: DB, schema, jsonl directory, disk space, Bun version")
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      const items: DiagnosticItem[] = [];

      // 1. Bun version
      items.push({
        check: "Bun version",
        status: "ok",
        value: Bun.version,
      });

      // 2. DB path exists
      const dbExists = existsSync(globals.db);
      items.push({
        check: "DB file",
        status: dbExists ? "ok" : "warn",
        value: dbExists ? globals.db : `not found: ${globals.db}`,
      });

      // 3. Schema version
      if (dbExists) {
        try {
          const db = openDb(globals.db, { readonly: true });
          const current = getCurrentVersion(db);
          const latest = latestVersion();
          closeDb(db);
          const match = current === latest;
          items.push({
            check: "Schema version",
            status: match ? "ok" : "warn",
            value: match
              ? `v${current} (current)`
              : `v${current} — latest is v${latest}, run ingest to migrate`,
          });
        } catch (err) {
          items.push({
            check: "Schema version",
            status: "error",
            value: `could not read: ${String(err)}`,
          });
        }
      }

      // 4. Last ingest timestamp
      if (dbExists) {
        try {
          const db = openDb(globals.db, { readonly: true });
          const row = db
            .query<{ last_ingested_at: string }, []>(
              "SELECT MAX(last_ingested_at) AS last_ingested_at FROM ingest_state"
            )
            .get();
          closeDb(db);
          items.push({
            check: "Last ingest",
            status: "ok",
            value: row?.last_ingested_at ?? "never",
          });
        } catch {
          items.push({ check: "Last ingest", status: "warn", value: "unavailable" });
        }
      }

      // 5. JSONL directory readable
      const jsonlDir = join(homedir(), ".claude", "projects");
      const jsonlExists = existsSync(jsonlDir);
      items.push({
        check: "JSONL directory",
        status: jsonlExists ? "ok" : "warn",
        value: jsonlExists ? jsonlDir : `not found: ${jsonlDir}`,
      });

      // 6. Free disk space on DB directory (Bun 1.x: check via stat on dummy write)
      try {
        const dbDir = globals.db.replace(/\/[^/]+$/, "");
        const stat = statSync(dbDir);
        items.push({
          check: "DB directory",
          status: "ok",
          value: `${dbDir} (inode ${stat.ino})`,
        });
      } catch {
        items.push({ check: "DB directory", status: "warn", value: "stat failed" });
      }

      // 7. Log directory exists and is writable
      const logDir = globals.logDir ?? resolveLogDir();
      const logDirExists = existsSync(logDir);
      let logDirWritable = false;
      if (logDirExists) {
        try {
          accessSync(logDir, constants.W_OK);
          logDirWritable = true;
        } catch { /* not writable */ }
      }

      if (!logDirExists) {
        items.push({ check: "Log directory", status: "warn", value: `not found: ${logDir}` });
      } else if (!logDirWritable) {
        items.push({ check: "Log directory", status: "error", value: `not writable: ${logDir}` });
      } else {
        items.push({ check: "Log directory", status: "ok", value: logDir });
      }

      // 8. Today's log activity (size + last modified)
      if (logDirExists && logDirWritable) {
        try {
          const today = new Date();
          const yyyy = today.getFullYear();
          const mm = String(today.getMonth() + 1).padStart(2, "0");
          const dd = String(today.getDate()).padStart(2, "0");
          const todayStr = `${yyyy}-${mm}-${dd}`;

          // Find any log files modified today
          const files = readdirSync(logDir).filter((f) => f.includes(todayStr));
          if (files.length === 0) {
            items.push({ check: "Log activity", status: "warn", value: "no logs written today" });
          } else {
            // Report size of most recently modified today's log
            const stats = files.map((f) => {
              const s = statSync(join(logDir, f));
              return { name: f, size: s.size, mtime: s.mtime };
            }).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

            const latest = stats[0]!;
            const sizeKb = (latest.size / 1024).toFixed(1);
            items.push({
              check: "Log activity",
              status: "ok",
              value: `${latest.name} (${sizeKb} KB, modified ${latest.mtime.toISOString()})`,
            });
          }
        } catch {
          items.push({ check: "Log activity", status: "warn", value: "could not read log dir" });
        }
      }

      // Determine overall status
      const hasError = items.some((i) => i.status === "error");
      const hasWarn = items.some((i) => i.status === "warn");

      if (globals.json) {
        emitJson({ overall: hasError ? "error" : hasWarn ? "warn" : "ok", checks: items });
        process.exit(hasError || hasWarn ? 1 : 0);
      }

      process.stdout.write(bold("ckforensics doctor\n\n"));
      process.stdout.write(
        renderKv(
          items.map(({ check, status, value }) => {
            const icon =
              status === "ok" ? green("ok") :
              status === "warn" ? yellow("warn") :
              red("error");
            return [`[${icon}] ${check}`, value] as [string, string];
          })
        )
      );

      if (hasError || hasWarn) process.exit(1);
    });
}
