/**
 * Discovers all Claude Code JSONL session files under ~/.claude/projects/.
 *
 * Pattern: ~/.claude/projects/<project-slug>/<session-uuid>.jsonl
 *
 * Returns file metadata sorted by mtime ascending (oldest first) so ingest
 * processes files in chronological order.
 *
 * Uses Bun.Glob for native fast directory scanning — no shell globbing.
 */

import { statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredFile {
  /** Absolute path to the .jsonl file. */
  path: string;
  /** Slug derived from the immediate parent directory name. */
  projectSlug: string;
  /** File size in bytes. */
  size: number;
  /** Last-modified time as Unix epoch milliseconds. */
  mtimeMs: number;
}

export interface DiscoveryOptions {
  /** Override the root directory (default: ~/.claude/projects). */
  rootDir?: string;
}

/**
 * Glob all .jsonl files under the Claude projects directory.
 *
 * @param opts  Optional overrides for root directory.
 * @returns     Array of DiscoveredFile sorted by mtime ascending.
 */
export async function discoverJsonlFiles(
  opts: DiscoveryOptions = {}
): Promise<DiscoveredFile[]> {
  const root = opts.rootDir ?? join(homedir(), ".claude", "projects");

  // Bun.Glob pattern: two-level deep — <slug>/<file>.jsonl
  const glob = new Bun.Glob("*/*.jsonl");

  const results: DiscoveredFile[] = [];

  for await (const relPath of glob.scan({ cwd: root, onlyFiles: true })) {
    const absPath = join(root, relPath);

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absPath);
    } catch {
      // File disappeared between glob and stat — skip silently
      continue;
    }

    // Parent dir name is the project slug
    const projectSlug = basename(dirname(absPath));

    results.push({
      path: absPath,
      projectSlug,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  // Sort oldest-first so ingest processes chronologically
  results.sort((a, b) => a.mtimeMs - b.mtimeMs);

  return results;
}
