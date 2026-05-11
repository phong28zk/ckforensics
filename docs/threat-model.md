# Threat Model

## Stance

ckforensics is **local-first, read-only, no telemetry**. We process your Claude Code transcripts. Those transcripts may contain secrets, proprietary code, credentials. We treat them as sensitive by default.

## What ckforensics does NOT do

- ❌ No network calls during normal operation (`ingest`, `summary`, `audit`, `export`, `redact`, `doctor`, `path`, `sessions`)
- ❌ No telemetry, analytics, or "phone home"
- ❌ No code execution from JSONL content (we only parse JSON, never eval)
- ❌ No automatic uploads
- ❌ No third-party API calls

## The single network exception

`scripts/postinstall.js` downloads a prebuilt binary from this project's **GitHub Releases** when installed via npm. Verified via SHA256 against the published checksum. Skip with `CKFORENSICS_SKIP_DOWNLOAD=1`. Source repo (with `.git` present) skips by default.

## Local storage

- SQLite DB at XDG-compliant path (`~/.local/share/ckforensics/store.db` on Linux)
- Created with permissions **0600** on Unix (owner read/write only)
- Contains parsed events including `raw_json` of each transcript line

If multiple users share a host, each user has their own DB.

## Redaction

`src/privacy/redaction-rules.ts` ships 9 built-in patterns:

| Rule | Matches |
|------|---------|
| `ANT_KEY` | Anthropic `sk-ant-*` keys |
| `GH_TOKEN` | GitHub `ghp_`, `gho_`, `ghs_` tokens |
| `GH_FINE` | GitHub fine-grained `github_pat_*` |
| `AWS_KEY` | AWS access key IDs `AKIA*` |
| `AWS_SECRET` | AWS secret access keys (40-char base64) |
| `SLACK_TOKEN` | Slack `xox[bp]-*` tokens |
| `JWT` | 3-segment base64 JSON Web Tokens |
| `PEM_KEY` | PEM-encoded private keys |
| `HIGH_ENTROPY` | Generic high-entropy strings ≥32 chars adjacent to assignment punctuation |

**Redaction is best-effort.** It will miss:
- Secrets in unusual formats (custom token shapes)
- Secrets embedded in URLs, JSON, or escaped strings without adjacency cues
- Secrets transformed (base64, URL-encoded)
- Domain-specific identifiers (employee IDs, internal hostnames)

**Always review** exports before sharing externally. `redact` is a tool, not a guarantee.

## Data flow

```
~/.claude/projects/**/*.jsonl    (your data, read-only)
            │
            ▼
   parsers + store               (transform + persist locally)
            │
            ▼
   queries / audit               (analyze)
            │
            ▼ (only if user runs --out or `export`)
   exporters                     (redact then write to user-specified path)
```

Nothing leaves the machine unless **you** redirect output.

## Supply chain

- **Source**: published on GitHub, open under MIT
- **Binaries**: built in GitHub Actions on tag push; SHA256 checksums published with each release
- **Signing** (future v1.1): cosign keyless via GitHub OIDC — provides supply-chain attestation without paid certs
- **Dependencies**: minimal. Runtime: Bun stdlib + `commander`. No native modules outside what Bun ships.
- **Dependabot**: enabled (will be configured in `.github/dependabot.yml` post-v0.1)

## Threats considered

| Threat | Mitigation |
|--------|------------|
| Malicious crafted JSONL crashes parser | Streaming parser bucket unknowns; classifier never `eval`s |
| DB tampering by other local user | 0600 permissions; user's responsibility to secure home dir |
| Redacted export still contains secrets | Documented as best-effort; users warned before publish |
| Binary swap during postinstall | SHA256 verification against release checksum |
| Schema change breaks ingest | Versioned reducer; unknown event bucket; non-fatal |

## What this tool can't protect you from

- Compromised host (OS-level malware) — out of scope
- Coercion / forensic recovery from disk — out of scope
- You uploading the DB or transcripts somewhere yourself — out of scope

## Reporting vulnerabilities

Open a private security advisory via GitHub: Settings → Security → Report a vulnerability. Or email maintainer via GitHub profile. We aim to triage within 7 days.

## Audit invitation

The codebase is small enough to audit by hand. Start with `src/cli/index.ts` → `src/store/db.ts` → `src/privacy/redactor.ts`. If you find a leak path, please report.
