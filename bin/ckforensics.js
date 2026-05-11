#!/usr/bin/env node
/**
 * bin/ckforensics.js — npm wrapper shim for ckforensics.
 *
 * This file is the npm `bin` entry point. It detects the current platform/arch,
 * locates the matching prebuilt binary inside node_modules/ckforensics/binaries/,
 * and delegates execution via spawnSync (stdio: inherit + exit code propagation).
 *
 * Written as ESM because package.json sets "type": "module".
 *
 * Requirements:
 *   - Node 18+ (uses only built-in modules: path, child_process, fs, url)
 *   - Binary must have been placed by scripts/postinstall.js (runs on npm install)
 *
 * Error behaviour:
 *   - Binary missing → clear message pointing to postinstall, exits 1
 *   - spawnSync error  → prints OS error, exits 1
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Platform → binary name mapping ───────────────────────────────────────────

const PLATFORM_MAP = {
  "linux-x64":    "ckforensics-linux-x64",
  "linux-arm64":  "ckforensics-linux-arm64",
  "darwin-x64":   "ckforensics-darwin-x64",
  "darwin-arm64": "ckforensics-darwin-arm64",
  "win32-x64":    "ckforensics-win-x64.exe",
};

// ── Resolve binary path ───────────────────────────────────────────────────────

const platform = process.platform;  // "linux" | "darwin" | "win32"
const arch     = process.arch;      // "x64" | "arm64"
const key      = `${platform}-${arch}`;
const binName  = PLATFORM_MAP[key];

if (!binName) {
  process.stderr.write(
    `[ckforensics] Unsupported platform: ${platform}-${arch}\n` +
    `Supported: ${Object.keys(PLATFORM_MAP).join(", ")}\n`
  );
  process.exit(1);
}

// Binaries live next to this shim's package root: <pkg>/binaries/<name>
// __dirname is <pkg>/bin/, so go up one level.
const pkgRoot    = path.resolve(__dirname, "..");
const binaryDir  = path.join(pkgRoot, "binaries");
const binaryPath = path.join(binaryDir, binName);

if (!existsSync(binaryPath)) {
  process.stderr.write(
    `[ckforensics] Binary not found: ${binaryPath}\n` +
    `This usually means the postinstall script did not run.\n` +
    `Try: npm install  (or re-run: node ${path.join(pkgRoot, "scripts", "postinstall.js")})\n`
  );
  process.exit(1);
}

// ── Execute binary ────────────────────────────────────────────────────────────

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  // Pass through the full environment so the binary inherits PATH, HOME, etc.
  env: process.env,
});

if (result.error) {
  process.stderr.write(
    `[ckforensics] Failed to launch binary: ${result.error.message}\n`
  );
  process.exit(1);
}

process.exit(result.status ?? 0);
