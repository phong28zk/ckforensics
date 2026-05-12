/**
 * Safety checks that run BEFORE any revert is applied.
 *
 * Goals:
 *   - Refuse to revert when the target file has uncommitted user changes
 *     (committed during/after Claude's session) — we'd be silently undoing
 *     work the user wants to keep.
 *   - In non-git mode, fall back to a content-hash drift check.
 */

import { statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type { Hunk } from "./hunk-types.ts";
import { isGitRepo, getStatusPorcelain } from "./git-helper.ts";
import { detectEncoding } from "./encoding-helper.ts";

export type SafetyVerdict =
  | { kind: "clean" }
  | { kind: "dirty"; code: string }   // git porcelain code
  | { kind: "drift"; expectedHash: string; actualHash: string }
  | { kind: "missing" }
  | { kind: "unsupported-encoding"; encoding: string };

export interface FileVerdict {
  filePath: string;
  verdict: SafetyVerdict;
}

/**
 * Inspect each unique file referenced by hunks; return per-file verdict.
 *
 * @param cwd  Working directory (typically session.cwd or `process.cwd()`).
 * @param hunks Hunks to be reverted. Only their filePath is consulted.
 */
export async function checkSafety(
  cwd: string,
  hunks: Hunk[]
): Promise<FileVerdict[]> {
  const uniquePaths = [...new Set(hunks.map((h) => h.filePath))];
  if (uniquePaths.length === 0) return [];

  // Encoding gate — runs regardless of git/non-git. Refuses on non-UTF-8 BOM
  // to avoid corrupting files in legacy encodings.
  const encodingVerdicts = checkEncodings(cwd, uniquePaths);
  const encodingBlocked = new Map(
    encodingVerdicts
      .filter((v) => v.verdict.kind === "unsupported-encoding")
      .map((v) => [v.filePath, v.verdict])
  );

  const innerVerdicts = (await isGitRepo(cwd))
    ? await checkGit(cwd, uniquePaths)
    : checkNonGit(uniquePaths, hunks);

  // Encoding refusal supersedes dirty/drift (it's a harder block).
  return innerVerdicts.map((v) => {
    const enc = encodingBlocked.get(v.filePath);
    return enc ? { filePath: v.filePath, verdict: enc } : v;
  });
}

/** Per-file encoding check via BOM sniff. Resolves relative paths against cwd. */
function checkEncodings(cwd: string, paths: string[]): FileVerdict[] {
  return paths.map((filePath) => {
    const abs = resolvePath(cwd, filePath);
    const info = detectEncoding(abs);
    if (info.supported) return { filePath, verdict: { kind: "clean" as const } };
    return {
      filePath,
      verdict: { kind: "unsupported-encoding" as const, encoding: info.encoding },
    };
  });
}

// ── Git-backed check ──────────────────────────────────────────────────────────

async function checkGit(cwd: string, paths: string[]): Promise<FileVerdict[]> {
  const status = await getStatusPorcelain(cwd, paths.map((p) => relativeIfPossible(cwd, p)));
  return paths.map((filePath) => {
    const rel = relativeIfPossible(cwd, filePath);
    const code = status.get(rel) ?? status.get(filePath);
    if (!code) return { filePath, verdict: { kind: "clean" } };
    // "??" means untracked. A revert that targets an untracked file is a user
    // setup issue; treat as dirty so user opts in via --allow-dirty.
    return { filePath, verdict: { kind: "dirty", code } };
  });
}

// ── Non-git fallback ──────────────────────────────────────────────────────────

/**
 * Hash the current file content against the expected `after` of the LAST hunk
 * touching that file. Mismatch → drift (user edited post-session).
 */
function checkNonGit(paths: string[], hunks: Hunk[]): FileVerdict[] {
  return paths.map((filePath) => {
    const last = lastHunkForPath(filePath, hunks);
    if (!last) return { filePath, verdict: { kind: "clean" } };

    let actual: string;
    try {
      statSync(filePath);
      actual = readFileSync(filePath, "utf8");
    } catch {
      return { filePath, verdict: { kind: "missing" } };
    }

    const expectedHash = sha1(last.after);
    const actualHash = sha1(actual);
    if (expectedHash === actualHash) return { filePath, verdict: { kind: "clean" } };
    return { filePath, verdict: { kind: "drift", expectedHash, actualHash } };
  });
}

function lastHunkForPath(filePath: string, hunks: Hunk[]): Hunk | undefined {
  let result: Hunk | undefined;
  for (const h of hunks) {
    if (h.filePath === filePath) result = h;
  }
  return result;
}

function sha1(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

function relativeIfPossible(cwd: string, filePath: string): string {
  const absCwd = resolvePath(cwd);
  const absPath = resolvePath(filePath);
  if (absPath.startsWith(absCwd + "/") || absPath === absCwd) {
    return absPath.slice(absCwd.length + 1);
  }
  return filePath;
}
