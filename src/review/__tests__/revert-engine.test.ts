/**
 * Revert-engine end-to-end tests using real git repos in tmpdir.
 *
 * Covers:
 *   - Clean apply (single & multi-hunk)
 *   - Dry-run never modifies files
 *   - "keep" decisions are no-ops
 *   - Unreviewable hunks skipped
 *   - Dirty file refusal + --allow-dirty override
 *   - Non-git fallback (direct rewrite)
 *   - Drift detection in fallback mode
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revertHunks } from "../revert-engine.ts";
import type { Hunk, HunkDecision } from "../hunk-types.ts";

let repo: string;

async function runGit(args: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.exitCode ?? 0;
}

async function initGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ckforensics-revert-"));
  await runGit(["init", "-q"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "test"], dir);
  return dir;
}

async function commitAll(cwd: string, msg: string): Promise<void> {
  await runGit(["add", "-A"], cwd);
  await runGit(["commit", "-q", "-m", msg], cwd);
}

function h(partial: Partial<Hunk> & { filePath: string; before: string; after: string }): Hunk {
  return {
    id: partial.id ?? `sess:${partial.filePath}:${partial.opIndex ?? 0}`,
    sessionId: "sess",
    opIndex: partial.opIndex ?? 0,
    type: "Edit",
    timestamp: "t",
    unreviewable: false,
    revertKind: "patch",
    ...partial,
  };
}

beforeEach(async () => {
  repo = await initGitRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("revert-engine — clean apply path", () => {
  it("applies a single revert via git apply --reverse", async () => {
    writeFileSync(join(repo, "a.txt"), "AFTER\n");
    await commitAll(repo, "init at after-state");

    const hunk = h({ filePath: "a.txt", before: "BEFORE\n", after: "AFTER\n" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);

    const summary = await revertHunks([hunk], decisions, { cwd: repo });
    expect(summary.allOk).toBe(true);
    expect(summary.results[0]!.status).toBe("applied");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("BEFORE\n");
  });

  it("dry-run never modifies file", async () => {
    writeFileSync(join(repo, "a.txt"), "AFTER\n");
    await commitAll(repo, "init");

    const hunk = h({ filePath: "a.txt", before: "BEFORE\n", after: "AFTER\n" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);

    const summary = await revertHunks([hunk], decisions, { cwd: repo, dryRun: true });
    expect(summary.allOk).toBe(true);
    expect(summary.results[0]!.status).toBe("planned");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("AFTER\n"); // unchanged
  });

  it("'keep' decisions produce skipped-kept (no-op)", async () => {
    const hunk = h({ filePath: "a.txt", before: "x", after: "y" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "keep"]]);
    const summary = await revertHunks([hunk], decisions, { cwd: repo });
    expect(summary.results[0]!.status).toBe("skipped-kept");
    expect(summary.allOk).toBe(true);
  });

  it("unreviewable hunks skipped regardless of decision", async () => {
    const hunk = h({
      filePath: "a.txt",
      before: "",
      after: "new\n",
      unreviewable: true,
      unreviewableReason: "unknown-before",
    });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);
    const summary = await revertHunks([hunk], decisions, { cwd: repo });
    expect(summary.results[0]!.status).toBe("skipped-unreviewable");
  });
});

describe("revert-engine — safety", () => {
  it("refuses revert when target file has uncommitted changes", async () => {
    writeFileSync(join(repo, "a.txt"), "AFTER\n");
    await commitAll(repo, "init");
    // User edits after the session
    writeFileSync(join(repo, "a.txt"), "USER EDIT\nAFTER\n");

    const hunk = h({ filePath: "a.txt", before: "BEFORE\n", after: "AFTER\n" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);

    const summary = await revertHunks([hunk], decisions, { cwd: repo });
    expect(summary.results[0]!.status).toBe("refused-dirty");
    expect(summary.allOk).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("USER EDIT\nAFTER\n");
  });

  it("--allow-dirty overrides the refusal", async () => {
    writeFileSync(join(repo, "a.txt"), "AFTER\n");
    await commitAll(repo, "init");
    writeFileSync(join(repo, "a.txt"), "AFTER\n");
    // Touch without changes — porcelain shows clean. To force dirty:
    writeFileSync(join(repo, "a.txt"), "AFTER\nuser added\n");

    // Patch only targets the AFTER → BEFORE region; user's additional line is appended.
    // With allow-dirty, git apply should still attempt; may conflict due to trailing change.
    const hunk = h({ filePath: "a.txt", before: "BEFORE\n", after: "AFTER\n" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);

    const summary = await revertHunks([hunk], decisions, {
      cwd: repo,
      allowDirty: true,
    });
    // Either applies cleanly (git fuzz) or conflicts — neither should be refused-dirty.
    expect(summary.results[0]!.status).not.toBe("refused-dirty");
  });
});

describe("revert-engine — multi-hunk same-file", () => {
  it("applies sequential edits newest-first", async () => {
    // v1 → v2 → v3 (state after session)
    writeFileSync(join(repo, "a.txt"), "v3\n");
    await commitAll(repo, "init v3");

    const h1 = h({ id: "s:a.txt:0", filePath: "a.txt", opIndex: 0, before: "v1\n", after: "v2\n" });
    const h2 = h({ id: "s:a.txt:1", filePath: "a.txt", opIndex: 1, before: "v2\n", after: "v3\n" });
    const decisions = new Map<string, HunkDecision>([
      [h1.id, "revert"],
      [h2.id, "revert"],
    ]);

    const summary = await revertHunks([h1, h2], decisions, { cwd: repo });
    expect(summary.allOk).toBe(true);
    // After reverting both, file should be back at v1
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
  });
});

describe("revert-engine — Write-new-file delete semantic", () => {
  it("reverting a Write-new hunk deletes the file", async () => {
    writeFileSync(join(repo, "new.txt"), "I was created by Claude\n");
    await commitAll(repo, "init");

    const hunk = h({
      filePath: "new.txt",
      before: "",
      after: "I was created by Claude\n",
      revertKind: "delete",
      type: "Write",
    });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);
    const summary = await revertHunks([hunk], decisions, { cwd: repo, allowDirty: true });
    expect(summary.results[0]!.status).toBe("applied-delete");
    expect(summary.allOk).toBe(true);
    expect(() => readFileSync(join(repo, "new.txt"), "utf8")).toThrow();
  });

  it("dry-run for delete-kind reports planned-delete and does not touch file", async () => {
    writeFileSync(join(repo, "new.txt"), "alive\n");
    await commitAll(repo, "init");

    const hunk = h({
      filePath: "new.txt",
      before: "",
      after: "alive\n",
      revertKind: "delete",
      type: "Write",
    });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);
    const summary = await revertHunks([hunk], decisions, { cwd: repo, dryRun: true, allowDirty: true });
    expect(summary.results[0]!.status).toBe("planned-delete");
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("alive\n");
  });

  it("delete hunk supersedes patch hunks against same file", async () => {
    writeFileSync(join(repo, "new.txt"), "v2\n");
    await commitAll(repo, "init");

    const writeHunk = h({
      id: "s:new.txt:0",
      filePath: "new.txt",
      opIndex: 0,
      type: "Write",
      before: "",
      after: "v1\n",
      revertKind: "delete",
    });
    const editHunk = h({
      id: "s:new.txt:1",
      filePath: "new.txt",
      opIndex: 1,
      type: "Edit",
      before: "v1\n",
      after: "v2\n",
    });
    const decisions = new Map<string, HunkDecision>([
      [writeHunk.id, "revert"],
      [editHunk.id, "revert"],
    ]);
    const summary = await revertHunks([writeHunk, editHunk], decisions, {
      cwd: repo,
      allowDirty: true,
    });
    const statuses = summary.results.map((r) => r.status);
    expect(statuses).toContain("applied-delete");
    expect(statuses).toContain("skipped-superseded");
    expect(() => readFileSync(join(repo, "new.txt"), "utf8")).toThrow();
  });
});

describe("revert-engine — cross-platform line endings", () => {
  it("CRLF target file: revert applies cleanly", async () => {
    writeFileSync(join(repo, "win.txt"), "AFTER\r\n");
    await commitAll(repo, "init crlf");

    const hunk = h({ filePath: "win.txt", before: "BEFORE\r\n", after: "AFTER\r\n" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);
    const summary = await revertHunks([hunk], decisions, { cwd: repo });
    expect(summary.allOk).toBe(true);
    expect(summary.results[0]!.status).toBe("applied");
    // Verify CRLF preserved on disk
    expect(readFileSync(join(repo, "win.txt"), "utf8")).toBe("BEFORE\r\n");
  });
});

describe("revert-engine — encoding safety", () => {
  it("refuses revert on UTF-16 LE file even with --allow-dirty", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("x\0y\0", "binary")]);
    writeFileSync(join(repo, "ucs.txt"), utf16);
    await commitAll(repo, "init utf16");

    const hunk = h({ filePath: "ucs.txt", before: "a", after: "b" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);
    const summary = await revertHunks([hunk], decisions, { cwd: repo, allowDirty: true });
    expect(summary.results[0]!.status).toBe("refused-encoding");
    expect(summary.allOk).toBe(false);
  });
});

describe("revert-engine — non-git fallback", () => {
  it("uses direct rewrite when cwd is not a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ckforensics-nongit-"));
    writeFileSync(join(dir, "a.txt"), "AFTER\n");

    const hunk = h({ filePath: join(dir, "a.txt"), before: "BEFORE\n", after: "AFTER\n" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);

    const summary = await revertHunks([hunk], decisions, { cwd: dir });
    expect(summary.results[0]!.status).toBe("applied");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("BEFORE\n");

    rmSync(dir, { recursive: true, force: true });
  });

  it("non-git fallback detects drift (after-text not found verbatim)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ckforensics-drift-"));
    writeFileSync(join(dir, "a.txt"), "user changed content\n");

    const hunk = h({ filePath: join(dir, "a.txt"), before: "BEFORE\n", after: "AFTER\n" });
    const decisions = new Map<string, HunkDecision>([[hunk.id, "revert"]]);

    // Non-git mode: safety-check hashes file vs hunk.after and refuses on drift.
    const summary = await revertHunks([hunk], decisions, { cwd: dir });
    expect(summary.results[0]!.status).toBe("refused-drift");

    rmSync(dir, { recursive: true, force: true });
  });
});
