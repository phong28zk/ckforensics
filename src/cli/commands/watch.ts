/**
 * CLI command: watch [--idle SECONDS] [--exec CMD] [--out-path FILE]
 *
 * Poll Claude Code's JSONL session files; when the active session goes idle
 * (no new bytes for `--idle` seconds), automatically run ingest + emit a
 * review markdown, then optionally exec a follow-up command (e.g. `code <path>`).
 *
 * Lighter alternative to the Stop hook: works without modifying settings.json,
 * useful when running ckforensics as a long-lived background process.
 *
 * Stop with Ctrl-C. No persistent state — safe to restart.
 */

import type { Command } from "commander";
import { statSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve as resolvePath, dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { bold, dim, green, yellow, cyan } from "../color.ts";

interface WatchOptions {
  idle: string;
  exec?: string;
  outPath: string;
  pollInterval: string;
  once: boolean;
}

const DEFAULT_OUT = "~/.cache/ckforensics/last-review.md";
const JSONL_ROOT = resolvePath(homedir(), ".claude", "projects");

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Poll for session-end, then auto-emit a review markdown")
    .option("--idle <seconds>", "trigger after this many idle seconds", "30")
    .option("--exec <cmd>", "command to run after emit; {path} substituted")
    .option("--out-path <file>", "review markdown destination", DEFAULT_OUT)
    .option("--poll-interval <ms>", "filesystem poll interval", "2000")
    .option("--once", "exit after the first trigger fires", false)
    .action(async (opts: WatchOptions) => {
      await runWatch(opts);
    });
}

async function runWatch(opts: WatchOptions): Promise<void> {
  const idleMs = Math.max(5_000, Number(opts.idle) * 1000);
  const pollMs = Math.max(500, Number(opts.pollInterval));
  const outPath = expandHome(opts.outPath);

  if (!existsSync(JSONL_ROOT)) {
    process.stderr.write(`Error: ${JSONL_ROOT} does not exist (no Claude sessions yet).\n`);
    process.exit(1);
  }

  process.stdout.write(bold("ckforensics watch") + "\n");
  process.stdout.write(dim(`  Watching: ${JSONL_ROOT}\n`));
  process.stdout.write(dim(`  Idle threshold: ${idleMs / 1000}s\n`));
  process.stdout.write(dim(`  Emit to: ${outPath}\n`));
  if (opts.exec) process.stdout.write(dim(`  Exec: ${opts.exec}\n`));
  process.stdout.write(dim("  Press Ctrl-C to stop.\n\n"));

  let lastTriggeredMtime = 0;

  while (true) {
    const latest = findLatestJsonl(JSONL_ROOT);
    if (latest && Date.now() - latest.mtimeMs >= idleMs && latest.mtimeMs > lastTriggeredMtime) {
      lastTriggeredMtime = latest.mtimeMs;
      await trigger(latest, outPath, opts.exec);
      if (opts.once) return;
    }
    await sleep(pollMs);
  }
}

interface JsonlFile {
  path: string;
  mtimeMs: number;
}

/** Recursively find the most recently modified .jsonl under root. */
function findLatestJsonl(root: string): JsonlFile | null {
  let latest: JsonlFile | null = null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (st.isFile() && name.endsWith(".jsonl")) {
        if (!latest || st.mtimeMs > latest.mtimeMs) {
          latest = { path: p, mtimeMs: st.mtimeMs };
        }
      }
    }
  }
  return latest;
}

async function trigger(latest: JsonlFile, outPath: string, exec?: string): Promise<void> {
  const ts = new Date().toISOString();
  process.stdout.write(`${green("●")} ${ts} session idle detected (${cyan(latest.path)})\n`);

  mkdirSync(dirname(outPath), { recursive: true });

  // Run ckforensics ingest + review --last --emit. Use the same binary if
  // available on PATH; fall back to invoking via Bun for dev contexts.
  const cli = process.env["CKFORENSICS_BIN"] ?? "ckforensics";
  const ingestOk = await runChild(cli, ["ingest"]);
  if (!ingestOk) {
    process.stdout.write(yellow("  ingest failed, skipping emit\n"));
    return;
  }
  const emitOk = await runChild(cli, ["review", "--last", "--emit", outPath]);
  if (!emitOk) {
    process.stdout.write(yellow("  emit failed\n"));
    return;
  }
  process.stdout.write(`  ${dim("wrote")} ${outPath}\n`);

  if (exec) {
    const cmd = exec.replace(/\{path\}/g, outPath);
    process.stdout.write(`  ${dim("exec:")} ${cmd}\n`);
    await runChild("sh", ["-c", cmd]);
  }
}

function runChild(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2));
  return p;
}
