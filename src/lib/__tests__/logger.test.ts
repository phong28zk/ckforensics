/**
 * Tests for logger.ts
 *
 * Covers:
 *   - Level filtering (error/info/debug thresholds)
 *   - File append (lines written correctly)
 *   - Graceful fallback on unwriteable directory
 *   - Daily rotation (different date → different file)
 *   - Log line format correctness
 *   - Redaction applied to messages
 *   - Performance: 100 writes < 10ms total overhead
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { Logger } from "../logger.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ckf-logger-test-"));
}

function removeDirRecursive(dir: string): void {
  try {
    // Bun exposes rmSync via node:fs compat
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore cleanup errors */ }
}

function readLog(logDir: string, command: string, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const file = join(logDir, `${command}-${yyyy}-${mm}-${dd}.log`);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("Logger — level filtering", () => {
  let tmpDir: string;
  const date = new Date("2026-05-11T12:00:00Z");

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => removeDirRecursive(tmpDir));

  it("level=error: only error lines written", () => {
    const log = new Logger({ command: "test", level: "error", logDir: tmpDir, date });
    log.error("an error");
    log.info("info message");
    log.debug("debug message");
    const content = readLog(tmpDir, "test", date);
    expect(content).toContain("ERROR");
    expect(content).not.toContain("INFO");
    expect(content).not.toContain("DEBUG");
  });

  it("level=info: error and info written, debug dropped", () => {
    const log = new Logger({ command: "test", level: "info", logDir: tmpDir, date });
    log.error("an error");
    log.info("info message");
    log.debug("debug message");
    const content = readLog(tmpDir, "test", date);
    expect(content).toContain("ERROR");
    expect(content).toContain("INFO");
    expect(content).not.toContain("DEBUG");
  });

  it("level=debug: all three levels written", () => {
    const log = new Logger({ command: "test", level: "debug", logDir: tmpDir, date });
    log.error("an error");
    log.info("info message");
    log.debug("debug message");
    const content = readLog(tmpDir, "test", date);
    expect(content).toContain("ERROR");
    expect(content).toContain("INFO");
    expect(content).toContain("DEBUG");
  });
});

describe("Logger — file format", () => {
  let tmpDir: string;
  const date = new Date("2026-05-11T12:00:00Z");

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => removeDirRecursive(tmpDir));

  it("line starts with ISO timestamp", () => {
    const log = new Logger({ command: "ingest", level: "info", logDir: tmpDir, date });
    log.info("started");
    const content = readLog(tmpDir, "ingest", date);
    // ISO 8601 timestamp pattern
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("line contains padded level, command, message", () => {
    const log = new Logger({ command: "ingest", level: "info", logDir: tmpDir, date });
    log.info("started");
    const content = readLog(tmpDir, "ingest", date);
    // INFO padded to 5 chars
    expect(content).toContain("INFO  ingest started");
  });

  it("extra object is JSON-serialised on same line", () => {
    const log = new Logger({ command: "ingest", level: "info", logDir: tmpDir, date });
    log.info("done", { eventsInserted: 42, durationMs: 100 });
    const content = readLog(tmpDir, "ingest", date);
    expect(content).toContain('"eventsInserted":42');
    expect(content).toContain('"durationMs":100');
  });

  it("each call appends a new line", () => {
    const log = new Logger({ command: "ingest", level: "info", logDir: tmpDir, date });
    log.info("first");
    log.info("second");
    log.info("third");
    const lines = readLog(tmpDir, "ingest", date).trim().split("\n");
    expect(lines.length).toBe(3);
  });
});

describe("Logger — daily rotation", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => removeDirRecursive(tmpDir));

  it("different dates produce different log files", () => {
    const d1 = new Date("2026-05-10T10:00:00Z");
    const d2 = new Date("2026-05-11T10:00:00Z");

    const log1 = new Logger({ command: "ingest", level: "info", logDir: tmpDir, date: d1 });
    const log2 = new Logger({ command: "ingest", level: "info", logDir: tmpDir, date: d2 });

    log1.info("day one");
    log2.info("day two");

    const c1 = readLog(tmpDir, "ingest", d1);
    const c2 = readLog(tmpDir, "ingest", d2);

    expect(c1).toContain("day one");
    expect(c2).toContain("day two");
    expect(c1).not.toContain("day two");
    expect(c2).not.toContain("day one");
  });

  it("same day appends to same file across Logger instances", () => {
    const date = new Date("2026-05-11T12:00:00Z");

    const log1 = new Logger({ command: "ingest", level: "info", logDir: tmpDir, date });
    log1.info("first instance");

    const log2 = new Logger({ command: "ingest", level: "info", logDir: tmpDir, date });
    log2.info("second instance");

    const content = readLog(tmpDir, "ingest", date);
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(content).toContain("first instance");
    expect(content).toContain("second instance");
  });
});

describe("Logger — unwriteable directory fallback", () => {
  it("does not throw when log dir is unwriteable", () => {
    // Use a path that definitely cannot be created (null byte in path on Linux)
    // Alternative: use a file as the dir path
    const tmpDir = makeTempDir();
    // Create a file where logger expects a directory
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    const blockerFile = join(tmpDir, "blocked");
    writeFileSync(blockerFile, "I am a file, not a dir");

    // Logger pointing into the file (not a dir) — writes will fail
    const log = new Logger({
      command: "ingest",
      level: "info",
      logDir: blockerFile,  // a file, not a dir
      date: new Date("2026-05-11T00:00:00Z"),
    });

    // Should NOT throw
    expect(() => {
      log.error("this should not crash");
      log.info("neither should this");
    }).not.toThrow();

    removeDirRecursive(tmpDir);
  });

  it("only warns once to stderr even after multiple write failures", () => {
    const tmpDir = makeTempDir();
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    const blockerFile = join(tmpDir, "blocked");
    writeFileSync(blockerFile, "file");

    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // Intercept stderr
    process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
      stderrLines.push(String(chunk));
      return true;
    };

    const log = new Logger({
      command: "ingest",
      level: "debug",
      logDir: blockerFile,
      date: new Date("2026-05-11T00:00:00Z"),
    });

    log.error("msg1");
    log.error("msg2");
    log.error("msg3");

    process.stderr.write = origWrite as typeof process.stderr.write;

    // Should have warned at most once (disabled after first failure)
    const warnLines = stderrLines.filter((l) => l.includes("cannot write to log file"));
    expect(warnLines.length).toBe(1);

    removeDirRecursive(tmpDir);
  });
});

describe("Logger — redaction", () => {
  let tmpDir: string;
  const date = new Date("2026-05-11T12:00:00Z");

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => removeDirRecursive(tmpDir));

  it("redacts Anthropic API keys in log messages", () => {
    const log = new Logger({ command: "test", level: "debug", logDir: tmpDir, date });
    log.debug("key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const content = readLog(tmpDir, "test", date);
    expect(content).not.toContain("sk-ant-api03-");
    expect(content).toContain("[REDACTED:ANT_KEY]");
  });

  it("redacts secrets in extra JSON", () => {
    const log = new Logger({ command: "test", level: "debug", logDir: tmpDir, date });
    log.debug("processing", { token: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    const content = readLog(tmpDir, "test", date);
    expect(content).not.toContain("sk-ant-api03-");
    expect(content).toContain("[REDACTED:ANT_KEY]");
  });
});

describe("Logger — performance", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => removeDirRecursive(tmpDir));

  it("100 info writes complete in < 10ms", () => {
    const log = new Logger({
      command: "perf",
      level: "info",
      logDir: tmpDir,
      date: new Date("2026-05-11T00:00:00Z"),
    });

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      log.info(`message ${i}`, { index: i });
    }
    const elapsed = performance.now() - start;

    // Generous 10ms budget (spec says <5ms overhead; 10ms for test env jitter)
    expect(elapsed).toBeLessThan(10);
  });
});
