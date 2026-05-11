/**
 * Per-pattern detection functions, extracted from pattern-detector.ts.
 * Each function takes the pre-built AssistantTurn array and returns a typed
 * Pattern or null if the threshold is not met.
 */

import { dirname } from "node:path";
import type {
  ReadFanoutPattern,
  TestLoopPattern,
  ManualDiffCyclePattern,
  GrepWalkPattern,
  SubagentSkipPattern,
} from "./types.ts";
import type { AssistantTurn } from "./pattern-detector-types.ts";

// ── Thresholds ────────────────────────────────────────────────────────────────

const READ_FANOUT_MIN = 5;
const READ_FANOUT_WINDOW_TURNS = 3;
const TEST_LOOP_MIN = 3;
const DIFF_CYCLE_MIN = 2;
const GREP_WALK_MIN_PAIRS = 4;
const SUBAGENT_SKIP_MIN_CALLS = 20;

const TEST_RUNNER_RE =
  /\b(bun|npm|yarn|pnpm)\s+(test|t)\b|pytest\b|vitest\b|jest\b/;

// ── Shared helpers ────────────────────────────────────────────────────────────

export function inputStr(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

// ── Detectors ─────────────────────────────────────────────────────────────────

export function detectReadFanout(turns: AssistantTurn[]): ReadFanoutPattern | null {
  for (let start = 0; start <= turns.length - 1; start++) {
    const end = Math.min(start + READ_FANOUT_WINDOW_TURNS, turns.length);
    const window = turns.slice(start, end);

    const dirCounts = new Map<string, { count: number; turnIdxs: number[]; timestamps: string[] }>();

    for (const turn of window) {
      const reads = turn.toolUses.filter((t) => t.name === "Read");
      for (const r of reads) {
        const p = inputStr(r.input, "file_path");
        if (!p) continue;
        const dir = dirname(p);
        const existing = dirCounts.get(dir) ?? { count: 0, turnIdxs: [], timestamps: [] };
        existing.count++;
        if (!existing.turnIdxs.includes(turn.index)) {
          existing.turnIdxs.push(turn.index);
          existing.timestamps.push(turn.timestamp);
        }
        dirCounts.set(dir, existing);
      }
    }

    for (const [dir, data] of dirCounts) {
      if (data.count >= READ_FANOUT_MIN) {
        const tokens = window.reduce((s, t) => s + t.tokens, 0);
        return {
          type: "read-fanout",
          dir,
          count: data.count,
          turnIndices: data.turnIdxs,
          timestamps: data.timestamps,
          tokensConsumed: tokens,
        };
      }
    }
  }
  return null;
}

export function detectTestLoop(turns: AssistantTurn[]): TestLoopPattern | null {
  const matched: AssistantTurn[] = [];
  const commands: string[] = [];

  for (const turn of turns) {
    const bashes = turn.toolUses.filter((t) => t.name === "Bash");
    for (const b of bashes) {
      const cmd = inputStr(b.input, "command");
      if (TEST_RUNNER_RE.test(cmd)) {
        matched.push(turn);
        commands.push(cmd.slice(0, 80));
        break;
      }
    }
  }

  if (matched.length >= TEST_LOOP_MIN) {
    return {
      type: "test-loop",
      count: matched.length,
      turnIndices: matched.map((t) => t.index),
      timestamps: matched.map((t) => t.timestamp),
      commands: commands.slice(0, 5),
      tokensConsumed: matched.reduce((s, t) => s + t.tokens, 0),
    };
  }
  return null;
}

export function detectManualDiffCycle(turns: AssistantTurn[]): ManualDiffCyclePattern | null {
  const fileHistory = new Map<string, string[]>();

  for (const turn of turns) {
    for (const t of turn.toolUses) {
      const p = inputStr(t.input, "file_path");
      if (!p) continue;
      if (t.name === "Read") {
        const h = fileHistory.get(p) ?? [];
        h.push("R");
        fileHistory.set(p, h);
      } else if (t.name === "Edit" || t.name === "Write" || t.name === "MultiEdit") {
        const h = fileHistory.get(p) ?? [];
        h.push("E");
        fileHistory.set(p, h);
      }
    }
  }

  for (const [filePath, hist] of fileHistory) {
    let cycles = 0;
    let i = 0;
    while (i < hist.length - 2) {
      if (hist[i] === "R" && hist[i + 1] === "E" && hist[i + 2] === "R") {
        cycles++;
        i += 2;
      } else {
        i++;
      }
    }
    if (cycles >= DIFF_CYCLE_MIN) {
      const turnIdxs: number[] = [];
      const timestamps: string[] = [];
      for (const turn of turns) {
        const hasFile = turn.toolUses.some(
          (t) =>
            (t.name === "Read" || t.name === "Edit" || t.name === "Write") &&
            inputStr(t.input, "file_path") === filePath
        );
        if (hasFile) { turnIdxs.push(turn.index); timestamps.push(turn.timestamp); }
      }
      return {
        type: "manual-diff-cycle",
        filePath,
        cycles,
        turnIndices: turnIdxs,
        timestamps,
        tokensConsumed: turns.filter((t) => turnIdxs.includes(t.index)).reduce((s, t) => s + t.tokens, 0),
      };
    }
  }
  return null;
}

export function detectGrepWalk(turns: AssistantTurn[]): GrepWalkPattern | null {
  let pairCount = 0;
  const pairTurnIdxs: number[] = [];
  const pairTimestamps: string[] = [];
  let lastWasGrep = false;

  for (const turn of turns) {
    const hasGrep = turn.toolUses.some((t) => t.name === "Grep");
    const hasRead = turn.toolUses.some((t) => t.name === "Read");

    if (hasGrep && hasRead) {
      pairCount++;
      pairTurnIdxs.push(turn.index);
      pairTimestamps.push(turn.timestamp);
      lastWasGrep = false;
    } else if (hasGrep) {
      lastWasGrep = true;
    } else if (hasRead && lastWasGrep) {
      pairCount++;
      pairTurnIdxs.push(turn.index);
      pairTimestamps.push(turn.timestamp);
      lastWasGrep = false;
    } else {
      if (!hasGrep) lastWasGrep = false;
    }
  }

  if (pairCount >= GREP_WALK_MIN_PAIRS) {
    return {
      type: "grep-walk",
      pairCount,
      turnIndices: pairTurnIdxs,
      timestamps: pairTimestamps,
      tokensConsumed: turns.filter((t) => pairTurnIdxs.includes(t.index)).reduce((s, t) => s + t.tokens, 0),
    };
  }
  return null;
}

export function detectSubagentSkip(turns: AssistantTurn[]): SubagentSkipPattern | null {
  const totalToolCalls = turns.reduce((s, t) => s + t.toolUses.length, 0);
  const hasSubagent = turns.some((t) =>
    t.toolUses.some((u) => u.name === "Task" || u.name === "Agent")
  );

  if (totalToolCalls >= SUBAGENT_SKIP_MIN_CALLS && !hasSubagent) {
    return {
      type: "subagent-skip",
      toolCallCount: totalToolCalls,
      turnIndices: turns.map((t) => t.index),
      timestamps: turns.map((t) => t.timestamp),
      tokensConsumed: turns.reduce((s, t) => s + t.tokens, 0),
    };
  }
  return null;
}
