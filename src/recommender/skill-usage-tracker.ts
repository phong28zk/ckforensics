/**
 * Skill usage tracker: detects skill activations in session events and
 * persists them to the skill_usage table.
 *
 * Detection strategy: scan system-type events for content containing
 * <command-name>ck:foo</command-name> patterns (CC hook injection format).
 * Also scans assistant text content for /ck:foo invocation patterns.
 *
 * Provides:
 *   - trackSkillUsage(db, sessionId, events)  → rows inserted
 *   - getSkillUsageForSession(db, sessionId)   → SkillUsageRecord[]
 *   - getAllSkillUsage(db)                     → aggregate counts
 */

import type { Database } from "bun:sqlite";
import type { HydratedEvent } from "../audit/manifest-types.ts";
import type { SystemEvent, AssistantEvent } from "../parsers/event-types.ts";
import type { SkillUsageRecord } from "./types.ts";

// ── Patterns ──────────────────────────────────────────────────────────────────

/** Matches <command-name>ck:foo</command-name> in system content. */
const COMMAND_NAME_RE = /<command-name>\s*ck:([a-z][\w-]*)\s*<\/command-name>/g;

/** Matches /ck:foo in assistant text content. */
const SLASH_SKILL_RE = /\/ck:([\w-]+)/g;

// ── Extraction ────────────────────────────────────────────────────────────────

interface SkillActivation {
  skillName: string;
  activatedAt: string | null;
}

function extractFromSystemEvent(event: SystemEvent): SkillActivation[] {
  const content = event.content ?? "";
  const activations: SkillActivation[] = [];
  const ts = event.timestamp ?? null;

  let m: RegExpExecArray | null;
  COMMAND_NAME_RE.lastIndex = 0;
  while ((m = COMMAND_NAME_RE.exec(content)) !== null) {
    const name = m[1];
    if (name) activations.push({ skillName: name, activatedAt: ts });
  }
  return activations;
}

function extractFromAssistantEvent(event: AssistantEvent): SkillActivation[] {
  const activations: SkillActivation[] = [];
  const ts = event.timestamp ?? null;

  for (const block of event.message.content) {
    if (block.type !== "text") continue;
    const text = (block as { type: "text"; text: string }).text;
    SLASH_SKILL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SLASH_SKILL_RE.exec(text)) !== null) {
      const name = m[1];
      if (name) activations.push({ skillName: name, activatedAt: ts });
    }
  }
  return activations;
}

/** Extract all skill activations from a session's events. */
function extractActivations(events: HydratedEvent[]): SkillActivation[] {
  const all: SkillActivation[] = [];
  const seen = new Set<string>(); // deduplicate per session

  for (const he of events) {
    let found: SkillActivation[] = [];

    if (he.event.kind === "system") {
      found = extractFromSystemEvent(he.event as SystemEvent);
    } else if (he.event.kind === "assistant") {
      found = extractFromAssistantEvent(he.event as AssistantEvent);
    }

    for (const act of found) {
      const key = `${act.skillName}:${act.activatedAt ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(act);
      }
    }
  }
  return all;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function insertActivation(
  db: Database,
  sessionId: string,
  activation: SkillActivation
): void {
  db.run(
    `INSERT OR IGNORE INTO skill_usage (session_id, skill_name, activated_at)
     VALUES (?, ?, ?)`,
    [sessionId, activation.skillName, activation.activatedAt]
  );
}

function clearSessionUsage(db: Database, sessionId: string): void {
  db.run("DELETE FROM skill_usage WHERE session_id = ?", [sessionId]);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan session events for skill activations and upsert into skill_usage.
 * Clears existing rows for the session before inserting (idempotent).
 *
 * @returns Number of skill activation rows inserted.
 */
export function trackSkillUsage(
  db: Database,
  sessionId: string,
  events: HydratedEvent[]
): number {
  const activations = extractActivations(events);
  if (activations.length === 0) return 0;

  clearSessionUsage(db, sessionId);
  for (const act of activations) {
    insertActivation(db, sessionId, act);
  }
  return activations.length;
}

/**
 * Load all skill_usage rows for a session.
 */
export function getSkillUsageForSession(
  db: Database,
  sessionId: string
): SkillUsageRecord[] {
  interface Row {
    id: number;
    session_id: string;
    skill_name: string;
    activated_at: string | null;
  }
  const rows = db
    .query<Row, [string]>(
      `SELECT id, session_id, skill_name, activated_at
       FROM skill_usage WHERE session_id = ? ORDER BY id`
    )
    .all(sessionId);

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    skillName: r.skill_name,
    activatedAt: r.activated_at,
  }));
}

/**
 * Aggregate skill usage counts across all sessions.
 * Returns map of skillName → { sessions: number, totalActivations: number }.
 */
export function getAggregateSkillUsage(
  db: Database
): Map<string, { sessions: number; totalActivations: number; lastUsed: string | null }> {
  interface Row {
    skill_name: string;
    sessions: number;
    total: number;
    last_used: string | null;
  }
  const rows = db
    .query<Row, []>(
      `SELECT skill_name,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(*) AS total,
              MAX(activated_at) AS last_used
       FROM skill_usage
       GROUP BY skill_name
       ORDER BY sessions DESC`
    )
    .all();

  const map = new Map<string, { sessions: number; totalActivations: number; lastUsed: string | null }>();
  for (const r of rows) {
    map.set(r.skill_name, {
      sessions: r.sessions,
      totalActivations: r.total,
      lastUsed: r.last_used,
    });
  }
  return map;
}

/**
 * Check if a specific skill was used in a given session.
 */
export function wasSkillUsedInSession(
  db: Database,
  sessionId: string,
  skillName: string
): boolean {
  const row = db
    .query<{ cnt: number }, [string, string]>(
      "SELECT COUNT(*) AS cnt FROM skill_usage WHERE session_id = ? AND skill_name = ?"
    )
    .get(sessionId, skillName);
  return (row?.cnt ?? 0) > 0;
}
