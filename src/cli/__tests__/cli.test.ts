/**
 * CLI integration tests.
 *
 * Spawns the CLI via Bun.spawn against an in-memory or temp fixture DB.
 * Verifies exit codes, stdout structure, and JSON validity for each subcommand.
 *
 * Strategy: write a seed JSONL fixture to a temp dir, ingest it into a temp DB,
 * then exercise each subcommand. Uses --db flag to target the temp DB.
 *
 * Does NOT touch real user data at ~/.claude/projects/ or the default DB path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, closeDb } from "../../store/db.ts";
import { runMigrations } from "../../store/migration-runner.ts";
import { ingestFile } from "../../store/ingest.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLI = join(import.meta.dir, "../../cli/index.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], dbPath: string): Promise<SpawnResult> {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "--db", dbPath, "--no-color", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  // Surface stderr in CI on non-zero exit so cross-platform failures are debuggable.
  if (exitCode !== 0 && (process.env.CI || process.env.GITHUB_ACTIONS)) {
    console.error(`[runCli exit=${exitCode}] argv=${JSON.stringify(args)}`);
    console.error(`[runCli stderr]\n${stderr}`);
    console.error(`[runCli stdout]\n${stdout}`);
  }
  return { exitCode, stdout, stderr };
}

function makeUserLine(sessionId: string, ts: string, uuid: string): string {
  return JSON.stringify({
    type: "user", uuid, parentUuid: null, isSidechain: false,
    message: { role: "user", content: "hello" },
    timestamp: ts, sessionId, version: "2.0.0",
  });
}

function makeAssistantLine(sessionId: string, ts: string, uuid: string): string {
  return JSON.stringify({
    type: "assistant", uuid, parentUuid: null, isSidechain: false,
    requestId: "req_" + uuid.slice(0, 8),
    message: {
      role: "assistant", model: "claude-sonnet-4",
      id: "msg_" + uuid.slice(0, 8), type: "message",
      content: [], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    timestamp: ts, sessionId, version: "2.0.0",
  });
}

// ── Fixture setup ──────────────────────────────────────────────────────────────

const SESSION_ID = "ffffffff-0000-0000-0000-000000000001";
let tmpDir: string;
let dbPath: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ckf-cli-test-"));
  dbPath = join(tmpDir, "test.db");

  // Build a minimal fixture DB with one session
  const db = openDb(dbPath);
  runMigrations(db);

  const jsonlPath = join(tmpDir, "session.jsonl");
  const lines = [
    makeUserLine(SESSION_ID, "2026-05-01T10:00:00.000Z", "u-001"),
    makeAssistantLine(SESSION_ID, "2026-05-01T10:00:01.000Z", "u-002"),
    makeUserLine(SESSION_ID, "2026-05-01T10:01:00.000Z", "u-003"),
    makeAssistantLine(SESSION_ID, "2026-05-01T10:01:01.000Z", "u-004"),
  ];
  writeFileSync(jsonlPath, lines.join("\n") + "\n", "utf-8");
  await ingestFile(db, jsonlPath, "test-project");
  closeDb(db);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests: --help ─────────────────────────────────────────────────────────────

describe("CLI: --help", () => {
  it("exits 0 and lists all subcommands", async () => {
    const { exitCode, stdout } = await runCli(["--help"], dbPath);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ingest");
    expect(stdout).toContain("summary");
    expect(stdout).toContain("sessions");
    expect(stdout).toContain("audit");
    expect(stdout).toContain("export");
    expect(stdout).toContain("redact");
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("path");
  });
});

// ── Tests: summary ────────────────────────────────────────────────────────────

describe("CLI: summary", () => {
  it("exits 0 and shows session count in text mode", async () => {
    const { exitCode, stdout } = await runCli(["summary", "--days", "365"], dbPath);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Sessions/);
  });

  it("exits 0 and emits valid JSON envelope with --json", async () => {
    const { exitCode, stdout } = await runCli(["summary", "--days", "365", "--json"], dbPath);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-export-v1");
    expect(parsed.data).toHaveProperty("sessionCount");
    expect(typeof parsed.data.sessionCount).toBe("number");
  });

  it("exits 1 when --days is not a number", async () => {
    const { exitCode } = await runCli(["summary", "--days", "abc"], dbPath);
    expect(exitCode).toBe(1);
  });
});

// ── Tests: sessions ───────────────────────────────────────────────────────────

describe("CLI: sessions", () => {
  it("exits 0 and shows session rows in text mode", async () => {
    const { exitCode, stdout } = await runCli(["sessions", "--limit", "10"], dbPath);
    expect(exitCode).toBe(0);
    // shortProject() keeps "test-project" (no leading dash) as-is
    expect(stdout).toContain("test-project");
  });

  it("exits 0 and emits JSON array with --json", async () => {
    const { exitCode, stdout } = await runCli(["sessions", "--json"], dbPath);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-export-v1");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data.length).toBeGreaterThan(0);
    expect(parsed.data[0]).toHaveProperty("id");
  });

  it("exits 0 and emits CSV with --format csv", async () => {
    const { exitCode, stdout } = await runCli(["sessions", "--format", "csv"], dbPath);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Session ID");
    expect(stdout).toContain("Project");
  });
});

// ── Tests: audit ─────────────────────────────────────────────────────────────

describe("CLI: audit", () => {
  it("exits 0 with --last and outputs markdown", async () => {
    const { exitCode, stdout } = await runCli(["audit", "--last"], dbPath);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Session Change Manifest");
  });

  it("exits 0 with explicit session ID in JSON format", async () => {
    const { exitCode, stdout } = await runCli(
      ["audit", SESSION_ID, "--format", "json"],
      dbPath
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-export-v1");
    expect(parsed.data).toHaveProperty("session");
    expect(parsed.data.session.id).toBe(SESSION_ID);
  });

  it("exits 3 for unknown session ID", async () => {
    const { exitCode } = await runCli(
      ["audit", "00000000-0000-0000-0000-000000000000"],
      dbPath
    );
    expect(exitCode).toBe(3);
  });

  it("exits 1 when neither ID nor --last given", async () => {
    const { exitCode } = await runCli(["audit"], dbPath);
    expect(exitCode).toBe(1);
  });
});

// ── Tests: export ─────────────────────────────────────────────────────────────

describe("CLI: export", () => {
  it("export summary --format json emits valid envelope", async () => {
    const { exitCode, stdout } = await runCli(
      ["export", "summary", "--format", "json", "--days", "365"],
      dbPath
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-export-v1");
    expect(parsed.data).toHaveProperty("sessionCount");
  });

  it("export sessions --format csv emits CSV with headers", async () => {
    const { exitCode, stdout } = await runCli(
      ["export", "sessions", "--format", "csv"],
      dbPath
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Session ID");
  });

  it("export audit --last --format json emits valid envelope", async () => {
    const { exitCode, stdout } = await runCli(
      ["export", "audit", "--last", "--format", "json"],
      dbPath
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-export-v1");
    expect(parsed.data).toHaveProperty("session");
  });

  it("exits 1 for unknown view name", async () => {
    const { exitCode } = await runCli(["export", "unknown"], dbPath);
    expect(exitCode).toBe(1);
  });
});

// ── Tests: doctor ─────────────────────────────────────────────────────────────

describe("CLI: doctor", () => {
  it("exits 0 and shows Bun version", async () => {
    const { exitCode, stdout } = await runCli(["doctor"], dbPath);
    // May exit 1 if JSONL dir missing — just check output shape
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toContain("Bun version");
  });

  it("emits valid JSON with --json", async () => {
    const { exitCode, stdout } = await runCli(["doctor", "--json"], dbPath);
    expect([0, 1]).toContain(exitCode);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-export-v1");
    expect(parsed.data).toHaveProperty("checks");
    expect(Array.isArray(parsed.data.checks)).toBe(true);
  });
});

// ── Tests: path ───────────────────────────────────────────────────────────────

describe("CLI: path", () => {
  it("exits 0 and shows DB path", async () => {
    const { exitCode, stdout } = await runCli(["path"], dbPath);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("DB");
    expect(stdout).toContain(dbPath);
  });

  it("emits valid JSON with --json", async () => {
    const { exitCode, stdout } = await runCli(["path", "--json"], dbPath);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-export-v1");
    expect(parsed.data).toHaveProperty("db");
  });
});

// ── Tests: cache ──────────────────────────────────────────────────────────────

describe("CLI: cache", () => {
  it("exits 0 on populated DB with --days 365", async () => {
    const { exitCode, stdout } = await runCli(["cache", "--days", "365"], dbPath);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Cache Performance");
  });

  it("--json emits valid envelope with $schema ckforensics-cache-v1", async () => {
    const { exitCode, stdout } = await runCli(["cache", "--days", "365", "--json"], dbPath);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-cache-v1");
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("data");
    expect(parsed.data).toHaveProperty("totalCacheRead");
    expect(parsed.data).toHaveProperty("cacheHitRatio");
    expect(parsed.data).toHaveProperty("estimatedSavingsUsd");
    expect(Array.isArray(parsed.data.bySession)).toBe(true);
  });

  it("--days 0 returns empty data with exit 0", async () => {
    const { exitCode, stdout } = await runCli(["cache", "--days", "0", "--json"], dbPath);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toBe("ckforensics-cache-v1");
    // With 0 days, no sessions fall in window
    expect(parsed.data.totalCacheRead).toBe(0);
    expect(parsed.data.bySession).toHaveLength(0);
  });

  it("--format md emits markdown table", async () => {
    const { exitCode, stdout } = await runCli(["cache", "--days", "365", "--format", "md"], dbPath);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("## Cache Performance");
    expect(stdout).toContain("| Metric |");
  });

  it("exits 1 for invalid --days argument", async () => {
    const { exitCode } = await runCli(["cache", "--days", "abc"], dbPath);
    expect(exitCode).toBe(1);
  });

  it("--last exits 0 even when session has no cache data", async () => {
    const { exitCode } = await runCli(["cache", "--last"], dbPath);
    expect(exitCode).toBe(0);
  });
});
