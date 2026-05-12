/**
 * Tests for diff-builder — verify unified diff output is parseable by `git apply --check`.
 *
 * Uses Bun.spawn to invoke real `git apply --check` against a temp repo, so the
 * generated patch must be byte-for-byte correct (headers, line counts, trailing NL marker).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnifiedDiff, buildPatch } from "../diff-builder.ts";
import type { Hunk } from "../hunk-types.ts";

let tmpRepo: string;

beforeAll(async () => {
  tmpRepo = mkdtempSync(join(tmpdir(), "ckforensics-diff-"));
  await runGit(["init", "-q"], tmpRepo);
  await runGit(["config", "user.email", "test@example.com"], tmpRepo);
  await runGit(["config", "user.name", "test"], tmpRepo);
  await runGit(["config", "core.autocrlf", "false"], tmpRepo);
});

afterAll(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

function makeHunk(partial: Partial<Hunk>): Hunk {
  return {
    id: "sess:path:0",
    sessionId: "sess",
    filePath: "file.txt",
    opIndex: 0,
    type: "Edit",
    timestamp: "t1",
    before: "",
    after: "",
    unreviewable: false,
    revertKind: "patch",
    ...partial,
  };
}

async function runGit(args: string[], cwd: string, stdin?: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? 0, stderr, stdout };
}

describe("buildUnifiedDiff", () => {
  it("produces a patch that `git apply --check` accepts (forward)", async () => {
    const hunk = makeHunk({
      filePath: "a.txt",
      before: "line1\nline2\nline3\n",
      after: "line1\nCHANGED\nline3\n",
    });
    // Write the before-state file in temp repo
    writeFileSync(join(tmpRepo, "a.txt"), hunk.before);
    const patch = buildUnifiedDiff(hunk);
    expect(patch).toContain("--- a/a.txt");
    expect(patch).toContain("+++ b/a.txt");
    expect(patch).toContain("-line2");
    expect(patch).toContain("+CHANGED");

    const res = await runGit(["apply", "--check"], tmpRepo, patch);
    expect(res.exitCode).toBe(0);
  });

  it("produces a patch that `git apply --reverse --check` accepts on the after-state", async () => {
    const hunk = makeHunk({
      filePath: "b.txt",
      before: "before\n",
      after: "after\n",
    });
    // Place after-state file: reverse-apply should be able to roll back to before
    writeFileSync(join(tmpRepo, "b.txt"), hunk.after);
    const patch = buildUnifiedDiff(hunk);

    const res = await runGit(["apply", "--reverse", "--check"], tmpRepo, patch);
    expect(res.exitCode).toBe(0);
  });

  it("returns empty string when hunk marked unreviewable identical", () => {
    const hunk = makeHunk({
      before: "same",
      after: "same",
      unreviewable: true,
      unreviewableReason: "identical",
    });
    expect(buildUnifiedDiff(hunk)).toBe("");
  });

  it("normalizes CRLF to LF in diff output", () => {
    const hunk = makeHunk({
      filePath: "c.txt",
      before: "a\r\nb\r\n",
      after: "a\r\nB\r\n",
    });
    const patch = buildUnifiedDiff(hunk);
    expect(patch).not.toContain("\r");
  });

  it("handles multi-line change with default context", () => {
    const hunk = makeHunk({
      filePath: "d.txt",
      before: "1\n2\n3\n4\n5\n6\n7\n",
      after: "1\n2\n3\nFOUR\n5\n6\n7\n",
    });
    const patch = buildUnifiedDiff(hunk);
    expect(patch).toMatch(/@@ -1,7 \+1,7 @@/);
  });
});

describe("buildPatch", () => {
  it("concatenates diffs from multiple hunks, skipping unreviewable", () => {
    const h1 = makeHunk({ filePath: "x.txt", id: "s:x:0", before: "a\n", after: "A\n" });
    const h2 = makeHunk({
      filePath: "y.txt",
      id: "s:y:0",
      before: "skip",
      after: "skip",
      unreviewable: true,
      unreviewableReason: "identical",
    });
    const h3 = makeHunk({ filePath: "z.txt", id: "s:z:0", before: "b\n", after: "B\n" });
    const patch = buildPatch([h1, h2, h3]);
    expect(patch).toContain("a/x.txt");
    expect(patch).not.toContain("y.txt");
    expect(patch).toContain("a/z.txt");
  });

  it("returns empty when all hunks unreviewable", () => {
    const h = makeHunk({ unreviewable: true, unreviewableReason: "unknown-before" });
    expect(buildPatch([h])).toBe("");
  });

  it("multi-file patch parses via git apply --check", async () => {
    // Set up two before-state files
    const subdir = mkdtempSync(join(tmpdir(), "ckforensics-multi-"));
    await runGit(["init", "-q"], subdir);
    await runGit(["config", "user.email", "test@example.com"], subdir);
    await runGit(["config", "user.name", "test"], subdir);
    await runGit(["config", "core.autocrlf", "false"], subdir);
    writeFileSync(join(subdir, "p.txt"), "one\n");
    writeFileSync(join(subdir, "q.txt"), "two\n");

    const hunks: Hunk[] = [
      makeHunk({ filePath: "p.txt", id: "s:p:0", before: "one\n", after: "ONE\n" }),
      makeHunk({ filePath: "q.txt", id: "s:q:0", before: "two\n", after: "TWO\n" }),
    ];
    const patch = buildPatch(hunks);
    const res = await runGit(["apply", "--check"], subdir, patch);
    expect(res.exitCode).toBe(0);

    rmSync(subdir, { recursive: true, force: true });
  });
});
