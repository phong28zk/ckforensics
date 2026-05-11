#!/usr/bin/env node
/**
 * install-claudekit-skill.js — Install the bundled `/ck:forensics` skill into
 * the user's ClaudeKit skill directory (`~/.claude/skills/ckforensics/`).
 *
 * Called from postinstall.js. Designed to be silent on success and never
 * fail the parent install — skill is a nice-to-have, not a hard dependency.
 *
 * Behavior:
 *  - Copies `<pkg>/.claude/skills/ckforensics/` to `~/.claude/skills/ckforensics/`.
 *  - Skip when source dir missing (e.g. dev install without the bundle).
 *  - Skip on opt-out: `CKFORENSICS_SKIP_SKILL_INSTALL=1`.
 *  - Existing skill dir is overwritten (idempotent re-install / version upgrade).
 *  - Warnings to stderr only; never exits non-zero.
 */

import { existsSync, mkdirSync, cpSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const SKILL_SOURCE = join(PKG_ROOT, ".claude", "skills", "ckforensics");
const SKILL_TARGET = join(homedir(), ".claude", "skills", "ckforensics");

function log(msg) {
  // Single-line dim format to fit cleanly in npm install output
  process.stderr.write(`[ckforensics:skill] ${msg}\n`);
}

function shouldSkip() {
  // Explicit opt-out
  if (process.env.CKFORENSICS_SKIP_SKILL_INSTALL === "1") {
    log("skipped via CKFORENSICS_SKIP_SKILL_INSTALL=1");
    return true;
  }
  // Source missing — dev install or trimmed tarball
  if (!existsSync(SKILL_SOURCE)) {
    log(`skill source not bundled (${SKILL_SOURCE}); skipping`);
    return true;
  }
  return false;
}

function copySkill() {
  // Ensure parent dir exists; cpSync recursive handles the rest.
  mkdirSync(dirname(SKILL_TARGET), { recursive: true });

  // Detect upgrade vs first install for friendlier message
  const existing = existsSync(SKILL_TARGET);
  cpSync(SKILL_SOURCE, SKILL_TARGET, {
    recursive: true,
    force: true,
    // Don't overwrite if user has customised it (mtime-based heuristic)
    // — but that's risky and confusing. For now: always overwrite, matches
    // CLI versioning semantics (skill version pinned to CLI version).
  });

  const action = existing ? "updated" : "installed";
  log(`${action} skill at ${SKILL_TARGET}`);
  log("activate next Claude Code session: /ck:forensics");
}

try {
  if (shouldSkip()) {
    process.exit(0);
  }
  copySkill();
} catch (err) {
  // Never fail parent install over skill copy
  log(`warning: skill install failed (${err.message}); continuing`);
  process.exit(0);
}
