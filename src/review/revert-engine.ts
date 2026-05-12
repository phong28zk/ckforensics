/**
 * Revert orchestrator — takes hunks + per-hunk decisions, applies reverts
 * via `git apply --reverse` (preferred) or a direct file rewrite fallback.
 *
 * Pipeline:
 *   1. Filter to hunks where decision === "revert" AND !unreviewable
 *   2. Group by file → run safety check → record per-file refusals
 *   3. Build aggregate patch → `git apply --reverse --check` (dry-run)
 *   4. If dry-run only → stop here, return planned results
 *   5. Otherwise: real `git apply --reverse`. On failure (non-git, or apply error),
 *      fall back to direct content rewrite per file.
 */

import { writeFileSync, readFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Hunk, HunkDecision } from "./hunk-types.ts";
import { buildUnifiedDiff } from "./diff-builder.ts";
import { gitApply, isGitRepo } from "./git-helper.ts";
import { checkSafety } from "./safety-check.ts";
import { detectLineEnding } from "./line-ending-helper.ts";

/** Set of statuses that represent successful (or successfully-planned) outcomes. */
const OK_STATUSES = new Set<RevertStatus>([
  "applied",
  "applied-delete",
  "planned",
  "planned-delete",
  "skipped-kept",
  "skipped-unreviewable",
  "skipped-superseded",
]);

function isOk(r: HunkRevertResult): boolean {
  return OK_STATUSES.has(r.status);
}

/** Convert absolute hunk.filePath to repo-relative path for git apply headers. */
function gitRelativePath(cwd: string, filePath: string): string {
  const absCwd = resolvePath(cwd);
  const absPath = resolvePath(filePath);
  if (absPath.startsWith(absCwd + "/")) return absPath.slice(absCwd.length + 1);
  if (absPath === absCwd) return ".";
  return filePath; // outside cwd — git apply will still fail, but at least we tried
}

export type RevertStatus =
  | "applied"
  | "applied-delete"     // file removed (Write hunk reverted)
  | "planned"            // dry-run only
  | "planned-delete"     // dry-run preview for delete
  | "skipped-kept"       // decision was "keep"
  | "skipped-superseded" // patch hunk skipped because another hunk deletes the file
  | "skipped-unreviewable"
  | "refused-dirty"
  | "refused-drift"
  | "refused-missing"
  | "refused-encoding"
  | "conflicted"
  | "error";

export interface HunkRevertResult {
  hunkId: string;
  filePath: string;
  status: RevertStatus;
  /** Human-readable detail when status indicates a problem. */
  detail?: string;
}

export interface RevertOptions {
  /** Working directory; defaults to process.cwd(). */
  cwd?: string;
  /** Dry-run: never modify files. Default false. */
  dryRun?: boolean;
  /** Override dirty/drift refusal. Default false. */
  allowDirty?: boolean;
}

export interface RevertSummary {
  results: HunkRevertResult[];
  /** True iff every revert decision either applied or was planned successfully. */
  allOk: boolean;
}

/**
 * Apply revert decisions to the working tree.
 *
 * Decisions not present in the map default to "keep".
 */
export async function revertHunks(
  hunks: Hunk[],
  decisions: Map<string, HunkDecision>,
  opts: RevertOptions = {}
): Promise<RevertSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const allowDirty = opts.allowDirty ?? false;

  const results: HunkRevertResult[] = [];

  // Sort hunks by file order then opIndex descending — when reverting multiple
  // hunks in the same file, we apply newest-first so earlier diffs still apply
  // cleanly to the working-tree state.
  const toRevert: Hunk[] = [];
  for (const h of hunks) {
    const d = decisions.get(h.id) ?? "keep";
    if (d === "keep") {
      results.push({ hunkId: h.id, filePath: h.filePath, status: "skipped-kept" });
      continue;
    }
    if (d === "unreviewable" || h.unreviewable) {
      results.push({
        hunkId: h.id,
        filePath: h.filePath,
        status: "skipped-unreviewable",
        detail: h.unreviewableReason,
      });
      continue;
    }
    if (d === "revert") toRevert.push(h);
  }

  if (toRevert.length === 0) {
    return { results, allOk: true };
  }

  // Safety check
  const verdicts = await checkSafety(cwd, toRevert);
  const blocked = new Map<string, HunkRevertResult["status"]>();
  for (const v of verdicts) {
    // Encoding refusal is UNCONDITIONAL — allow-dirty cannot override it
    // because applying a patch to a non-UTF-8 file would corrupt content.
    if (v.verdict.kind === "unsupported-encoding") {
      blocked.set(v.filePath, "refused-encoding");
      continue;
    }
    if (allowDirty) continue;
    if (v.verdict.kind === "dirty") blocked.set(v.filePath, "refused-dirty");
    else if (v.verdict.kind === "drift") blocked.set(v.filePath, "refused-drift");
    else if (v.verdict.kind === "missing") blocked.set(v.filePath, "refused-missing");
  }

  const reviewable: Hunk[] = [];
  for (const h of toRevert) {
    const block = blocked.get(h.filePath);
    if (block) {
      results.push({
        hunkId: h.id,
        filePath: h.filePath,
        status: block,
        detail: "uncommitted user changes — pass --allow-dirty to override",
      });
    } else {
      reviewable.push(h);
    }
  }

  if (reviewable.length === 0) {
    return { results, allOk: false };
  }

  // If any reviewable hunk for a file is revertKind=delete, that file is
  // queued for deletion; patch-kind hunks against the same file are superseded.
  const filesToDelete = new Set<string>();
  for (const h of reviewable) {
    if (h.revertKind === "delete") filesToDelete.add(h.filePath);
  }
  const deleteHunks: Hunk[] = [];
  const patchHunks: Hunk[] = [];
  for (const h of reviewable) {
    if (filesToDelete.has(h.filePath) && h.revertKind === "patch") {
      results.push({
        hunkId: h.id,
        filePath: h.filePath,
        status: "skipped-superseded",
        detail: "file will be deleted by another hunk",
      });
      continue;
    }
    if (h.revertKind === "delete") deleteHunks.push(h);
    else patchHunks.push(h);
  }

  // Handle delete hunks first (independent of patch flow)
  for (const h of deleteHunks) {
    if (dryRun) {
      results.push({ hunkId: h.id, filePath: h.filePath, status: "planned-delete" });
      continue;
    }
    const abs = resolvePath(cwd, h.filePath);
    try {
      if (existsSync(abs)) unlinkSync(abs);
      results.push({ hunkId: h.id, filePath: h.filePath, status: "applied-delete" });
    } catch (e) {
      results.push({
        hunkId: h.id,
        filePath: h.filePath,
        status: "error",
        detail: `delete failed: ${e}`,
      });
    }
  }

  if (patchHunks.length === 0) {
    return { results, allOk: results.every(isOk) };
  }

  const sorted = [...patchHunks].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    return b.opIndex - a.opIndex; // newest-first within a file
  });

  const inGit = await isGitRepo(cwd);

  // Dry-run: validate each hunk's patch individually against current state.
  // We can't truly simulate sequential apply without modifying files, so we
  // check the FIRST hunk (newest) — if it applies, subsequent hunks are
  // plausible. Conservative: report "planned" optimistically, conflicts caught
  // at real-apply time. For a stricter dry-run, user can run --dry-run first
  // and trust the result, or just review the patch text.
  if (dryRun) {
    if (inGit) {
      // Group by file; check newest-first hunk per file
      const byFile = new Map<string, Hunk[]>();
      for (const h of sorted) {
        const arr = byFile.get(h.filePath) ?? [];
        arr.push(h);
        byFile.set(h.filePath, arr);
      }
      let anyConflict = false;
      for (const [, fileHunks] of byFile) {
        const newest = fileHunks[0]!; // already sorted newest-first
        const patch = buildUnifiedDiff(newest, {
          pathOverride: gitRelativePath(cwd, newest.filePath),
          lineEnding: detectLineEnding(resolvePath(cwd, newest.filePath)),
        });
        const r = await gitApply(patch, { cwd, reverse: true, check: true });
        if (!r.ok) {
          anyConflict = true;
          for (const h of fileHunks) {
            results.push({
              hunkId: h.id,
              filePath: h.filePath,
              status: "conflicted",
              detail: r.stderr.trim() || `exit ${r.exitCode}`,
            });
          }
        } else {
          for (const h of fileHunks) {
            results.push({ hunkId: h.id, filePath: h.filePath, status: "planned" });
          }
        }
      }
      const allOk = !anyConflict && results.every(
        (r) => r.status === "skipped-kept" || r.status === "skipped-unreviewable" || r.status === "planned"
      );
      return { results, allOk };
    }
    // Non-git dry-run: just report planned for all (real path uses direct rewrite)
    for (const h of sorted) {
      results.push({ hunkId: h.id, filePath: h.filePath, status: "planned" });
    }
    return { results, allOk: true };
  }

  // Real apply path — apply each hunk individually, newest-first.
  // Sequential apply allows hunk N+1 to see the state produced by hunk N's revert.
  if (inGit) {
    for (const h of sorted) {
      const patch = buildUnifiedDiff(h, {
        pathOverride: gitRelativePath(cwd, h.filePath),
        lineEnding: detectLineEnding(resolvePath(cwd, h.filePath)),
      });
      const r = await gitApply(patch, { cwd, reverse: true });
      if (r.ok) {
        results.push({ hunkId: h.id, filePath: h.filePath, status: "applied" });
      } else {
        // Try fallback rewrite for just this hunk
        const fb = directRewrite([h]);
        results.push(...fb);
      }
    }
    return {
      results,
      allOk: results.every(isOk),
    };
  }

  // Non-git: pure direct rewrite, sequential newest-first per file
  const fallback = directRewrite(sorted);
  for (const r of fallback) results.push(r);

  return {
    results,
    allOk: results.every(
      (r) =>
        r.status === "applied" || r.status === "skipped-kept" || r.status === "skipped-unreviewable"
    ),
  };
}

// ── Direct rewrite fallback ───────────────────────────────────────────────────

/**
 * For each file's hunks (newest-first), read current content, search for `after`,
 * replace with `before`. Atomic write via temp file + rename.
 *
 * Refuses if `after` not found verbatim (drift) — emits "conflicted" status.
 */
function directRewrite(hunks: Hunk[]): HunkRevertResult[] {
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    const arr = byFile.get(h.filePath) ?? [];
    arr.push(h);
    byFile.set(h.filePath, arr);
  }

  const out: HunkRevertResult[] = [];

  for (const [filePath, fileHunks] of byFile) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (e) {
      for (const h of fileHunks) {
        out.push({ hunkId: h.id, filePath, status: "error", detail: `read failed: ${e}` });
      }
      continue;
    }

    let cur = content;
    let allOk = true;
    const perHunkStatus: Array<{ h: Hunk; ok: boolean }> = [];

    for (const h of fileHunks) {
      const idx = cur.indexOf(h.after);
      if (idx === -1) {
        perHunkStatus.push({ h, ok: false });
        allOk = false;
        continue;
      }
      cur = cur.slice(0, idx) + h.before + cur.slice(idx + h.after.length);
      perHunkStatus.push({ h, ok: true });
    }

    if (!allOk) {
      for (const { h, ok } of perHunkStatus) {
        out.push({
          hunkId: h.id,
          filePath,
          status: ok ? "conflicted" : "conflicted",
          detail: "content drift: expected `after` not found verbatim",
        });
      }
      continue;
    }

    // Atomic write
    try {
      const tmp = filePath + ".ckforensics-tmp";
      writeFileSync(tmp, cur, "utf8");
      renameSync(tmp, filePath);
      for (const { h } of perHunkStatus) {
        out.push({ hunkId: h.id, filePath, status: "applied" });
      }
    } catch (e) {
      for (const { h } of perHunkStatus) {
        out.push({ hunkId: h.id, filePath, status: "error", detail: `write failed: ${e}` });
      }
    }
  }

  return out;
}
