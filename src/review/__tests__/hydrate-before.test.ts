/**
 * Tests for hydrateUnknownBefore — chain backfill + git HEAD lookup.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrateUnknownBefore } from "../hydrate-before.ts";
import type { Hunk } from "../hunk-types.ts";

let repo: string;

async function runGit(args: string[], cwd: string): Promise<number> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  return p.exitCode ?? 0;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ckforensics-hydrate-"));
  await runGit(["init", "-q"], repo);
  await runGit(["config", "user.email", "t@t"], repo);
  await runGit(["config", "user.name", "t"], repo);
  await runGit(["config", "core.autocrlf", "false"], repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function unknownHunk(partial: Partial<Hunk> & { filePath: string; after: string }): Hunk {
  return {
    id: partial.id ?? `s:${partial.filePath}:${partial.opIndex ?? 0}`,
    sessionId: "s",
    opIndex: partial.opIndex ?? 0,
    type: "Edit",
    timestamp: "t",
    before: "",
    unreviewable: true,
    unreviewableReason: "unknown-before",
    revertKind: "patch",
    ...partial,
  };
}

describe("hydrateUnknownBefore — chain backfill", () => {
  it("fills opIndex>0 hunks from previous hunk's after", async () => {
    const hunks: Hunk[] = [
      unknownHunk({ filePath: "a.txt", opIndex: 0, after: "v1\n" }),
      unknownHunk({ filePath: "a.txt", opIndex: 1, after: "v2\n" }),
      unknownHunk({ filePath: "a.txt", opIndex: 2, after: "v3\n" }),
    ];
    const res = await hydrateUnknownBefore(hunks, repo);
    expect(res.fromChain).toBe(2);
    expect(hunks[1]!.before).toBe("v1\n");
    expect(hunks[1]!.unreviewable).toBe(false);
    expect(hunks[2]!.before).toBe("v2\n");
    expect(hunks[2]!.unreviewable).toBe(false);
  });
});

describe("hydrateUnknownBefore — git HEAD lookup", () => {
  it("fills first hunk's before from committed HEAD content", async () => {
    writeFileSync(join(repo, "a.txt"), "HEAD content\n");
    await runGit(["add", "a.txt"], repo);
    await runGit(["commit", "-q", "-m", "init"], repo);

    const hunks: Hunk[] = [
      unknownHunk({ filePath: "a.txt", opIndex: 0, after: "new content\n" }),
    ];
    const res = await hydrateUnknownBefore(hunks, repo);
    expect(res.fromGit).toBe(1);
    expect(hunks[0]!.before).toBe("HEAD content\n");
    expect(hunks[0]!.unreviewable).toBe(false);
  });

  it("leaves hunk unreviewable when file not in HEAD", async () => {
    // No commit, file doesn't exist in HEAD
    const hunks: Hunk[] = [
      unknownHunk({ filePath: "ghost.txt", opIndex: 0, after: "x\n" }),
    ];
    const res = await hydrateUnknownBefore(hunks, repo);
    expect(res.fromGit).toBe(0);
    expect(hunks[0]!.unreviewable).toBe(true);
  });

  it("non-git repo: no-op for git lookup but chain still works", async () => {
    const nongit = mkdtempSync(join(tmpdir(), "ckforensics-nongit-"));
    const hunks: Hunk[] = [
      unknownHunk({ filePath: "a.txt", opIndex: 0, after: "v1\n" }),
      unknownHunk({ filePath: "a.txt", opIndex: 1, after: "v2\n" }),
    ];
    const res = await hydrateUnknownBefore(hunks, nongit);
    expect(res.fromGit).toBe(0);
    expect(res.fromChain).toBe(1); // hunk[1] gets backfilled from hunk[0].after
    rmSync(nongit, { recursive: true, force: true });
  });

  it("does not touch hunks that are already reviewable", async () => {
    writeFileSync(join(repo, "a.txt"), "HEAD\n");
    await runGit(["add", "a.txt"], repo);
    await runGit(["commit", "-q", "-m", "init"], repo);

    const hunks: Hunk[] = [
      {
        id: "s:a.txt:0",
        sessionId: "s",
        filePath: "a.txt",
        opIndex: 0,
        type: "Edit",
        timestamp: "t",
        before: "explicit before\n",
        after: "after\n",
        unreviewable: false,
        revertKind: "patch",
      },
    ];
    const res = await hydrateUnknownBefore(hunks, repo);
    expect(res.hydrated).toBe(0);
    expect(hunks[0]!.before).toBe("explicit before\n");
  });
});
