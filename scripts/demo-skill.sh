#!/usr/bin/env bash
# Asciinema demo: /ck:forensics skill invoked inside a Claude Code chat.
#
# Pixel-faithful simulation of Claude Code's TUI (box-drawn welcome, ●
# tool-call markers, ⎿ tool-output continuation, rounded prompt box).
# Output of every ckforensics call is REAL — only the chat UI is simulated.
#
# Usage:
#   asciinema rec docs/demo-skill.cast --command './scripts/demo-skill.sh' \
#     --rows 35 --cols 110 --title '/ck:forensics in Claude Code'

set -euo pipefail

# Pace knobs (seconds)
T_TYPE=0.045
T_THINK=1.6
T_BEAT=1.0

# Claude Code chat-UI palette
C_USER='\033[1;36m'
C_TOOL='\033[35m'
C_DIM='\033[2m'
C_OK='\033[1;32m'
C_BLUE='\033[38;5;75m'
C_BOX='\033[38;5;240m'
RESET='\033[0m'

# Box-drawing chars used by real CC
BOX_TL='╭' BOX_TR='╮' BOX_BL='╰' BOX_BR='╯' BOX_H='─' BOX_V='│'

repeat() { local c="$1" n="$2"; printf "%${n}s" '' | tr ' ' "$c"; }

box_line() {
  local body="$1" width=${2:-104}
  local pad=$((width - ${#body} - 2))
  ((pad < 0)) && pad=0
  printf "${C_BOX}${BOX_V}${RESET} %s%*s ${C_BOX}${BOX_V}${RESET}\n" "$body" "$pad" ""
}

box_top() { printf "${C_BOX}${BOX_TL}$(repeat "${BOX_H}" ${1:-106})${BOX_TR}${RESET}\n"; }
box_bottom() { printf "${C_BOX}${BOX_BL}$(repeat "${BOX_H}" ${1:-106})${BOX_BR}${RESET}\n"; }

# Render user prompt — types char-by-char inside the prompt box
type_prompt() {
  local text="$1" width=106
  box_top "$width"
  printf "${C_BOX}${BOX_V}${RESET} ${C_BLUE}>${RESET} "
  local typed=""
  for ((i = 0; i < ${#text}; i++)); do
    printf '%s' "${text:i:1}"
    typed+="${text:i:1}"
    sleep "$T_TYPE"
  done
  local pad=$((width - ${#text} - 4))
  ((pad < 0)) && pad=0
  printf "%*s ${C_BOX}${BOX_V}${RESET}\n" "$pad" ""
  box_bottom "$width"
  printf '\n'
  sleep 0.4
}

# Thinking indicator
thinking() {
  printf "${C_TOOL}✻${RESET} ${C_DIM}%s${RESET}\n\n" "${1:-Thinking…}"
  sleep "$T_THINK"
}

# Assistant text
assistant() { printf '%b\n\n' "$1"; sleep "$T_BEAT"; }

# Tool call header (Claude Code style: ● Bash(cmd) with cyan command)
tool_call() {
  local cmd="$1"
  printf "${C_TOOL}●${RESET} ${C_DIM}Bash${RESET}(${C_USER}%s${RESET})\n" "$cmd"
}

# Render real command output prefixed with ⎿ continuation marker on first line
tool_output() {
  local first=1
  while IFS= read -r line; do
    if (( first )); then
      printf "  ${C_DIM}⎿${RESET}  %s\n" "$line"
      first=0
    else
      printf "     %s\n" "$line"
    fi
  done
  printf '\n'
  sleep 0.8
}

clear

# ── Welcome box (real Claude Code style) ──────────────────────────────────────
box_top 106
box_line "${C_BLUE}✻${RESET} Welcome to Claude Code  ${C_DIM}v2.4.x  ·  Opus 4.7  ·  ckforensics 0.3.3 installed${RESET}" 106
box_line "" 106
box_line "${C_DIM}cwd:${RESET} /media/sandro8/GM/0.Work/ckforensics" 106
box_line "${C_DIM}skill:${RESET} ${C_USER}/ck:forensics${RESET}  ${C_DIM}(post-hoc session forensics + audit + review)${RESET}" 106
box_bottom 106
echo
sleep 1.8

# ── Turn 1 ────────────────────────────────────────────────────────────────────
type_prompt "show me my Claude Code token usage from the last 3 days"

thinking "Using /ck:forensics skill — running ingest + summary"

tool_call "ckforensics ingest"
ckforensics ingest 2>&1 | tool_output

tool_call "ckforensics summary --days 3"
ckforensics summary --days 3 2>&1 | tool_output

assistant "${C_OK}✔${RESET} Last 3 days: 9 sessions, 878M tokens (mostly cache reads), \$628 API-rate equivalent. You're on \$100 Max — value extracted ≈ 6.3×."

sleep 1.5

# ── Turn 2 ────────────────────────────────────────────────────────────────────
type_prompt "what changed in the last session? show the audit"

thinking "Auditing the most recent session…"

tool_call "ckforensics audit --last --format md"
ckforensics audit --last --format md 2>/dev/null | head -25 | tool_output

assistant "${C_OK}✔${RESET} 44 hunks across 12 files. Top file: ${C_USER}src/review/revert-engine.ts${RESET} (5 edits)."

sleep 1.5

# ── Turn 3 ────────────────────────────────────────────────────────────────────
type_prompt "let me review them hunk-by-hunk — what's reviewable?"

thinking "Generating review markdown via /ck:forensics review --emit"

tool_call "ckforensics review --last --emit /tmp/r.md"
ckforensics review --last --emit /tmp/r.md 2>&1 | tool_output

tool_call "head -25 /tmp/r.md"
head -25 /tmp/r.md | tool_output

assistant "${C_OK}✔${RESET} 32/44 hunks reviewable, 12 unreviewable (identical / unknown-before). Toggle ${C_USER}[x]${RESET} in /tmp/r.md, then run ${C_USER}ckforensics review --batch --decisions /tmp/r.md${RESET}."

sleep 2.5

# ── Outro ──────────────────────────────────────────────────────────────────────
echo
printf "${C_DIM}One install. Terminal CLI ${BOX_V} Claude Code skill ${BOX_V} same data.${RESET}\n"
printf "${C_DIM}github.com/phong28zk/ckforensics${RESET}\n"
echo
sleep 2.5
