#!/usr/bin/env node
/**
 * scripts/postinstall.js — npm postinstall binary downloader.
 *
 * Runs automatically on `npm install` (triggered via package.json postinstall).
 * Downloads the correct platform binary from the GitHub Release matching the
 * package version, verifies SHA256 checksum, makes it executable, and saves
 * it to <pkg>/binaries/ where bin/ckforensics.js will find it.
 *
 * Written as ESM because package.json sets "type": "module".
 *
 * Design constraints:
 *   - Node 18+ only (uses built-in https, fs, crypto, path, url — NO npm deps)
 *   - Skip silently when running inside the source repo (detected via .git)
 *   - Skip when CKFORENSICS_SKIP_DOWNLOAD=1 env var is set (CI compile step)
 *   - Fail loudly with actionable message if download or checksum fails
 *
 * GitHub Release asset naming (must match scripts/build-all.sh):
 *   ckforensics-linux-x64
 *   ckforensics-linux-arm64
 *   ckforensics-darwin-x64
 *   ckforensics-darwin-arm64
 *   ckforensics-win-x64.exe
 *   checksums.txt
 */

import https   from "https";
import fs      from "fs";
import path    from "path";
import crypto  from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Configuration ─────────────────────────────────────────────────────────────

const GITHUB_REPO  = "phong28zk/ckforensics";
const PKG_ROOT     = path.resolve(__dirname, "..");
const PKG_JSON     = path.join(PKG_ROOT, "package.json");
const BINARIES_DIR = path.join(PKG_ROOT, "binaries");

// ── Early exit conditions ─────────────────────────────────────────────────────

// 1. Respect explicit opt-out (useful in CI compile jobs).
if (process.env.CKFORENSICS_SKIP_DOWNLOAD === "1") {
  console.log("[ckforensics] CKFORENSICS_SKIP_DOWNLOAD=1 — skipping binary download.");
  process.exit(0);
}

// 2. Skip when running in the source repo (developer workflow).
//    Presence of a .git directory at pkg root means we are in a git checkout.
if (fs.existsSync(path.join(PKG_ROOT, ".git"))) {
  console.log("[ckforensics] Source repo detected (.git present) — skipping binary download.");
  process.exit(0);
}

// ── Platform → binary name mapping ───────────────────────────────────────────

// darwin-x64 (Intel Mac) intentionally omitted from prebuilt releases.
// Intel Mac users: build from source — see README "Build from source".
const PLATFORM_MAP = {
  "linux-x64":    "ckforensics-linux-x64",
  "linux-arm64":  "ckforensics-linux-arm64",
  "darwin-arm64": "ckforensics-darwin-arm64",
  "win32-x64":    "ckforensics-win-x64.exe",
};

const platform = process.platform; // "linux" | "darwin" | "win32"
const arch     = process.arch;     // "x64" | "arm64"
const key      = `${platform}-${arch}`;
const binName  = PLATFORM_MAP[key];

if (!binName) {
  console.warn(
    `[ckforensics] Unsupported platform ${platform}-${arch} — no binary available.\n` +
    `Supported: ${Object.keys(PLATFORM_MAP).join(", ")}\n` +
    `You can build from source: bun build --compile src/cli/index.ts`
  );
  // Non-fatal: user can still build from source.
  process.exit(0);
}

// ── Resolve package version ───────────────────────────────────────────────────

let version;
try {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, "utf8"));
  version = pkg.version;
  if (!version) throw new Error("version field missing");
} catch (e) {
  fatal(`Cannot read package version from ${PKG_JSON}: ${e.message}`);
}

const tagName        = `v${version}`;
const releaseBaseUrl = `https://github.com/${GITHUB_REPO}/releases/download/${tagName}`;
const binaryUrl      = `${releaseBaseUrl}/${binName}`;
const checksumUrl    = `${releaseBaseUrl}/checksums.txt`;

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Exit with a human-readable error. */
function fatal(msg) {
  process.stderr.write(`[ckforensics] ERROR: ${msg}\n`);
  process.exit(1);
}

/**
 * Follow HTTP redirects and return the final response.
 * Supports up to 10 hops (GitHub Releases redirects to S3).
 *
 * @param {string} url
 * @param {number} hops
 * @returns {Promise<import("http").IncomingMessage>}
 */
function httpsGet(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 10) return reject(new Error(`Too many redirects for ${url}`));

    https
      .get(url, { headers: { "User-Agent": "ckforensics-postinstall/1.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // discard body
          return resolve(httpsGet(res.headers.location, hops + 1));
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

/**
 * Download a URL and buffer the full body.
 *
 * @param {string} url
 * @returns {Promise<{ status: number, buffer: Buffer }>}
 */
async function download(url) {
  const res = await httpsGet(url);
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end",  () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    res.on("error", reject);
  });
}

/** Compute SHA256 hex of a Buffer. */
function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Parse checksums.txt (sha256sum format: "<hash>  <filename>\n").
 *
 * @param {string} text
 * @returns {Map<string, string>}  filename → lowercase hex hash
 */
function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Two-space separator (sha256sum convention) or single space (shasum)
    const match = trimmed.match(/^([0-9a-f]{64})\s{1,2}(.+)$/i);
    if (match) map.set(match[2].trim(), match[1].toLowerCase());
  }
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[ckforensics] Downloading binary for ${platform}-${arch} (${tagName})...`);

  // 1. Fetch checksums first (fail fast if release doesn't exist).
  console.log(`[ckforensics] Fetching checksums from: ${checksumUrl}`);
  const cksumResult = await download(checksumUrl).catch((e) =>
    fatal(`Failed to fetch checksums: ${e.message}`)
  );

  if (cksumResult.status !== 200) {
    fatal(
      `Checksums not found (HTTP ${cksumResult.status}). ` +
      `Release ${tagName} may not exist yet at https://github.com/${GITHUB_REPO}/releases`
    );
  }

  const checksums    = parseChecksums(cksumResult.buffer.toString("utf8"));
  const expectedHash = checksums.get(binName);

  if (!expectedHash) {
    fatal(
      `No checksum entry for "${binName}" in checksums.txt. ` +
      `Available entries: ${[...checksums.keys()].join(", ")}`
    );
  }

  // 2. Download binary.
  console.log(`[ckforensics] Downloading binary from: ${binaryUrl}`);
  const binResult = await download(binaryUrl).catch((e) =>
    fatal(`Failed to download binary: ${e.message}`)
  );

  if (binResult.status !== 200) {
    fatal(`Binary download failed (HTTP ${binResult.status}). URL: ${binaryUrl}`);
  }

  // 3. Verify checksum.
  const actualHash = sha256hex(binResult.buffer);
  if (actualHash !== expectedHash) {
    fatal(
      `SHA256 mismatch for ${binName}!\n` +
      `  Expected: ${expectedHash}\n` +
      `  Got:      ${actualHash}\n` +
      `The download may be corrupt or tampered — aborting for safety.`
    );
  }
  console.log(`[ckforensics] Checksum verified OK (${actualHash.slice(0, 16)}...)`);

  // 4. Write binary to disk.
  fs.mkdirSync(BINARIES_DIR, { recursive: true });
  const destPath = path.join(BINARIES_DIR, binName);
  fs.writeFileSync(destPath, binResult.buffer);

  // 5. chmod +x on Unix.
  if (platform !== "win32") {
    fs.chmodSync(destPath, 0o755);
    console.log(`[ckforensics] Set executable bit on ${destPath}`);
  }

  const sizeMB = (binResult.buffer.length / 1024 / 1024).toFixed(1);
  console.log(`[ckforensics] Installed ${binName} (${sizeMB} MB) → ${destPath}`);
  console.log(`[ckforensics] Run: ckforensics --help`);
}

main().catch((e) => fatal(String(e)));
