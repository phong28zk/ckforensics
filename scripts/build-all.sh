#!/usr/bin/env bash
# build-all.sh — Cross-platform binary compilation for ckforensics.
#
# Builds Bun single-file executables for 5 targets and emits SHA256 checksums.
# Designed to run on macOS and Linux (POSIX-compatible, no GNU-only flags).
#
# Usage: ./scripts/build-all.sh [--current-only]
#   --current-only   Build only the binary matching this host's platform/arch.

set -euo pipefail

ENTRY="src/cli/index.ts"
OUTDIR="dist"
CHECKSUMS_FILE="${OUTDIR}/checksums.txt"

# ── Helpers ───────────────────────────────────────────────────────────────────

log() { printf '\033[1;34m[build]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# sha256 that works on both macOS (shasum) and Linux (sha256sum)
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    err "No sha256sum or shasum found — cannot compute checksums"
  fi
}

human_size() {
  local bytes
  bytes=$(wc -c < "$1" | tr -d ' ')
  if [ "$bytes" -ge 1048576 ]; then
    printf '%dMB' "$(( bytes / 1048576 ))"
  else
    printf '%dKB' "$(( bytes / 1024 ))"
  fi
}

# ── Detect current platform ───────────────────────────────────────────────────

detect_current_target() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case "${os}-${arch}" in
    Linux-x86_64)   echo "bun-linux-x64"    ;;
    Linux-aarch64)  echo "bun-linux-arm64"  ;;
    Darwin-x86_64)  err "Intel Mac builds not officially shipped — build from source or open an issue" ;;
    Darwin-arm64)   echo "bun-darwin-arm64" ;;
    MINGW*|CYGWIN*|MSYS*) echo "bun-windows-x64" ;;
    *) err "Unsupported platform: ${os}-${arch}" ;;
  esac
}

# ── Target definitions ─────────────────────────────────────────────────────────
# Format: "bun-target:outfile"
TARGETS=(
  "bun-linux-x64:ckforensics-linux-x64"
  "bun-linux-arm64:ckforensics-linux-arm64"
  "bun-darwin-arm64:ckforensics-darwin-arm64"
  "bun-windows-x64:ckforensics-win-x64.exe"
)

# ── Parse args ────────────────────────────────────────────────────────────────

CURRENT_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --current-only) CURRENT_ONLY=true ;;
    *) err "Unknown argument: $arg" ;;
  esac
done

if $CURRENT_ONLY; then
  current_target=$(detect_current_target)
  log "Building current platform only: ${current_target}"
fi

# ── Preflight checks ──────────────────────────────────────────────────────────

command -v bun >/dev/null 2>&1 || err "bun not found — install from https://bun.sh"
[ -f "$ENTRY" ] || err "Entry point not found: $ENTRY"

log "Creating output directory: ${OUTDIR}"
mkdir -p "${OUTDIR}"

# Clear old checksums
: > "${CHECKSUMS_FILE}"

# ── Build loop ────────────────────────────────────────────────────────────────

BUILT=0
SKIPPED=0
declare -a SIZE_ROWS

for spec in "${TARGETS[@]}"; do
  bun_target="${spec%%:*}"
  outname="${spec##*:}"
  outfile="${OUTDIR}/${outname}"

  if $CURRENT_ONLY && [ "$bun_target" != "$current_target" ]; then
    log "Skipping ${bun_target} (--current-only)"
    SKIPPED=$(( SKIPPED + 1 ))
    continue
  fi

  log "Building ${bun_target} → ${outfile}"

  if bun build \
      --compile \
      --target="${bun_target}" \
      "${ENTRY}" \
      --outfile "${outfile}" 2>&1; then

    checksum=$(sha256_file "${outfile}")
    size=$(human_size "${outfile}")

    printf '%s  %s\n' "$checksum" "$outname" >> "${CHECKSUMS_FILE}"
    SIZE_ROWS+=("${outname}|${size}|${checksum:0:16}...")
    ok "Built ${outfile} (${size})"
    BUILT=$(( BUILT + 1 ))
  else
    printf '\033[1;33m[warn]\033[0m Cross-compile failed for %s — skipping (will succeed on CI)\n' "$bun_target"
    SKIPPED=$(( SKIPPED + 1 ))
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────

printf '\n'
printf '%-40s %-8s %-20s\n' "Binary" "Size" "SHA256 (first 16)"
printf '%-40s %-8s %-20s\n' "------" "----" "------------------"
for row in "${SIZE_ROWS[@]}"; do
  name="${row%%|*}"
  rest="${row#*|}"
  sz="${rest%%|*}"
  cksum="${rest##*|}"
  printf '%-40s %-8s %-20s\n' "$name" "$sz" "$cksum"
done

printf '\nBuilt: %d  Skipped: %d\n' "$BUILT" "$SKIPPED"
[ -s "${CHECKSUMS_FILE}" ] && printf 'Checksums: %s\n' "${CHECKSUMS_FILE}"

log "Done."
