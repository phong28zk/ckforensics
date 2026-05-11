#!/usr/bin/env python3
"""
session-overview.py — One-shot session report for ck:forensics skill.

Runs multiple `ckforensics` CLI commands and stitches a single JSON
report. Saves Claude from chaining 4-5 Bash calls when answering
"summarize this session" prompts.

Usage:
    python3 session-overview.py [--session-id ID] [--days N]
    python3 session-overview.py --last           # default — most recent session

Output: JSON on stdout with shape:
    {
      "schema": "ck-forensics-overview-v1",
      "generatedAt": "ISO8601",
      "scope": {"sessionId": "...", "days": 7, "lastOnly": true},
      "summary":   { ... },     # `ckforensics summary --json` data
      "session":   { ... },     # one row from `ckforensics sessions --json`
      "audit":     { ... },     # `ckforensics audit --json` (manifest)
      "suggest":   [ ... ],     # top recs from `ckforensics suggest --json`
      "map":       { ... }      # context map heatmap
    }

Errors are reported as {"schema": "error", "error": "..."} with exit 1.

Stdlib only — no third-party deps required. Compatible with Python 3.8+.
"""

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone


def check_cli_installed() -> None:
    """Verify ckforensics CLI is on PATH; exit 1 with clear error if not."""
    if shutil.which("ckforensics") is None:
        emit_error(
            "ckforensics CLI not installed. "
            "Install with: npm i -g ckforensics"
        )
        sys.exit(1)


def run_cli(args: list) -> dict:
    """
    Run `ckforensics <args>` with --json and return parsed output.
    Raises CalledProcessError on non-zero exit (caller decides whether to ignore).
    """
    cmd = ["ckforensics", *args, "--json"]
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if result.returncode != 0:
        # Many subcommands exit 3 when no data — return empty rather than fail
        if result.returncode == 3:
            return {}
        raise subprocess.CalledProcessError(
            result.returncode, cmd, result.stdout, result.stderr
        )
    return json.loads(result.stdout) if result.stdout.strip() else {}


def emit_error(msg: str) -> None:
    """Write error envelope to stdout."""
    print(json.dumps({"schema": "error", "error": msg}), flush=True)


def collect_overview(session_id: str | None, days: int, last: bool) -> dict:
    """Gather all sections; failures in individual sections become null."""
    overview = {
        "schema": "ck-forensics-overview-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": {"sessionId": session_id, "days": days, "lastOnly": last},
        "summary": None,
        "session": None,
        "audit": None,
        "suggest": None,
        "map": None,
    }

    # 1. Summary — rolling window
    try:
        overview["summary"] = run_cli(["summary", "--days", str(days)]).get("data")
    except Exception as e:
        overview["summary"] = {"error": str(e)}

    # 2. Session metadata — pick from list or by id
    try:
        sessions_envelope = run_cli(["sessions", "--limit", "1"])
        sessions = sessions_envelope.get("data", [])
        if session_id:
            # Filter to specific session if requested
            sessions = [s for s in sessions if s.get("id") == session_id]
        overview["session"] = sessions[0] if sessions else None
    except Exception as e:
        overview["session"] = {"error": str(e)}

    # 3. Audit manifest — uses --last unless explicit id given
    audit_args = ["audit", "--last"] if last or not session_id else ["audit", session_id]
    try:
        overview["audit"] = run_cli(audit_args)
    except Exception as e:
        overview["audit"] = {"error": str(e)}

    # 4. Suggest — same scope as audit
    suggest_args = ["suggest", "--last", "--min-confidence", "30", "--top", "3"]
    if session_id and not last:
        suggest_args = ["suggest", "--session", session_id, "--min-confidence", "30", "--top", "3"]
    try:
        overview["suggest"] = run_cli(suggest_args).get("data", [])
    except Exception as e:
        overview["suggest"] = {"error": str(e)}

    # 5. Map — top-10 heatmap categories
    map_args = ["map", "--last", "--top", "10"]
    if session_id and not last:
        map_args = ["map", session_id, "--top", "10"]
    try:
        overview["map"] = run_cli(map_args).get("data")
    except Exception as e:
        overview["map"] = {"error": str(e)}

    return overview


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="session-overview",
        description="Unified session report — runs multiple ckforensics commands and merges output.",
    )
    p.add_argument("--session-id", help="Explicit session UUID (defaults to --last)")
    p.add_argument("--days", type=int, default=7, help="Summary window in days (default 7)")
    p.add_argument(
        "--last",
        action="store_true",
        default=True,
        help="Use most recent session (default behavior)",
    )
    return p.parse_args()


def main() -> int:
    check_cli_installed()
    args = parse_args()
    last = args.last and not args.session_id

    try:
        overview = collect_overview(args.session_id, args.days, last)
        print(json.dumps(overview, indent=2, default=str))
        return 0
    except Exception as e:
        emit_error(f"unexpected error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
