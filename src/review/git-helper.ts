/**
 * Thin wrappers around the `git` CLI for the revert-engine.
 *
 * Why subprocess and not a JS git library?
 *   - `git apply` is battle-tested; reimplementing 3-way patch logic is risky.
 *   - We already require git for `gh`-style workflows; no new runtime dep.
 *
 * All calls use `Bun.spawn`. Errors are converted into typed return values rather
 * than thrown — callers branch on `ok` to avoid try/catch ceremony.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Detect whether `cwd` (or any ancestor) is a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await run(["git", "rev-parse", "--is-inside-work-tree"], { cwd });
  return r.ok && r.stdout.trim() === "true";
}

/**
 * Run `git apply [--reverse] [--check]` with patch supplied on stdin.
 * Returns ok=true only when exit code is 0.
 */
export async function gitApply(
  patch: string,
  opts: { cwd: string; reverse?: boolean; check?: boolean }
): Promise<GitResult> {
  const args = ["git", "apply"];
  if (opts.reverse) args.push("--reverse");
  if (opts.check) args.push("--check");
  // `--unidiff-zero` is intentionally omitted: we always emit ≥3 lines of context
  // so default fuzz behaviour is appropriate.
  return run(args, { cwd: opts.cwd, stdin: patch });
}

/**
 * `git status --porcelain=v1 -- <files>` parsed into a Map of path → 2-char code.
 *
 * Codes (per `git status` manual):
 *   "??" untracked
 *   " M" unstaged modification
 *   "M " staged modification
 *   "MM" both staged and unstaged modifications
 *   etc.
 *
 * Returns an empty map when none of the requested files have any status (i.e. clean).
 */
export async function getStatusPorcelain(
  cwd: string,
  paths: string[]
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const r = await run(["git", "status", "--porcelain=v1", "--", ...paths], { cwd });
  const out = new Map<string, string>();
  if (!r.ok) return out;
  for (const raw of r.stdout.split("\n")) {
    if (raw.length < 4) continue;
    const code = raw.slice(0, 2);
    const path = raw.slice(3);
    out.set(path, code);
  }
  return out;
}

// ── Internal runner ───────────────────────────────────────────────────────────

interface RunOpts {
  cwd?: string;
  stdin?: string;
}

async function run(argv: string[], opts: RunOpts = {}): Promise<GitResult> {
  try {
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const code = proc.exitCode ?? 0;
    return { ok: code === 0, stdout, stderr, exitCode: code };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e), exitCode: -1 };
  }
}
