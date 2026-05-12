/**
 * CLI command: hook install | uninstall | status
 *
 * Manages the Claude Code Stop hook that auto-triggers `ckforensics review`
 * after every session ends. Writes to `~/.claude/settings.json` (created if
 * missing) without touching other user-configured hooks.
 *
 * Hook fires headless (no TTY), so default behaviour is to emit a markdown
 * review file the user can open in their editor. Optional `--exec` lets the
 * user wire it to `code <path>` or similar.
 */

import type { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { homedir } from "node:os";
import { bold, dim, green, yellow, red, cyan } from "../color.ts";

const SETTINGS_PATH = resolvePath(homedir(), ".claude", "settings.json");
const REVIEW_OUT_DEFAULT = "~/.cache/ckforensics/last-review.md";
/** Sentinel comment used to detect a ckforensics-managed hook entry. */
export const HOOK_TAG = "managed-by:ckforensics";

interface HookOptions {
  exec?: string;
  outPath?: string;
}

export interface ClaudeSettings {
  hooks?: {
    Stop?: Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; comment?: string }>;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── Pure transformations (testable) ───────────────────────────────────────────

/** Insert the ckforensics-managed Stop hook into a settings object (idempotent). */
export function installManagedHook(
  settings: ClaudeSettings,
  command: string
): ClaudeSettings {
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];

  // Remove any prior managed entry first
  for (const entry of settings.hooks.Stop) {
    entry.hooks = (entry.hooks ?? []).filter((h) => !isManaged(h));
  }
  settings.hooks.Stop = settings.hooks.Stop.filter((e) => (e.hooks ?? []).length > 0);

  settings.hooks.Stop.push({
    matcher: "",
    hooks: [{ type: "command", command, comment: HOOK_TAG }],
  });
  return settings;
}

/** Strip ckforensics-managed Stop hooks; returns count removed. */
export function uninstallManagedHook(settings: ClaudeSettings): number {
  if (!settings.hooks?.Stop) return 0;
  let removed = 0;
  for (const entry of settings.hooks.Stop) {
    const before = entry.hooks?.length ?? 0;
    entry.hooks = (entry.hooks ?? []).filter((h) => !isManaged(h));
    removed += before - (entry.hooks?.length ?? 0);
  }
  settings.hooks.Stop = settings.hooks.Stop.filter((e) => (e.hooks ?? []).length > 0);
  return removed;
}

/** Determine whether a hook entry was authored by ckforensics. */
export function isManaged(h: { command: string; comment?: string }): boolean {
  return h.comment === HOOK_TAG || h.command.includes("ckforensics review --last --emit");
}

/** Build the shell command string the hook will run. */
export function buildHookCommand(outPath: string, exec?: string): string {
  const expanded = expandHome(outPath);
  const parts = [
    `mkdir -p "$(dirname '${expanded}')"`,
    `ckforensics ingest >/dev/null 2>&1 || true`,
    `ckforensics review --last --emit '${expanded}' >/dev/null 2>&1 || true`,
  ];
  if (exec) parts.push(exec.replace(/\{path\}/g, expanded));
  return parts.join(" && ");
}

export function registerHookCommand(program: Command): void {
  const cmd = program.command("hook").description("Manage Claude Code auto-review Stop hook");

  cmd
    .command("install")
    .description("Install the ckforensics Stop hook into ~/.claude/settings.json")
    .option("--exec <cmd>", "command to run after emit (e.g. 'code {path}')")
    .option("--out-path <file>", "where review.md is written", REVIEW_OUT_DEFAULT)
    .action((opts: HookOptions) => runInstall(opts));

  cmd
    .command("uninstall")
    .description("Remove the ckforensics Stop hook from ~/.claude/settings.json")
    .action(() => runUninstall());

  cmd
    .command("status")
    .description("Show whether the ckforensics Stop hook is installed")
    .action(() => runStatus());
}

// ── Subcommand implementations ────────────────────────────────────────────────

function runInstall(opts: HookOptions): void {
  const settings = readSettings();
  const outPath = opts.outPath ?? REVIEW_OUT_DEFAULT;
  const command = buildHookCommand(outPath, opts.exec);
  installManagedHook(settings, command);
  writeSettings(settings);
  process.stdout.write(green("✔ Installed ckforensics Stop hook\n"));
  process.stdout.write(dim(`  Hook: ${command}\n`));
  process.stdout.write(dim(`  Settings: ${SETTINGS_PATH}\n`));
  process.stdout.write(
    `\nNext Claude Code session that ends will write ${cyan(expandHome(outPath))}.\n`
  );
}

function runUninstall(): void {
  const settings = readSettings();
  if (!settings.hooks?.Stop) {
    process.stdout.write(yellow("No Stop hooks configured.\n"));
    return;
  }
  const removed = uninstallManagedHook(settings);
  writeSettings(settings);
  if (removed > 0) {
    process.stdout.write(green(`✔ Removed ${removed} ckforensics hook entry(ies).\n`));
  } else {
    process.stdout.write(yellow("No ckforensics-managed hook found.\n"));
  }
}

function runStatus(): void {
  const settings = readSettings();
  const stop = settings.hooks?.Stop ?? [];
  const managed = stop.flatMap((e) => (e.hooks ?? []).filter(isManaged));
  if (managed.length === 0) {
    process.stdout.write(yellow("✗ Not installed.\n"));
    process.stdout.write(`Run ${cyan("ckforensics hook install")} to enable auto-review.\n`);
    process.exit(1);
  }
  process.stdout.write(green("✔ Installed.\n"));
  for (const h of managed) {
    process.stdout.write(`  ${dim("Command:")} ${h.command}\n`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2));
  return p;
}

function readSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw) as ClaudeSettings;
  } catch (e) {
    process.stderr.write(red(`Error reading ${SETTINGS_PATH}: ${e}\n`));
    process.exit(2);
  }
}

function writeSettings(settings: ClaudeSettings): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
