/**
 * XDG-compliant database path resolver for ckforensics.
 *
 * Resolution order per platform:
 *   Linux/other : $XDG_DATA_HOME/ckforensics/store.db
 *                 → ~/.local/share/ckforensics/store.db  (fallback)
 *   macOS       : ~/Library/Application Support/ckforensics/store.db
 *   Windows     : %APPDATA%\ckforensics\store.db
 *
 * The resolved directory is created (mkdirSync recursive) before returning
 * so callers can open the DB immediately without extra setup.
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
 * Resolve the absolute path to the ckforensics SQLite store.
 *
 * @param env   Platform descriptor — inject a mock in tests.
 * @param mkdir If true (default), create the parent directory.
 * @returns     Absolute path string ending in "store.db".
 */
export function resolveDbPath(
  env: PlatformEnv = realPlatformEnv(),
  mkdir = true
): string {
  const dir = resolveDataDir(env);
  if (mkdir) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "store.db");
}

/** Resolve the platform-specific data directory (without filename). */
export function resolveDataDir(env: PlatformEnv = realPlatformEnv()): string {
  const { platform, env: e, home } = env;

  if (platform === "win32") {
    const appData = e["APPDATA"] ?? join(home, "AppData", "Roaming");
    return join(appData, "ckforensics");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "ckforensics");
  }

  // Linux / FreeBSD / other POSIX
  const xdgDataHome = e["XDG_DATA_HOME"];
  if (xdgDataHome && xdgDataHome.trim().length > 0) {
    return join(xdgDataHome, "ckforensics");
  }
  return join(home, ".local", "share", "ckforensics");
}
