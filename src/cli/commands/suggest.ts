/**
 * CLI command: suggest [--session ID|--last|--days N] [--min-confidence N] [--top N]
 *
 * Analyzes session(s) for repeated tool patterns and recommends skills that
 * would have replaced the manual work, with evidence and savings estimates.
 *
 * Exit codes: 0 success (recs or no-recs message), 1 bad args, 2 internal error,
 *             3 session not found.
 *
 * Output formats: text (default, color-coded), --format md, --json.
 */

import type { Command } from "commander";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { latestSessionId, loadSession } from "../../audit/session-loader.ts";
import { indexSkillCatalog, loadCatalog } from "../../recommender/skill-catalog-indexer.ts";
import { detectPatterns } from "../../recommender/pattern-detector.ts";
import { buildRecommendations } from "../../recommender/pattern-skill-matcher.ts";
import { buildSavingsMap } from "../../recommender/savings-estimator.ts";
import { filterDismissed } from "../../recommender/dismissed-recs-store.ts";
import { emitJson } from "../output-formatter.ts";
import { red, dim as dimC, bold as boldC } from "../color.ts";
import { renderTextRec, renderMarkdownRec } from "./suggest-formatters.ts";
import type { Recommendation } from "../../recommender/types.ts";

interface GlobalOptions { json: boolean; db: string }

interface SuggestOptions {
  session?: string;
  last: boolean;
  days?: string;
  minConfidence: string;
  top: string;
  format: string;
}

// ── Session resolution ────────────────────────────────────────────────────────

function resolveSessionIds(
  db: ReturnType<typeof openDb>,
  opts: SuggestOptions
): string[] {
  if (opts.session) return [opts.session];
  if (opts.days) {
    const days = parseInt(opts.days, 10);
    if (isNaN(days) || days < 1) return [];
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    interface Row { id: string }
    const rows = db
      .query<Row, [string]>(
        "SELECT id FROM sessions WHERE started_at >= ? ORDER BY started_at DESC"
      )
      .all(cutoff);
    return rows.map((r) => r.id);
  }
  // --last or default
  const id = latestSessionId(db);
  return id ? [id] : [];
}

// ── Recommendation pipeline ───────────────────────────────────────────────────

function buildRecs(
  db: ReturnType<typeof openDb>,
  sessionIds: string[],
  minConf: number,
  topN: number
): Recommendation[] {
  const catalog = loadCatalog(db);
  const allRecs: Recommendation[] = [];

  for (const sessionId of sessionIds) {
    let sessionData;
    try { sessionData = loadSession(db, sessionId); }
    catch { if (sessionIds.length === 1) throw new Error(`session not found: ${sessionId}`); continue; }

    const model = sessionData.session.model ?? undefined;
    for (const pattern of detectPatterns(sessionData.events)) {
      const savingsMap = buildSavingsMap(catalog.map((c) => c.name), pattern.tokensConsumed, model);
      allRecs.push(...buildRecommendations(pattern, catalog, savingsMap, { minConfidence: minConf, topK: topN }));
    }
  }

  // Deduplicate by skillName (keep highest confidence), filter dismissed, cap
  const deduped = new Map<string, Recommendation>();
  for (const rec of allRecs) {
    const ex = deduped.get(rec.skillName);
    if (!ex || rec.confidence > ex.confidence) deduped.set(rec.skillName, rec);
  }
  return filterDismissed([...deduped.values()])
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, topN);
}

// ── Register command ──────────────────────────────────────────────────────────

export function registerSuggestCommand(program: Command): void {
  program
    .command("suggest")
    .description("Recommend skills based on detected session patterns")
    .option("--session <id>", "analyze specific session by ID")
    .option("--last", "analyze most recent session (default)", false)
    .option("--days <n>", "analyze sessions from the last N days")
    .option("--min-confidence <n>", "minimum confidence threshold (0-100)", "60")
    .option("--top <n>", "max recommendations to show", "3")
    .option("--format <fmt>", "output format: text|md|json", "text")
    .action(async (opts: SuggestOptions) => {
      const globals = program.opts<GlobalOptions>();
      const minConf = parseInt(opts.minConfidence, 10);
      const topN = parseInt(opts.top, 10);

      if (isNaN(minConf) || minConf < 0 || minConf > 100) {
        process.stderr.write(red("Error: --min-confidence must be 0-100\n"));
        process.exit(1);
      }
      if (isNaN(topN) || topN < 1) {
        process.stderr.write(red("Error: --top must be a positive integer\n"));
        process.exit(1);
      }

      const db = openDb(globals.db);
      runMigrations(db);

      try {
        indexSkillCatalog(db); // no-op if up to date

        const sessionIds = resolveSessionIds(db, opts);
        if (sessionIds.length === 0) {
          globals.json || opts.format === "json" ? emitJson([]) : process.stdout.write(dimC("(no sessions found)\n"));
          process.exit(3);
        }

        let ranked: Recommendation[];
        try {
          ranked = buildRecs(db, sessionIds, minConf, topN);
        } catch (err) {
          process.stderr.write(red(`Error: ${String(err)}\n`));
          process.exit(3);
        }

        if (globals.json || opts.format === "json") { emitJson(ranked); return; }

        if (ranked.length === 0) { process.stdout.write(dimC("(no recommendations)\n")); return; }

        if (opts.format === "md") {
          process.stdout.write("# Skill Recommendations\n\n");
          ranked.forEach((rec, i) => process.stdout.write(renderMarkdownRec(rec, i + 1) + "\n\n"));
          return;
        }

        // Default: text
        process.stdout.write(boldC("Skill Recommendations\n") + dimC("─".repeat(40)) + "\n\n");
        ranked.forEach((rec, i) => process.stdout.write(renderTextRec(rec, i + 1) + "\n\n"));
      } finally {
        closeDb(db);
      }
    });
}
