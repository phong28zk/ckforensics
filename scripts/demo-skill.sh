#!/usr/bin/env bash
# Scripted asciinema demo: /ck:forensics skill invoked from Claude Code chat.
#
# Simulates Claude Code's chat UI (prompt + skill activation + tool call) and
# then runs the real ckforensics command so output is genuine.
#
# Usage:
#   asciinema rec docs/demo-skill.cast --command './scripts/demo-skill.sh' \
#     --rows 35 --cols 110 --title 'ckforensics — /ck:forensics skill demo'

set -euo pipefail

# Pace knobs
T_TYPE=0.045
T_BEAT=1.0
T_THINK=1.6

# Claude Code chat-UI colors
CC_PROMPT='\033[1;36m'   # cyan ">"
CC_USER='\033[1;37m'     # bright white user text
CC_TOOL='\033[35m'       # magenta tool labels
CC_DIM='\033[2m'         # dim narration
CC_OK='\033[1;32m'       # green success
RESET='\033[0m'

type_user() {
  local text="$1"
  printf "${CC_PROMPT}> ${RESET}"
  for ((i = 0; i < ${#text}; i++)); do
    printf "${CC_USER}%s${RESET}" "${text:i:1}"
    sleep "$T_TYPE"
  done
  printf '\n\n'
  sleep 0.4
}

claude_say() {
  printf '%b\n\n' "$1"
  sleep "$T_BEAT"
}

tool_call() {
  printf "${CC_TOOL}● ${RESET}${CC_DIM}%s${RESET}\n\n" "$1"
  sleep 0.7
}

clear

# ── Header ─────────────────────────────────────────────────────────────────────
printf '%b\n' "${CC_DIM}Claude Code v2.4 · session #abc1234 · /ck:forensics skill installed${RESET}"
printf '%b\n\n' "${CC_DIM}────────────────────────────────────────────────────────────${RESET}"
sleep 1.5

# ── Turn 1: invoke skill ───────────────────────────────────────────────────────
type_user "/ck:forensics summary"

printf '%b\n' "${CC_TOOL}● Skill: /ck:forensics${RESET} ${CC_DIM}(ckforensics@0.3.3)${RESET}"
sleep "$T_THINK"
claude_say "I'll pull your last 7 days of Claude Code usage."

tool_call "Bash: ckforensics summary --days 7"
ckforensics summary --days 7
sleep "$T_BEAT"

claude_say "${CC_OK}✔${RESET} 19 sessions · 967M tokens · \$733 (API-rate equivalent — you're on the \$100 Max plan, so this is value extracted, not billed)."

sleep 2

# ── Turn 2: drill into last session ────────────────────────────────────────────
type_user "what did Claude touch in the last session?"

printf '%b\n' "${CC_TOOL}● Skill: /ck:forensics${RESET}"
sleep "$T_THINK"
claude_say "Auditing the most recent session — change manifest + reasoning trail."

tool_call "Bash: ckforensics audit --last --format md | head -40"
ckforensics audit --last --format md 2>/dev/null | head -40
sleep "$T_BEAT"

claude_say "${CC_OK}✔${RESET} 44 hunks across 12 files. Want me to open the hunk-by-hunk review (TUI)?"

sleep 2

# ── Turn 3: review preview ─────────────────────────────────────────────────────
type_user "show me what's reviewable"

printf '%b\n' "${CC_TOOL}● Skill: /ck:forensics${RESET}"
sleep "$T_THINK"

tool_call "Bash: ckforensics review --last --emit /tmp/preview.md && head -30 /tmp/preview.md"
ckforensics review --last --emit /tmp/preview.md 2>&1 | head -3
echo
head -25 /tmp/preview.md
sleep 2.5

claude_say "${CC_OK}✔${RESET} 32 hunks reviewable · 12 unreviewable. Toggle ${CC_USER}[x]${RESET} in your editor, then ${CC_USER}ckforensics review --batch --decisions${RESET} to apply."

# ── Outro ──────────────────────────────────────────────────────────────────────
echo
printf '%b\n' "${CC_DIM}────────────────────────────────────────────────────────────${RESET}"
printf '%b\n' "${CC_DIM}One tool. CLI for terminal. Skill for Claude Code. Same data.${RESET}"
printf '%b\n' "${CC_DIM}github.com/phong28zk/ckforensics${RESET}"
echo
sleep 2.5
