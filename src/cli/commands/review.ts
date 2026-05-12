/**
 * CLI command: review [id] [--last] [--emit FILE] [--batch --decisions FILE]
 *
 * Two modes:
 *   --emit FILE   Generate review markdown for a session (no apply).
 *   --batch       Read a filled-in review markdown and apply revert decisions.
 *
 * Without --emit or --batch, launches the interactive TUI (Phase 05 wires it
 * to ink; until then, prints a hint).
 *
 * Exit codes:
 *   0  success / clean apply
 *   1  user error (bad args, no session)
 *   2  internal error
 *   3  partial success (some hunks refused/conflicted)
 *   4  safety refusal (dirty files, no --allow-dirty)
 */

import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { buildManifest } from "../../audit/manifest-builder.ts";
import { latestSessionId } from "../../audit/session-loader.ts";
import { explodeHunks } from "../../review/hunk-builder.ts";
import { hydrateUnknownBefore } from "../../review/hydrate-before.ts";
import { emitReviewMarkdown } from "../../review/markdown-emitter.ts";
import { parseReviewMarkdown, ReviewParseError } from "../../review/markdown-parser.ts";
import { revertHunks } from "../../review/revert-engine.ts";
import { runInteractiveReview } from "../../review/tui-launcher.ts";
import { bold, dim, green, yellow, red, cyan } from "../color.ts";
import { emitRawJson } from "../output-formatter.ts";

interface GlobalOptions { json: boolean; db: string }

interface ReviewOptions {
  last: boolean;
  emit?: string;
  batch: boolean;
  decisions?: string;
  dryRun: boolean;
  allowDirty: boolean;
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review [id]")
    .description("Walk through Claude's edits hunk-by-hunk, accept/reject each")
    .option("--last", "use the most recent session in the DB", false)
    .option("--emit <file>", "emit review markdown to FILE (use - for stdout)")
    .option("--batch", "apply decisions from --decisions FILE (no TUI)", false)
    .option("--decisions <file>", "filled-in review markdown to apply")
    .option("--dry-run", "show what would change, don't modify files", false)
    .option("--allow-dirty", "apply even when target files have uncommitted changes", false)
    .action(async (id: string | undefined, opts: ReviewOptions) => {
      const globals = program.opts<GlobalOptions>();
      const db = openDb(globals.db);
      runMigrations(db);

      try {
        if (opts.batch && opts.emit) {
          process.stderr.write(red("Error: --batch and --emit are mutually exclusive\n"));
          process.exit(1);
        }

        // ── batch mode ─────────────────────────────────────────────────────
        if (opts.batch) {
          if (!opts.decisions) {
            process.stderr.write(red("Error: --batch requires --decisions FILE\n"));
            process.exit(1);
          }
          await runBatch(db, opts, globals);
          return;
        }

        // ── emit / interactive mode (both need a session id) ───────────────
        const sessionId = resolveSessionId(db, id, opts.last);
        const manifest = buildManifest(db, sessionId);
        const hunks = explodeHunks(manifest);
        const hydration = await hydrateUnknownBefore(hunks, process.cwd());
        if (hydration.hydrated > 0) {
          process.stderr.write(
            dim(
              `Hydrated ${hydration.hydrated} unknown-before hunks ` +
                `(${hydration.fromGit} from git HEAD, ${hydration.fromChain} from edit chain)\n`
            )
          );
        }

        if (opts.emit) {
          const md = emitReviewMarkdown(sessionId, hunks);
          if (opts.emit === "-") {
            process.stdout.write(md);
          } else {
            writeFileSync(opts.emit, md, "utf-8");
            process.stderr.write(dim(`Wrote ${hunks.length} hunks → ${opts.emit}\n`));
          }
          return;
        }

        // No --emit / --batch → interactive TUI
        await runInteractiveReview({
          sessionId,
          hunks,
          dryRun: opts.dryRun,
          allowDirty: opts.allowDirty,
          json: globals.json,
        });
      } finally {
        closeDb(db);
      }
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveSessionId(
  db: ReturnType<typeof openDb>,
  id: string | undefined,
  last: boolean
): string {
  if (last) {
    const latest = latestSessionId(db);
    if (!latest) {
      process.stderr.write(red("Error: no sessions in database\n"));
      process.exit(3);
    }
    return latest;
  }
  if (id) return id;
  process.stderr.write(red("Error: provide a session ID or --last\n"));
  process.exit(1);
}

async function runBatch(
  db: ReturnType<typeof openDb>,
  opts: ReviewOptions,
  globals: GlobalOptions
): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(opts.decisions!, "utf-8");
  } catch (e) {
    process.stderr.write(red(`Error reading --decisions file: ${e}\n`));
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseReviewMarkdown(raw);
  } catch (e) {
    if (e instanceof ReviewParseError) {
      process.stderr.write(red(`Error: ${e.message}\n`));
      process.exit(1);
    }
    throw e;
  }

  const manifest = buildManifest(db, parsed.sessionId);
  const hunks = explodeHunks(manifest);
  await hydrateUnknownBefore(hunks, process.cwd());

  const summary = await revertHunks(hunks, parsed.decisions, {
    dryRun: opts.dryRun,
    allowDirty: opts.allowDirty,
  });

  if (globals.json) {
    emitRawJson({
      $schema: "ckforensics-review-v1",
      generatedAt: new Date().toISOString(),
      sessionId: parsed.sessionId,
      dryRun: opts.dryRun,
      results: summary.results,
      allOk: summary.allOk,
    });
  } else {
    renderTextSummary(summary, opts.dryRun);
  }

  // Exit code mapping
  if (summary.allOk) process.exit(0);
  const hasRefused = summary.results.some((r) => r.status.startsWith("refused"));
  const hasConflict = summary.results.some((r) => r.status === "conflicted");
  if (hasRefused) process.exit(4);
  if (hasConflict) process.exit(3);
  process.exit(2);
}

function renderTextSummary(summary: Awaited<ReturnType<typeof revertHunks>>, dryRun: boolean): void {
  const counts: Record<string, number> = {};
  for (const r of summary.results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  const header = dryRun ? cyan(bold("Dry-run results:")) : bold("Apply results:");
  process.stdout.write(header + "\n");

  for (const r of summary.results) {
    const sym = symbolFor(r.status);
    const line = `  ${sym} ${r.filePath}  ${dim(r.hunkId)}${r.detail ? "  " + dim(r.detail) : ""}`;
    process.stdout.write(line + "\n");
  }

  process.stdout.write("\n");
  const parts: string[] = [];
  if (counts["applied"]) parts.push(green(`${counts["applied"]} applied`));
  if (counts["planned"]) parts.push(cyan(`${counts["planned"]} planned`));
  if (counts["skipped-kept"]) parts.push(dim(`${counts["skipped-kept"]} kept`));
  if (counts["skipped-unreviewable"]) parts.push(dim(`${counts["skipped-unreviewable"]} unreviewable`));
  if (counts["refused-dirty"]) parts.push(yellow(`${counts["refused-dirty"]} refused-dirty`));
  if (counts["refused-drift"]) parts.push(yellow(`${counts["refused-drift"]} refused-drift`));
  if (counts["conflicted"]) parts.push(red(`${counts["conflicted"]} conflicted`));
  if (counts["error"]) parts.push(red(`${counts["error"]} error`));

  process.stdout.write(parts.join("  ") + "\n");
}

function symbolFor(status: string): string {
  switch (status) {
    case "applied":
      return green("✔");
    case "planned":
      return cyan("?");
    case "skipped-kept":
      return dim("·");
    case "skipped-unreviewable":
      return dim("·");
    case "refused-dirty":
    case "refused-drift":
    case "refused-missing":
      return yellow("!");
    case "conflicted":
      return red("✖");
    case "error":
      return red("✖");
    default:
      return "?";
  }
}
