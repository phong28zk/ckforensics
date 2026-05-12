#!/usr/bin/env bash
# Scripted asciinema demo for ckforensics.
#
# Usage:
#   asciinema rec docs/demo.cast --command './scripts/demo.sh' --rows 35 --cols 110
#
# Designed to render cleanly at 110x35. Adjust SLEEP_* values to taste.

set -euo pipefail

# Pace knobs (seconds)
SLEEP_TYPE=0.04     # per-char typing simulation
SLEEP_PROMPT=1.2    # between commands
SLEEP_OUTPUT=2.0    # after long output

# Colors for typed prompt line
PROMPT_COLOR='\033[1;36m'
RESET='\033[0m'

type_cmd() {
  local cmd="$1"
  printf "${PROMPT_COLOR}\$${RESET} "
  for ((i = 0; i < ${#cmd}; i++)); do
    printf '%s' "${cmd:i:1}"
    sleep "$SLEEP_TYPE"
  done
  printf '\n'
  sleep 0.3
}

run() {
  type_cmd "$1"
  eval "$1"
  sleep "$SLEEP_PROMPT"
}

clear

# ── Intro ──────────────────────────────────────────────────────────────────────
echo "# ckforensics — Forensic CLI for Claude Code sessions"
echo "# This demo: ingest → summary → review (Copilot-style hunk-by-hunk)"
echo
sleep 2

# ── 1. Ingest ──────────────────────────────────────────────────────────────────
run "ckforensics ingest"
sleep "$SLEEP_OUTPUT"

# ── 2. Summary ─────────────────────────────────────────────────────────────────
run "ckforensics summary --days 7"
sleep "$SLEEP_OUTPUT"

# ── 3. Review --emit (markdown round-trip preview) ─────────────────────────────
run "ckforensics review --last --emit /tmp/review.md"
sleep 1

run "head -20 /tmp/review.md"
sleep "$SLEEP_OUTPUT"

# ── 4. Batch dry-run ───────────────────────────────────────────────────────────
run "ckforensics review --batch --decisions /tmp/review.md --dry-run --allow-dirty"
sleep "$SLEEP_OUTPUT"

# ── 5. Auto-trigger setup ──────────────────────────────────────────────────────
echo
echo "# Want this to run automatically after every Claude session?"
sleep 1.5
run "ckforensics hook install --exec 'code {path}'"
sleep "$SLEEP_OUTPUT"
run "ckforensics hook status"
sleep "$SLEEP_OUTPUT"

# ── Outro ──────────────────────────────────────────────────────────────────────
echo
echo "# More: github.com/phong28zk/ckforensics"
echo "# Skill:  /ck:forensics (bundled with this install)"
echo
sleep 2
