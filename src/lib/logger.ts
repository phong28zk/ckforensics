/**
 * Minimal append-only file logger for ckforensics.
 *
 * - Writes structured lines: <ISO-ts> <LEVEL> <command> <msg> [JSON extra]
 * - Daily rotation by filename: <logDir>/<command>-YYYY-MM-DD.log
 * - File permissions 0600 on Unix (append-only, never overwrites)
 * - Graceful fallback: if log dir is unwriteable, warns once to stderr and
 *   continues as a no-op — the CLI must not crash due to logging failures
 * - Applies redaction to all message strings (best-effort)
 * - <5ms overhead per call
 */

import { appendFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_RULES } from "../privacy/redaction-rules.ts";
import { resolveLogFile } from "./log-path-resolver.ts";
import type { PlatformEnv } from "./log-path-resolver.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LogLevel = "error" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };

export interface LoggerOptions {
  /** Subcommand name used in log lines and file naming. */
  command: string;
  /** Minimum level to emit. Lines below this rank are silently dropped. */
  level: LogLevel;
  /** Override log directory (skips path resolver). */
  logDir?: string;
  /** Platform env override for tests. */
  env?: PlatformEnv;
  /** Date override for tests (controls daily log file name). */
  date?: Date;
}

// ── Redaction helper ──────────────────────────────────────────────────────────

/** Apply all default redaction rules to a string (best-effort). */
function redactLine(text: string): string {
  let out = text;
  for (const rule of DEFAULT_RULES) {
    // Reset lastIndex — global regexes are stateful
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, `[REDACTED:${rule.id}]`);
  }
  return out;
}

// ── Logger class ──────────────────────────────────────────────────────────────

export class Logger {
  private readonly command: string;
  private readonly level: LogLevel;
  private readonly logFile: string;
  /** Set to true after the first write failure to avoid repeated stderr noise. */
  private warnedOnce = false;
  /** Set to true once we confirm the dir is unwriteable (no-op mode). */
  private disabled = false;

  constructor(opts: LoggerOptions) {
    this.command = opts.command;
    this.level = opts.level;

    if (opts.logDir) {
      // Explicit logDir provided (e.g. from --log-dir flag or tests)
      const date = opts.date ?? new Date();
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const dd = String(date.getDate()).padStart(2, "0");
      const dateStr = `${yyyy}-${mm}-${dd}`;

      try {
        mkdirSync(opts.logDir, { recursive: true });
      } catch {
        // Will be caught on first write below
      }

      this.logFile = join(opts.logDir, `${opts.command}-${dateStr}.log`);
    } else {
      // Use the XDG-compliant path resolver
      this.logFile = resolveLogFile(
        opts.command,
        opts.date ?? new Date(),
        opts.env,
        true
      );
    }
  }

  /** Log at ERROR level. Always emitted regardless of configured level. */
  error(msg: string, extra?: object): void {
    this.write("error", msg, extra);
  }

  /** Log at INFO level. Emitted when level is "info" or "debug". */
  info(msg: string, extra?: object): void {
    this.write("info", msg, extra);
  }

  /** Log at DEBUG level. Emitted only when level is "debug". */
  debug(msg: string, extra?: object): void {
    this.write("debug", msg, extra);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private write(level: LogLevel, msg: string, extra?: object): void {
    if (this.disabled) return;
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level]) return;

    const line = this.formatLine(level, msg, extra);

    try {
      // Ensure parent dir exists (may have been deleted between constructor and write)
      const dir = dirname(this.logFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Append-only write; creates file if not present
      appendFileSync(this.logFile, line, { encoding: "utf8", flag: "a" });

      // Set 0600 on first write (best-effort; noop on Windows)
      try {
        chmodSync(this.logFile, 0o600);
      } catch {
        // Windows or read-only FS — ignore silently
      }
    } catch (err) {
      if (!this.warnedOnce) {
        this.warnedOnce = true;
        process.stderr.write(
          `[ckforensics] warning: cannot write to log file ${this.logFile}: ${String(err)}\n`
        );
      }
      this.disabled = true;
    }
  }

  private formatLine(level: LogLevel, msg: string, extra?: object): string {
    const ts = new Date().toISOString();
    const lvl = level.toUpperCase().padEnd(5);
    const safeMsg = redactLine(msg);

    let line = `${ts} ${lvl} ${this.command} ${safeMsg}`;

    if (extra !== undefined) {
      try {
        const extraStr = redactLine(JSON.stringify(extra));
        line += ` ${extraStr}`;
      } catch {
        // Circular reference or BigInt — skip extra
      }
    }

    return line + "\n";
  }
}

/** Create a no-op logger that never writes anything (useful for tests). */
export function createNullLogger(): Logger {
  return new Logger({ command: "null", level: "error", logDir: "/dev/null" });
}
