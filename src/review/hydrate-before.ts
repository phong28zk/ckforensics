/**
 * Hydrate `unknown-before` hunks by fetching pre-session content from git HEAD.
 *
 * Rationale: many hunks land with `unknownBefore=true` simply because Claude
 * didn't `Read` the file before editing. The pre-session state usually still
 * lives in git HEAD (or the workdir mtime predating the session) — so we can
 * reconstruct `before` and unlock the hunk for review.
 *
 * Strategy:
 *   1. Group hunks by filePath.
 *   2. For the FIRST hunk in each file's chain (lowest opIndex):
 *      - Run `git show HEAD:<rel-path>` to fetch committed content.
 *      - If the file's current `before` is empty (unknown), use HEAD content.
 *   3. For SUBSEQUENT hunks: the previous hunk's `after` IS this hunk's
 *      pre-state (chronological consistency). Backfill from chain.
 *
 * Failure modes — all safe:
 *   - Not in git repo → no-op.
 *   - File not in HEAD (untracked / new) → no-op.
 *   - Path resolution fails → no-op.
 *
 * Note: mutates hunks in place. Returns count of hunks hydrated for reporting.
 */

import { resolve as resolvePath } from "node:path";
import type { Hunk } from "./hunk-types.ts";
import { isGitRepo } from "./git-helper.ts";

export interface HydrateResult {
  hydrated: number;
  fromGit: number;
  fromChain: number;
}

export async function hydrateUnknownBefore(
  hunks: Hunk[],
  cwd: string
): Promise<HydrateResult> {
  const result: HydrateResult = { hydrated: 0, fromGit: 0, fromChain: 0 };

  // Group by file, preserving order within group
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    const arr = byFile.get(h.filePath) ?? [];
    arr.push(h);
    byFile.set(h.filePath, arr);
  }

  const gitAvailable = await isGitRepo(cwd);

  for (const [filePath, fileHunks] of byFile) {
    // Pass 1: chain hydration — previous.after fills next.before
    for (let i = 1; i < fileHunks.length; i++) {
      const prev = fileHunks[i - 1]!;
      const cur = fileHunks[i]!;
      if (cur.unreviewable && cur.unreviewableReason === "unknown-before") {
        cur.before = prev.after;
        cur.unreviewable = false;
        cur.unreviewableReason = undefined;
        result.hydrated++;
        result.fromChain++;
      }
    }

    // Pass 2: first hunk — fetch from git HEAD if needed
    const first = fileHunks[0]!;
    if (
      gitAvailable &&
      first.unreviewable &&
      first.unreviewableReason === "unknown-before" &&
      first.revertKind === "patch"
    ) {
      const rel = relativeToRepo(cwd, filePath);
      const headContent = await gitShowAtHead(cwd, rel);
      if (headContent !== null) {
        first.before = headContent;
        first.unreviewable = false;
        first.unreviewableReason = undefined;
        result.hydrated++;
        result.fromGit++;
      }
    }
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeToRepo(cwd: string, filePath: string): string {
  const absCwd = resolvePath(cwd);
  const absPath = resolvePath(filePath);
  if (absPath.startsWith(absCwd + "/")) return absPath.slice(absCwd.length + 1);
  return filePath;
}

async function gitShowAtHead(cwd: string, relPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "show", `HEAD:${relPath}`], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    return stdout;
  } catch {
    return null;
  }
}
