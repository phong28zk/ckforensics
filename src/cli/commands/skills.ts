/**
 * CLI command: skills [--unused|--used] [--search QUERY] [--refresh]
 *
 * Displays the indexed skill catalog with usage stats.
 * Default: table of all skills with Name, Description, Used, LastUsed columns.
 * --refresh: re-indexes catalog from ~/.claude/skills/ before displaying.
 *
 * Output formats: text (default table), --format md|csv, --json.
 * Exit codes: 0 success, 1 bad args, 2 internal error.
 */

import type { Command } from "commander";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { indexSkillCatalog, loadCatalog } from "../../recommender/skill-catalog-indexer.ts";
import { getAggregateSkillUsage } from "../../recommender/skill-usage-tracker.ts";
import { emitJson, renderTable, truncateRight } from "../output-formatter.ts";
import { bold, green, dim, cyan } from "../color.ts";
import type { SkillCatalogEntry } from "../../recommender/types.ts";

interface GlobalOptions {
  json: boolean;
  db: string;
}

interface SkillsOptions {
  unused: boolean;
  used: boolean;
  search?: string;
  refresh: boolean;
  format: string;
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function filterSkills(
  skills: SkillCatalogEntry[],
  usageMap: Map<string, { sessions: number; totalActivations: number; lastUsed: string | null }>,
  opts: SkillsOptions
): SkillCatalogEntry[] {
  let result = skills;

  if (opts.unused) {
    result = result.filter((s) => !usageMap.has(s.name));
  } else if (opts.used) {
    result = result.filter((s) => usageMap.has(s.name));
  }

  if (opts.search) {
    const q = opts.search.toLowerCase();
    result = result.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.keywords.some((k) => k.toLowerCase().includes(q))
    );
  }

  return result;
}

// ── Markdown export ───────────────────────────────────────────────────────────

function toMarkdown(
  skills: SkillCatalogEntry[],
  usageMap: Map<string, { sessions: number; totalActivations: number; lastUsed: string | null }>
): string {
  const lines = ["# Skill Catalog", "", "| Name | Description | Used | Last Used |", "|-|-|-|-|"];
  for (const s of skills) {
    const u = usageMap.get(s.name);
    const used = u ? "✓" : "—";
    const last = u?.lastUsed ? u.lastUsed.slice(0, 10) : "—";
    const desc = s.description.replace(/\|/g, "\\|").slice(0, 60);
    lines.push(`| \`${s.name}\` | ${desc} | ${used} | ${last} |`);
  }
  return lines.join("\n") + "\n";
}

// ── CSV export ────────────────────────────────────────────────────────────────

function toCsv(
  skills: SkillCatalogEntry[],
  usageMap: Map<string, { sessions: number; totalActivations: number; lastUsed: string | null }>
): string {
  const rows = ["name,description,used,sessions,last_used"];
  for (const s of skills) {
    const u = usageMap.get(s.name);
    const desc = `"${s.description.replace(/"/g, '""').slice(0, 80)}"`;
    rows.push(`${s.name},${desc},${u ? 1 : 0},${u?.sessions ?? 0},${u?.lastUsed ?? ""}`);
  }
  return rows.join("\n") + "\n";
}

// ── Register command ──────────────────────────────────────────────────────────

export function registerSkillsCommand(program: Command): void {
  program
    .command("skills")
    .description("Browse the indexed skill catalog with usage stats")
    .option("--unused", "show only skills never used", false)
    .option("--used", "show only skills that have been used", false)
    .option("--search <query>", "filter by name, description, or keyword")
    .option("--refresh", "re-index catalog from ~/.claude/skills/ first", false)
    .option("--format <fmt>", "output format: text|md|csv|json", "text")
    .action(async (opts: SkillsOptions) => {
      const globals = program.opts<GlobalOptions>();

      if (opts.unused && opts.used) {
        process.stderr.write("Error: --unused and --used are mutually exclusive\n");
        process.exit(1);
      }

      const db = openDb(globals.db);
      runMigrations(db);

      try {
        // Optionally re-index
        if (opts.refresh) {
          const result = indexSkillCatalog(db, undefined, true);
          if (!globals.json && opts.format !== "json") {
            process.stderr.write(
              dim(
                `Indexed ${result.indexed} skills` +
                (result.refreshed > 0 ? `, refreshed ${result.refreshed}` : "") +
                (result.skipped > 0 ? `, skipped ${result.skipped}` : "") +
                "\n"
              )
            );
          }
        } else {
          // Always do a passive index to pick up new skills
          indexSkillCatalog(db);
        }

        const catalog = loadCatalog(db);
        const usageMap = getAggregateSkillUsage(db);
        const filtered = filterSkills(catalog, usageMap, opts);

        // ── Empty catalog ──────────────────────────────────────────────────
        if (catalog.length === 0) {
          if (globals.json || opts.format === "json") {
            emitJson([]);
          } else {
            process.stdout.write(dim("(no skills indexed; run with --refresh)\n"));
          }
          return;
        }

        // ── No results after filter ────────────────────────────────────────
        if (filtered.length === 0) {
          if (globals.json || opts.format === "json") {
            emitJson([]);
          } else {
            process.stdout.write(dim("(no skills match the given filter)\n"));
          }
          return;
        }

        // ── JSON ───────────────────────────────────────────────────────────
        if (globals.json || opts.format === "json") {
          const data = filtered.map((s) => {
            const u = usageMap.get(s.name);
            return {
              name: s.name,
              description: s.description,
              keywords: s.keywords,
              used: !!u,
              sessions: u?.sessions ?? 0,
              lastUsed: u?.lastUsed ?? null,
            };
          });
          emitJson(data);
          return;
        }

        // ── Markdown ───────────────────────────────────────────────────────
        if (opts.format === "md") {
          process.stdout.write(toMarkdown(filtered, usageMap));
          return;
        }

        // ── CSV ────────────────────────────────────────────────────────────
        if (opts.format === "csv") {
          process.stdout.write(toCsv(filtered, usageMap));
          return;
        }

        // ── Text table (default) ───────────────────────────────────────────
        const usedCount = [...catalog].filter((s) => usageMap.has(s.name)).length;
        process.stdout.write(
          bold(`Skills: ${filtered.length}`) +
          dim(` (${usedCount}/${catalog.length} used)`) +
          "\n\n"
        );

        const rows = filtered.map((s) => {
          const u = usageMap.get(s.name);
          const used = u ? green("✓") : dim("—");
          const last = u?.lastUsed ? u.lastUsed.slice(0, 10) : dim("—");
          return {
            name: cyan(s.name),
            description: truncateRight(s.description, 52),
            used,
            lastUsed: last,
          };
        });

        process.stdout.write(
          renderTable(rows, [
            { header: "Name", key: "name", width: 28 },
            { header: "Description", key: "description", width: 52 },
            { header: "Used", key: "used", width: 4 },
            { header: "Last Used", key: "lastUsed", width: 10 },
          ])
        );
      } finally {
        closeDb(db);
      }
    });
}
