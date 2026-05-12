/**
 * Entry point for the interactive TUI review experience.
 *
 * Lazy-loads the ink-based React app so the CLI binary's cold-start path
 * doesn't pay the cost when only --emit / --batch is used.
 *
 * Quit actions:
 *   apply   → call revertHunks() in-process with current decisions
 *   save    → write a review markdown to ./review.md and exit
 *   discard → exit without writing or applying
 */

import { writeFileSync } from "node:fs";
import type { Hunk, HunkDecision } from "./hunk-types.ts";
import { emitReviewMarkdown } from "./markdown-emitter.ts";
import { revertHunks } from "./revert-engine.ts";

export interface InteractiveOptions {
  sessionId: string;
  hunks: Hunk[];
  dryRun: boolean;
  allowDirty: boolean;
  json: boolean;
}

export async function runInteractiveReview(opts: InteractiveOptions): Promise<void> {
  // Refuse to launch TUI in non-TTY context (CI, pipes) — point at --emit.
  if (!process.stdout.isTTY) {
    process.stderr.write(
      "Error: interactive TUI requires a terminal. Use --emit FILE for non-interactive review.\n"
    );
    process.exit(1);
  }

  if (opts.hunks.length === 0) {
    process.stdout.write(`No reviewable hunks in session ${opts.sessionId}.\n`);
    return;
  }

  // Lazy-load ink to keep cold-start fast for --emit / --batch users.
  const [{ render }, { default: React }, { ReviewApp }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./tui/review-app.tsx"),
  ]);

  await new Promise<void>((resolve) => {
    let finalAction: "apply" | "save" | "discard" = "discard";
    let finalDecisions = new Map<string, HunkDecision>();

    const onQuit = (action: "apply" | "save" | "discard", decisions: Map<string, HunkDecision>): void => {
      finalAction = action;
      finalDecisions = decisions;
    };

    const { waitUntilExit } = render(
      React.createElement(ReviewApp, {
        sessionId: opts.sessionId,
        hunks: opts.hunks,
        onQuit,
      })
    );

    waitUntilExit().then(async () => {
      await handleQuitAction(finalAction, finalDecisions, opts);
      resolve();
    });
  });
}

async function handleQuitAction(
  action: "apply" | "save" | "discard",
  decisions: Map<string, HunkDecision>,
  opts: InteractiveOptions
): Promise<void> {
  if (action === "discard") {
    process.stdout.write("Discarded.\n");
    return;
  }

  if (action === "save") {
    const md = emitReviewMarkdown(opts.sessionId, opts.hunks);
    const target = "review.md";
    writeFileSync(target, md, "utf-8");
    process.stdout.write(`Saved → ${target}\n`);
    process.stdout.write(
      `Run: ckforensics review --batch --decisions ${target} --dry-run\n`
    );
    return;
  }

  // action === "apply"
  const summary = await revertHunks(opts.hunks, decisions, {
    dryRun: opts.dryRun,
    allowDirty: opts.allowDirty,
  });
  const applied = summary.results.filter((r) => r.status === "applied").length;
  const refused = summary.results.filter((r) => r.status.startsWith("refused")).length;
  const conflicted = summary.results.filter((r) => r.status === "conflicted").length;
  process.stdout.write(
    `Applied: ${applied}  ·  Refused: ${refused}  ·  Conflicted: ${conflicted}\n`
  );
  if (!summary.allOk) {
    process.stdout.write("Some hunks were not applied. Re-run --emit and inspect.\n");
    process.exit(3);
  }
}
