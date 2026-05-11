/**
 * XDG-compliant log directory resolver for ckforensics.
 *
 * Resolution order per platform:
 *   Linux/other : $XDG_STATE_HOME/ckforensics/logs/
 *                 → ~/.local/state/ckforensics/logs/  (fallback)
 *   macOS       : ~/Library/Logs/ckforensics/
 *   Windows     : %LOCALAPPDATA%\ckforensics\Logs\
 *
 * Mirrors the structure of store/path-resolver.ts using the same PlatformEnv
 * interface for testability across platforms.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Subset of process to allow injection in tests. */
export interface PlatformEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

/** Default real-environment platform descriptor. */
export function realPlatformEnv(): PlatformEnv {
  return {
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
  };
}

/**
 * Resolve the platform-specific log directory (without filename).
 * Does NOT create the directory — callers must mkdir themselves.
 */
export function resolveLogDir(env: PlatformEnv = realPlatformEnv()): string {
  const { platform, env: e, home } = env;

  if (platform === "win32") {
    const localAppData = e["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    return join(localAppData, "ckforensics", "Logs");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Logs", "ckforensics");
  }

  // Linux / FreeBSD / other POSIX — XDG_STATE_HOME
  const xdgStateHome = e["XDG_STATE_HOME"];
  if (xdgStateHome && xdgStateHome.trim().length > 0) {
    return join(xdgStateHome, "ckforensics", "logs");
  }
  return join(home, ".local", "state", "ckforensics", "logs");
}

/**
 * Resolve the absolute log file path for a command and date.
 * Format: <logDir>/<command>-YYYY-MM-DD.log
 *
 * @param command  Subcommand name, e.g. "ingest"
 * @param date     Date to use (defaults to today); supports injection for tests
 * @param env      Platform descriptor
 * @param mkdir    If true (default), create the log directory
 */
export function resolveLogFile(
  command: string,
  date: Date = new Date(),
  env: PlatformEnv = realPlatformEnv(),
  mkdir = true
): string {
  const dir = resolveLogDir(env);

  if (mkdir) {
    mkdirSync(dir, { recursive: true });
  }

  // Format: YYYY-MM-DD using local date components
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;

  return join(dir, `${command}-${dateStr}.log`);
}
