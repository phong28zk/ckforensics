/**
 * Tests for log-path-resolver.ts
 *
 * Mirrors the pattern of store/__tests__/ingest.test.ts — uses PlatformEnv
 * mocks to verify cross-platform path resolution without touching the real FS.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveLogDir,
  resolveLogFile,
  type PlatformEnv,
} from "../log-path-resolver.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function linuxEnv(overrides: Partial<Record<string, string>> = {}): PlatformEnv {
  return {
    platform: "linux",
    env: { HOME: "/home/alice", ...overrides },
    home: "/home/alice",
  };
}

function macEnv(): PlatformEnv {
  return {
    platform: "darwin",
    env: { HOME: "/Users/alice" },
    home: "/Users/alice",
  };
}

function winEnv(overrides: Partial<Record<string, string>> = {}): PlatformEnv {
  return {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\alice", ...overrides },
    home: "C:\\Users\\alice",
  };
}

// Win32 path.join produces backslashes; normalise both sides for POSIX-flavoured
// fixture paths so test passes on both Linux and Windows CI runners.
const norm = (s: string): string => s.replace(/\\/g, "/");

// ── resolveLogDir ─────────────────────────────────────────────────────────────

describe("resolveLogDir — Linux", () => {
  it("uses XDG_STATE_HOME when set", () => {
    const dir = resolveLogDir(linuxEnv({ XDG_STATE_HOME: "/custom/state" }));
    expect(norm(dir)).toBe("/custom/state/ckforensics/logs");
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is absent", () => {
    const dir = resolveLogDir(linuxEnv());
    expect(norm(dir)).toBe("/home/alice/.local/state/ckforensics/logs");
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is empty string", () => {
    const dir = resolveLogDir(linuxEnv({ XDG_STATE_HOME: "" }));
    expect(norm(dir)).toBe("/home/alice/.local/state/ckforensics/logs");
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is whitespace", () => {
    const dir = resolveLogDir(linuxEnv({ XDG_STATE_HOME: "   " }));
    expect(norm(dir)).toBe("/home/alice/.local/state/ckforensics/logs");
  });
});

describe("resolveLogDir — macOS", () => {
  it("returns ~/Library/Logs/ckforensics", () => {
    const dir = resolveLogDir(macEnv());
    expect(norm(dir)).toBe("/Users/alice/Library/Logs/ckforensics");
  });

  it("ignores XDG_STATE_HOME on macOS", () => {
    const env: PlatformEnv = { ...macEnv(), env: { XDG_STATE_HOME: "/custom" } };
    const dir = resolveLogDir(env);
    expect(norm(dir)).toBe("/Users/alice/Library/Logs/ckforensics");
  });
});

describe("resolveLogDir — Windows", () => {
  it("uses LOCALAPPDATA when set", () => {
    const dir = resolveLogDir(winEnv({ LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }));
    expect(dir).toBe(join("C:\\Users\\alice\\AppData\\Local", "ckforensics", "Logs"));
  });

  it("falls back to home/AppData/Local when LOCALAPPDATA is absent", () => {
    const dir = resolveLogDir(winEnv());
    expect(dir).toBe(join("C:\\Users\\alice", "AppData", "Local", "ckforensics", "Logs"));
  });
});

// ── resolveLogFile ────────────────────────────────────────────────────────────

describe("resolveLogFile", () => {
  let tmpDir: string;

  // Create a real temp dir so mkdir=true can succeed
  function withTmpDir(fn: (dir: string) => void) {
    const d = mkdtempSync(join(tmpdir(), "ckf-log-test-"));
    try {
      fn(d);
    } finally {
      try {
        const { rmSync } = require("node:fs") as typeof import("node:fs");
        rmSync(d, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  it("produces correct filename for a given date", () => {
    withTmpDir((d) => {
      const env: PlatformEnv = {
        platform: "linux",
        env: { XDG_STATE_HOME: d },
        home: d,
      };
      const date = new Date("2026-05-11T10:00:00Z");
      const file = resolveLogFile("ingest", date, env, true);
      expect(file).toMatch(/ingest-2026-05-11\.log$/);
    });
  });

  it("different dates produce different file names (rotation)", () => {
    withTmpDir((d) => {
      const env: PlatformEnv = {
        platform: "linux",
        env: { XDG_STATE_HOME: d },
        home: d,
      };
      const d1 = resolveLogFile("ingest", new Date("2026-05-10T00:00:00Z"), env, true);
      const d2 = resolveLogFile("ingest", new Date("2026-05-11T00:00:00Z"), env, true);
      expect(d1).not.toBe(d2);
      expect(d1).toMatch(/ingest-2026-05-10\.log$/);
      expect(d2).toMatch(/ingest-2026-05-11\.log$/);
    });
  });

  it("different commands produce different file names", () => {
    withTmpDir((d) => {
      const env: PlatformEnv = {
        platform: "linux",
        env: { XDG_STATE_HOME: d },
        home: d,
      };
      const date = new Date("2026-05-11T00:00:00Z");
      const ingestFile = resolveLogFile("ingest", date, env, true);
      const auditFile = resolveLogFile("audit", date, env, true);
      expect(ingestFile).toMatch(/ingest-/);
      expect(auditFile).toMatch(/audit-/);
      expect(ingestFile).not.toBe(auditFile);
    });
  });

  it("mkdir=false does not crash even if dir missing", () => {
    const env: PlatformEnv = linuxEnv({ XDG_STATE_HOME: "/nonexistent/path/xyz" });
    // Should not throw — just returns the path string
    const file = resolveLogFile("ingest", new Date(), env, false);
    expect(file).toContain("ingest-");
  });

  it("creates the directory when mkdir=true", () => {
    withTmpDir((d) => {
      // resolveLogDir appends "ckforensics/logs" to XDG_STATE_HOME on Linux.
      const expectedDir = join(d, "nested", "ckforensics", "logs");
      const env: PlatformEnv = {
        platform: "linux",
        env: { XDG_STATE_HOME: join(d, "nested") },
        home: d,
      };
      // mkdir=true should create the dir
      const file = resolveLogFile("ingest", new Date("2026-01-01T00:00:00Z"), env, true);
      expect(file).toContain("ingest-");
      // Dir should now exist
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      expect(existsSync(expectedDir)).toBe(true);
    });
  });
});
