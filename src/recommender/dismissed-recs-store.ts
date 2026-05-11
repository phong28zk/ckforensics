/**
 * Dismissed recommendations store.
 *
 * Persists a set of dismissed skill names to
 * ~/.config/ckforensics/dismissed.json so users are not repeatedly
 * shown recommendations they have already acted on or rejected.
 *
 * File format: { "dismissed": ["scout", "test"] }
 * Cross-platform path via os.homedir() + path.join (no hardcoded /).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Path resolution ───────────────────────────────────────────────────────────

function dismissedPath(): string {
  const base =
    process.env["XDG_CONFIG_HOME"] ??
    join(homedir(), ".config");
  return join(base, "ckforensics", "dismissed.json");
}

// ── IO helpers ────────────────────────────────────────────────────────────────

function readDismissed(): Set<string> {
  const p = dismissedPath();
  if (!existsSync(p)) return new Set();
  try {
    const raw = readFileSync(p, "utf-8");
    const obj = JSON.parse(raw) as { dismissed?: unknown };
    const arr = obj.dismissed;
    if (Array.isArray(arr)) {
      return new Set(arr.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // Corrupt file → treat as empty
  }
  return new Set();
}

function writeDismissed(set: Set<string>): void {
  const p = dismissedPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({ dismissed: [...set].sort() }, null, 2) + "\n", "utf-8");
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return true if the skill name has been dismissed by the user. */
export function isDismissed(skillName: string): boolean {
  return readDismissed().has(skillName);
}

/** Filter a list of skill names, removing any that are dismissed. */
export function filterDismissed<T extends { skillName: string }>(items: T[]): T[] {
  const dismissed = readDismissed();
  return items.filter((i) => !dismissed.has(i.skillName));
}

/** Add a skill name to the dismissed list. */
export function dismissSkill(skillName: string): void {
  const set = readDismissed();
  set.add(skillName);
  writeDismissed(set);
}

/** Remove a skill name from the dismissed list (un-dismiss). */
export function undismissSkill(skillName: string): void {
  const set = readDismissed();
  set.delete(skillName);
  writeDismissed(set);
}

/** Return all currently dismissed skill names. */
export function listDismissed(): string[] {
  return [...readDismissed()].sort();
}
