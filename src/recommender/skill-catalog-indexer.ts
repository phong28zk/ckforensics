/**
 * Skill catalog indexer: walks ~/.claude/skills/**\/SKILL.md files,
 * parses YAML frontmatter (name, description, keywords, argument-hint),
 * and persists results to the skill_catalog SQLite table.
 *
 * Cache invalidation: rows are refreshed when file mtime differs from stored.
 * Malformed frontmatter → skip with warn to stderr (no throw).
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  description: string;
  keywords: string[];
  path: string;
  mtime: number;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  refreshed: number;
}

// ── YAML frontmatter parser ───────────────────────────────────────────────────

/**
 * Extract YAML frontmatter block between leading --- delimiters.
 * Returns null if no frontmatter found.
 */
function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? (match[1] ?? null) : null;
}

/**
 * Very lightweight YAML key extractor — handles:
 *   key: scalar value
 *   key: [item1, item2]
 *   key: item1  (single-item inline array)
 * Does NOT parse full YAML — only what SKILL.md frontmatter uses.
 */
function parseFrontmatterField(yaml: string, key: string): string | null {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(regex);
  return match ? (match[1]?.trim() ?? null) : null;
}

function parseKeywordsField(yaml: string): string[] {
  const raw = parseFrontmatterField(yaml, "keywords");
  if (!raw) return [];
  // Handle inline YAML array: [foo, bar, baz] or foo, bar
  const stripped = raw.replace(/^\[/, "").replace(/\]$/, "");
  return stripped
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// ── File walker ───────────────────────────────────────────────────────────────

/**
 * Recursively walk a directory and collect all SKILL.md file paths.
 * Max depth 5 to avoid runaway traversal.
 */
function walkSkillFiles(dir: string, depth = 0): string[] {
  if (depth > 5 || !existsSync(dir)) return [];
  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...walkSkillFiles(full, depth + 1));
      } else if (entry === "SKILL.md") {
        results.push(full);
      }
    } catch {
      // Ignore unreadable entries
    }
  }
  return results;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

interface CatalogRow {
  name: string;
  mtime: number | null;
}

function upsertSkill(db: Database, entry: SkillEntry): void {
  db.run(
    `INSERT OR REPLACE INTO skill_catalog (name, description, keywords, path, mtime)
     VALUES (?, ?, ?, ?, ?)`,
    [
      entry.name,
      entry.description,
      JSON.stringify(entry.keywords),
      entry.path,
      entry.mtime,
    ]
  );
}

function getExistingMtimes(db: Database): Map<string, number> {
  const rows = db
    .query<CatalogRow, []>("SELECT name, mtime FROM skill_catalog")
    .all();
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.name, row.mtime ?? 0);
  }
  return map;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Index all SKILL.md files found under skillsDir into the DB.
 * Default skillsDir: ~/.claude/skills
 *
 * @returns IndexResult with counts for monitoring/display.
 */
export function indexSkillCatalog(
  db: Database,
  skillsDir?: string,
  verbose = false
): IndexResult {
  const dir = resolve(skillsDir ?? join(homedir(), ".claude", "skills"));

  if (!existsSync(dir)) {
    if (verbose) process.stderr.write(`skills dir not found: ${dir}\n`);
    return { indexed: 0, skipped: 0, refreshed: 0 };
  }

  const files = walkSkillFiles(dir);
  const existing = getExistingMtimes(db);

  let indexed = 0;
  let skipped = 0;
  let refreshed = 0;

  for (const filePath of files) {
    try {
      const stat = statSync(filePath);
      const mtime = stat.mtimeMs;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        skipped++;
        continue;
      }

      const fm = extractFrontmatter(content);
      if (!fm) {
        if (verbose) process.stderr.write(`warn: no frontmatter in ${filePath}\n`);
        skipped++;
        continue;
      }

      const name = parseFrontmatterField(fm, "name");
      if (!name) {
        if (verbose) process.stderr.write(`warn: missing name in ${filePath}\n`);
        skipped++;
        continue;
      }

      const description = parseFrontmatterField(fm, "description") ?? "";
      const keywords = parseKeywordsField(fm);

      // Skip if mtime unchanged (cache hit)
      const prevMtime = existing.get(name);
      if (prevMtime !== undefined && prevMtime === mtime) {
        indexed++;
        continue;
      }

      const entry: SkillEntry = {
        name,
        description: description.replace(/^["']|["']$/g, ""),
        keywords,
        path: filePath,
        mtime,
      };

      upsertSkill(db, entry);

      if (prevMtime !== undefined) {
        refreshed++;
      }
      indexed++;
    } catch (err) {
      if (verbose) process.stderr.write(`warn: error reading ${filePath}: ${String(err)}\n`);
      skipped++;
    }
  }

  return { indexed, skipped, refreshed };
}

/**
 * Load all entries from the catalog table.
 */
export function loadCatalog(db: Database): SkillEntry[] {
  interface Row {
    name: string;
    description: string | null;
    keywords: string | null;
    path: string;
    mtime: number | null;
  }

  const rows = db
    .query<Row, []>(
      "SELECT name, description, keywords, path, mtime FROM skill_catalog ORDER BY name"
    )
    .all();

  return rows.map((row) => ({
    name: row.name,
    description: row.description ?? "",
    keywords: parseKeywordsJson(row.keywords),
    path: row.path,
    mtime: row.mtime ?? 0,
  }));
}

function parseKeywordsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
