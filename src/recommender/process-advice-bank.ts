/**
 * Process + prompt advice bank.
 *
 * Pure static data: maps each PatternType to a list of universally-useful
 * advice entries that do NOT require ClaudeKit skills to be installed.
 *
 * Two advice tiers:
 *   "process" — workflow or tooling habit changes (Glob, watch mode, etc.)
 *   "prompt"  — context management and session hygiene
 *
 * Confidence values are fixed baselines (60-70); callers may scale by
 * pattern strength before applying the global threshold filter.
 */

import type { PatternType } from "./types.ts";

// ── Bank entry type ───────────────────────────────────────────────────────────

export interface AdviceBankEntry {
  /** Discriminator for rendering and dedup. */
  adviceType: "process" | "prompt";
  /** Short human-readable label (used as dedup key). */
  title: string;
  /** 1-2 sentences: what the pattern signals + what to do instead. */
  description: string;
  /** Fixed baseline confidence before any scaling. */
  baseConfidence: number;
}

// ── Advice data ───────────────────────────────────────────────────────────────

/**
 * Static map from PatternType → advice entries.
 * Each pattern type has at least one "process" and, where applicable, "prompt" entry.
 */
export const ADVICE_BANK: Record<PatternType, AdviceBankEntry[]> = {
  // ── read-fanout ──────────────────────────────────────────────────────────────
  "read-fanout": [
    {
      adviceType: "process",
      title: "Use Glob to enumerate files before reading",
      description:
        "Sequential Read calls on many files in the same directory burn input tokens per file. " +
        "Run a single Glob (or `ls -R`) first to map the tree, then read only the files that matter.",
      baseConfidence: 70,
    },
    {
      adviceType: "process",
      title: "Pack context with repomix before starting",
      description:
        "When you need broad codebase context, run `repomix --output repo.txt` once and pass " +
        "the packed output to the model instead of issuing dozens of individual Read calls.",
      baseConfidence: 65,
    },
    {
      adviceType: "process",
      title: "Ls-first then selective read",
      description:
        "A single Bash `find . -name '*.ts' | head -40` can surface all relevant paths in one " +
        "tool call. Use that list to decide which files need full reads, skipping the rest.",
      baseConfidence: 65,
    },
    {
      adviceType: "prompt",
      title: "Audit system prompt for large file injections",
      description:
        "High read-fanout often co-occurs with a large system prompt injecting many files. " +
        "Review CLAUDE.md hooks and memory injections — trim anything not needed for the current task.",
      baseConfidence: 60,
    },
  ],

  // ── test-loop ────────────────────────────────────────────────────────────────
  "test-loop": [
    {
      adviceType: "process",
      title: "Run tests in watch mode during active development",
      description:
        "Repeatedly calling `bun test` (or equivalent) manually re-runs the full suite each time. " +
        "Use watch mode (`bun test --watch`) so tests re-run automatically on file save.",
      baseConfidence: 70,
    },
    {
      adviceType: "process",
      title: "Add a pre-commit hook to gate test runs",
      description:
        "If you're running tests repeatedly to check correctness before committing, a pre-commit " +
        "hook (via Lefthook or Husky) automates this and removes the manual loop entirely.",
      baseConfidence: 65,
    },
    {
      adviceType: "process",
      title: "Narrow test scope to the failing file",
      description:
        "Running the full suite on every iteration wastes tokens on passing tests. " +
        "Pass a specific file path (`bun test src/foo.test.ts`) to focus the loop.",
      baseConfidence: 68,
    },
    {
      adviceType: "prompt",
      title: "Batch fixes before re-running tests",
      description:
        "Issuing a test run after every single-line fix multiplies round-trips and token cost. " +
        "Gather all known failing assertions, fix them in batch, then validate once.",
      baseConfidence: 62,
    },
  ],

  // ── manual-diff-cycle ────────────────────────────────────────────────────────
  "manual-diff-cycle": [
    {
      adviceType: "process",
      title: "Use MultiEdit to batch all edits in one tool call",
      description:
        "Alternating Read → Edit → Read on the same file re-reads unchanged context. " +
        "Consolidate every planned change into a single MultiEdit (or Edit) call to avoid re-reads.",
      baseConfidence: 72,
    },
    {
      adviceType: "process",
      title: "Commit between major iterations",
      description:
        "Without checkpoints, repeated edits to the same file compound diff noise. " +
        "Commit after each complete logical change so each iteration starts from a clean baseline.",
      baseConfidence: 65,
    },
    {
      adviceType: "process",
      title: "Read once, plan all edits, write once",
      description:
        "Read the full file at the start of the task, reason about all required changes in the " +
        "response text, then issue a single Write or MultiEdit. This eliminates re-read overhead.",
      baseConfidence: 68,
    },
    {
      adviceType: "prompt",
      title: "Checkpoint context after each major file change",
      description:
        "In long edit cycles the model accumulates stale copies of the file in its context window. " +
        "Summarize completed changes periodically to reclaim context budget.",
      baseConfidence: 60,
    },
  ],

  // ── grep-walk ────────────────────────────────────────────────────────────────
  "grep-walk": [
    {
      adviceType: "process",
      title: "Use ripgrep one-shot instead of iterative Grep+Read",
      description:
        "Chaining Grep calls with individual Reads is expensive. A single `rg 'pattern' --context 3` " +
        "returns surrounding lines inline, often making the follow-up Read unnecessary.",
      baseConfidence: 70,
    },
    {
      adviceType: "process",
      title: "Pack the codebase before wide-area search",
      description:
        "For exploratory searches spanning many directories, pack the repo with repomix first. " +
        "The packed output can be searched in a single pass without repeated Grep + Read pairs.",
      baseConfidence: 65,
    },
    {
      adviceType: "process",
      title: "Build a knowledge graph for semantic search",
      description:
        "If you're repeatedly searching for symbol usages (e.g. function definitions, imports), " +
        "a knowledge graph tool (gkg/graphify) resolves references directly without file walks.",
      baseConfidence: 62,
    },
    {
      adviceType: "prompt",
      title: "State the search goal before issuing Grep calls",
      description:
        "Iterative grep-walks often reflect an unclear search goal. Write down what you're " +
        "looking for in a reasoning block first — this often resolves the answer without file access.",
      baseConfidence: 60,
    },
  ],

  // ── subagent-skip ────────────────────────────────────────────────────────────
  "subagent-skip": [
    {
      adviceType: "process",
      title: "Delegate independent subtasks via the Task tool",
      description:
        "High tool-call volume in a single context suggests work that could be parallelized. " +
        "Use the Task tool to spawn isolated subagents for each independent subtask; " +
        "they run concurrently and keep context clean.",
      baseConfidence: 72,
    },
    {
      adviceType: "process",
      title: "Plan before executing",
      description:
        "Many tool calls are often the result of improvising without a plan. " +
        "Write a step-by-step plan in the reasoning block first, then execute — " +
        "this prevents redundant discovery calls.",
      baseConfidence: 68,
    },
    {
      adviceType: "prompt",
      title: "Pipe Bash results instead of sub-shelling",
      description:
        "Five or more Bash calls in the same turn often reduce to a single piped command. " +
        "Use pipes, xargs, or shell substitution (`$(...)`) to collapse sequential commands " +
        "into one tool call.",
      baseConfidence: 65,
    },
    {
      adviceType: "prompt",
      title: "Isolate context for each subagent",
      description:
        "Passing full session history to delegated tasks inflates their context needlessly. " +
        "Craft minimal prompts with only the files and facts the subagent requires.",
      baseConfidence: 62,
    },
  ],
};

// ── Prompt-level patterns (session-wide signals) ──────────────────────────────

/** Session-level prompt advice triggered by aggregate signals, not pattern type. */
export interface SessionPromptAdvice {
  /** Unique key for dedup. */
  key: string;
  /** Short label. */
  title: string;
  /** Explanation. */
  description: string;
  /** Fixed baseline confidence. */
  baseConfidence: number;
  /** Predicate: returns true when this advice applies to the session. */
  test(opts: { durationMs: number; cacheReadTokens: number; bashCallsPerTurn: number }): boolean;
}

export const SESSION_PROMPT_ADVICE: SessionPromptAdvice[] = [
  {
    key: "checkpoint-context",
    title: "Checkpoint context periodically in long sessions",
    description:
      "This session ran for over 6 hours. Long sessions accumulate stale context. " +
      "Summarize completed work periodically and start a fresh session for the next task.",
    baseConfidence: 65,
    test: ({ durationMs }) => durationMs > 6 * 3_600_000,
  },
  {
    key: "audit-memory-injections",
    title: "Audit memory injections — verbose system prompt suspected",
    description:
      "Cache read tokens exceeded 100M, which typically indicates a large system prompt " +
      "or CLAUDE.md memory injection. Review hooks and memory files; trim anything " +
      "not needed for the current task to reclaim context budget.",
    baseConfidence: 65,
    test: ({ cacheReadTokens }) => cacheReadTokens > 100_000_000,
  },
  {
    key: "pipe-bash-results",
    title: "Pipe Bash results — avoid repeated sub-shells per turn",
    description:
      "On average this session issued 5+ Bash calls per turn. Many of these can be " +
      "collapsed into a single piped command, saving round-trips and token overhead.",
    baseConfidence: 62,
    test: ({ bashCallsPerTurn }) => bashCallsPerTurn >= 5,
  },
];
