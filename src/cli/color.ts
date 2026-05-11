/**
 * ANSI color utilities for CLI output.
 *
 * Respects --no-color flag and NO_COLOR env var (https://no-color.org/).
 * All callers check isColorEnabled() before applying codes.
 */

let _colorEnabled: boolean | null = null;

/** Check if color output is enabled (env + flag). */
export function isColorEnabled(): boolean {
  if (_colorEnabled !== null) return _colorEnabled;
  // NO_COLOR env var disables color regardless of flags
  if (process.env["NO_COLOR"] !== undefined) return (_colorEnabled = false);
  // FORCE_COLOR overrides --no-color
  if (process.env["FORCE_COLOR"]) return (_colorEnabled = true);
  // Default: enabled if stdout is a TTY
  return (_colorEnabled = process.stdout.isTTY ?? true);
}

/** Disable color output (called by --no-color flag). */
export function disableColor(): void {
  _colorEnabled = false;
}

/** Reset color state (used in tests). */
export function resetColorState(): void {
  _colorEnabled = null;
}

const c = (code: string) => (s: string) =>
  isColorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = c("1");
export const dim = c("2");
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const blue = c("34");
export const cyan = c("36");
export const gray = c("90");
