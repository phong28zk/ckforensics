/**
 * CLI command: map — Context Map (X-ray) for Claude Code sessions.
 *
 * Sub-commands / modes:
 *   ckforensics map [--session ID|--last]              heatmap
 *   ckforensics map --simulate-compact [--target-pct N] compaction preview
 *   ckforensics map --save NAME [--session ID]          persist snapshot
 *   ckforensics map list [--session ID]                 list saved snapshots
 *   ckforensics map diff <A> <B>                        compare two snapshots
 *   ckforensics map --pin ID... --emit-manifest [FILE]  keep-manifest
 *
 * Common flags: --json, --format md, --no-color, --top N (default 20)
 *
 * ACCURACY NOTE: token attribution carries a ±20% margin (heuristic).
 */

import type { Command } from "commander";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { loadSession, latestSessionId } from "../../audit/session-loader.ts";
import { buildSnapshot } from "../../context-map/context-snapshot-builder.ts";
import { fillTokenAttribution } from "../../context-map/token-attribution.ts";
import { simulateCompaction } from "../../context-map/compaction-simulator.ts";
import {
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
} from "../../context-map/snapshot-store.ts";
import { diff } from "../../context-map/snapshot-differ.ts";
import { emitManifest } from "../../context-map/manifest-emitter.ts";
import { emitJson, renderTable, truncateRight } from "../output-formatter.ts";
import { bold, dim, green, yellow, red } from "../color.ts";
import {
  buildHeatmapRows,
  renderHeatmap,
  itemCategory,
  itemPreview,
  itemSummary,
} from "./map-renderers.ts";
import type { Database } from "bun:sqlite";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GlobalOptions {
  json: boolean;
  db: string;
}

interface MapOptions {
  session?: string;
  last: boolean;
  simulateCompact: boolean;
  targetPct: number;
  save?: string;
  pin: string[];
  emitManifest?: string | boolean;
  top: number;
  format: string;
  out?: string;
}

// ── Session resolution ────────────────────────────────────────────────────────

function resolveSessionId(
  db: Database,
  opts: MapOptions,
  _globals: GlobalOptions
): string {
  if (opts.session) return opts.session;
  const id = latestSessionId(db);
  if (!id) {
    process.stderr.write("Error: no sessions found. Use --session ID or ingest first.\n");
    process.exit(3);
  }
  return id;
}

// ── Build snapshot helper ─────────────────────────────────────────────────────

function buildLiveSnapshot(db: Database, sessionId: string) {
  const { session, events } = loadSession(db, sessionId);
  const snapshot = buildSnapshot(events, {
    sessionId: session.id,
    createdAt: new Date().toISOString(),
  });
  fillTokenAttribution(snapshot, events);
  return snapshot;
}

// ── Subcommand: list ──────────────────────────────────────────────────────────

function runList(
  db: Database,
  sessionId: string | undefined,
  globals: GlobalOptions
): void {
  const snaps = listSnapshots(db, sessionId);

  if (snaps.length === 0) {
    process.stdout.write(dim("(no snapshots saved)\n"));
    return;
  }

  if (globals.json) {
    emitJson(snaps);
    return;
  }

  const rows = snaps.map((s) => ({
    id: truncateRight(s.id, 24),
    name: s.name ?? dim("—"),
    session: truncateRight(s.sessionId, 20),
    tokens: s.totalTokens.toLocaleString(),
    items: String(s.itemCount),
    created: s.createdAt.slice(0, 19).replace("T", " "),
  }));

  process.stdout.write(bold(`Snapshots: ${snaps.length}\n\n`));
  process.stdout.write(
    renderTable(rows, [
      { header: "ID", key: "id", width: 24 },
      { header: "Name", key: "name", width: 16 },
      { header: "Session", key: "session", width: 20 },
      { header: "Tokens", key: "tokens", width: 10, align: "right" },
      { header: "Items", key: "items", width: 6, align: "right" },
      { header: "Created", key: "created", width: 19 },
    ])
  );
}

// ── Subcommand: diff ──────────────────────────────────────────────────────────

function runDiff(db: Database, idA: string, idB: string, globals: GlobalOptions): void {
  const snapA = loadSnapshot(db, idA);
  const snapB = loadSnapshot(db, idB);
  const result = diff(snapA, snapB);

  if (result.crossSessionWarning) {
    process.stderr.write(yellow("Warning: " + result.crossSessionWarning + "\n"));
  }

  if (globals.json) {
    emitJson(result);
    return;
  }

  process.stdout.write(bold(`Diff: ${idA.slice(0, 12)}… → ${idB.slice(0, 12)}…\n\n`));
  process.stdout.write(
    `Net token delta: ${result.netTokenDelta >= 0 ? green("+" + result.netTokenDelta) : red(String(result.netTokenDelta))}\n`
  );
  process.stdout.write(`Added items:   ${green(String(result.addedItems.length))}\n`);
  process.stdout.write(`Dropped items: ${red(String(result.droppedItems.length))}\n\n`);

  if (result.categoryDeltas.length > 0) {
    process.stdout.write(bold("Category deltas:\n"));
    for (const cd of result.categoryDeltas.slice(0, 10)) {
      const sign = cd.delta >= 0 ? green(`+${cd.delta}`) : red(String(cd.delta));
      process.stdout.write(`  ${truncateRight(cd.category, 24).padEnd(24)}  ${sign} tokens\n`);
    }
  }
}

// ── Register command ──────────────────────────────────────────────────────────

export function registerMapCommand(program: Command): void {
  const cmd = program
    .command("map")
    .description(
      "Context map: visualize what occupies the current context window.\n" +
      "Sub-commands: list, diff <A> <B>\n" +
      "Token attribution carries a ±20% margin (heuristic)."
    )
    .option("--session <id>", "session ID to inspect")
    .option("--last", "use the most recently ingested session", false)
    .option("--simulate-compact", "preview which items next auto-compact would drop", false)
    .option("--target-pct <n>", "target window occupancy % for simulation (default 50)", "50")
    .option("--save <name>", "persist current snapshot under NAME")
    .option("--pin <id>", "mark item ID as must-keep (repeatable)", collectList, [])
    .option("--emit-manifest [file]", "emit paste-ready markdown for pinned items")
    .option("--top <n>", "cap heatmap rows (default 20)", "20")
    .option("--format <fmt>", "output format: text|json", "text")
    .option("--out <file>", "write manifest to file");

  // Sub-command: list
  cmd
    .command("list")
    .description("List saved snapshots")
    .option("--session <id>", "filter by session ID")
    .action((listOpts: { session?: string }) => {
      const globals = program.opts<GlobalOptions>();
      const db = openDb(globals.db);
      runMigrations(db);
      try { runList(db, listOpts.session, globals); }
      finally { closeDb(db); }
    });

  // Sub-command: diff
  cmd
    .command("diff <snapshotA> <snapshotB>")
    .description("Show net token movement between two saved snapshots")
    .action((idA: string, idB: string) => {
      const globals = program.opts<GlobalOptions>();
      const db = openDb(globals.db);
      runMigrations(db);
      try { runDiff(db, idA, idB, globals); }
      finally { closeDb(db); }
    });

  // Main action
  cmd.action(async (opts: MapOptions) => {
    const globals = program.opts<GlobalOptions>();
    const topN = Math.max(1, parseInt(String(opts.top), 10) || 20);
    const targetPct = Math.max(1, Math.min(99, parseInt(String(opts.targetPct), 10) || 50));

    const db = openDb(globals.db);
    runMigrations(db);

    try {
      // ── Pin + manifest mode ───────────────────────────────────────────────
      if (opts.pin?.length > 0 && opts.emitManifest !== undefined) {
        const snapshot = buildLiveSnapshot(db, resolveSessionId(db, opts, globals));
        const pinned = snapshot.items.filter((it) => opts.pin.includes(it.id));
        if (pinned.length === 0) {
          process.stderr.write("Warning: no items matched the given --pin IDs\n");
        }
        const outFile = typeof opts.emitManifest === "string" ? opts.emitManifest : opts.out;
        const manifest = emitManifest(pinned, { outFile, redact: true });
        if (!outFile) process.stdout.write(manifest);
        else process.stdout.write(dim(`Manifest written to ${outFile}\n`));
        return;
      }

      // ── Save mode ─────────────────────────────────────────────────────────
      if (opts.save) {
        const snapshot = buildLiveSnapshot(db, resolveSessionId(db, opts, globals));
        const id = saveSnapshot(db, snapshot, opts.save);
        if (globals.json) {
          emitJson({ saved: id, name: opts.save, totalTokens: snapshot.totalTokens });
        } else {
          process.stdout.write(green("Snapshot saved: ") + id + dim(` (name: ${opts.save})\n`));
        }
        return;
      }

      // ── Simulate-compact mode ─────────────────────────────────────────────
      if (opts.simulateCompact) {
        const snapshot = buildLiveSnapshot(db, resolveSessionId(db, opts, globals));
        const result = simulateCompaction(snapshot.items, { targetPct });

        if (globals.json) {
          emitJson({
            simulatorVersion: result.simulatorVersion,
            targetPct: result.targetPct,
            contextWindowTokens: result.contextWindowTokens,
            keptCount: result.kept.length,
            keptTokens: result.keptTokens,
            droppedCount: result.dropped.length,
            droppedTokens: result.droppedTokens,
            keptItems: result.kept.map(itemSummary),
            droppedItems: result.dropped.map(itemSummary),
          });
          return;
        }

        process.stdout.write(
          bold(`Compaction simulation (simulator: ${result.simulatorVersion})\n`) +
          dim(`Target: ${result.targetPct}% of ${result.contextWindowTokens.toLocaleString()} tokens\n\n`)
        );
        process.stdout.write(green(`Kept:    ${result.kept.length} items  ${result.keptTokens.toLocaleString()} tokens\n`));
        process.stdout.write(red(`Dropped: ${result.dropped.length} items  ${result.droppedTokens.toLocaleString()} tokens\n\n`));

        if (result.dropped.length > 0) {
          process.stdout.write(bold("Top dropped items (oldest first):\n"));
          const rows = result.dropped.slice(0, topN).map((it) => ({
            id: truncateRight(it.id, 24),
            category: itemCategory(it),
            tokens: it.tokens.toLocaleString(),
            turn: String(it.turnIndex),
            preview: truncateRight(itemPreview(it), 40),
          }));
          process.stdout.write(
            renderTable(rows, [
              { header: "ID", key: "id", width: 24 },
              { header: "Category", key: "category", width: 18 },
              { header: "Tokens", key: "tokens", width: 10, align: "right" },
              { header: "Turn", key: "turn", width: 5, align: "right" },
              { header: "Preview", key: "preview", width: 40 },
            ])
          );
        }
        process.stdout.write(dim("\n(±20% attribution margin — heuristic)\n"));
        return;
      }

      // ── Default: heatmap mode ─────────────────────────────────────────────
      const sessionId = resolveSessionId(db, opts, globals);
      const snapshot = buildLiveSnapshot(db, sessionId);

      if (globals.json || opts.format === "json") {
        emitJson({
          sessionId: snapshot.sessionId,
          totalTokens: snapshot.totalTokens,
          itemCount: snapshot.items.length,
          items: snapshot.items.slice(0, topN),
          attributionNote: "±20% margin (heuristic)",
        });
        return;
      }

      const heatmapRows = buildHeatmapRows(snapshot.items, topN);
      process.stdout.write(
        bold("Context Map  ") + dim(`session: ${truncateRight(sessionId, 20)}`) + "\n\n"
      );
      process.stdout.write(renderHeatmap(heatmapRows, snapshot.totalTokens));

      if (snapshot.items.length > topN) {
        process.stdout.write(
          dim(`\n(showing top ${topN} of ${snapshot.items.length} items — use --top N to see more)\n`)
        );
      }
    } finally {
      closeDb(db);
    }
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function collectList(val: string, prev: string[]): string[] {
  return [...prev, val];
}
