/**
 * Built-in redaction rules: regex patterns for common secrets.
 *
 * Each rule has:
 *   - id:      short label used in [REDACTED:ID] placeholder
 *   - pattern: RegExp with global flag (required for replaceAll semantics)
 *   - description: human-readable explanation
 *
 * Pattern sources: gitleaks ruleset + Anthropic / GitHub / AWS / Slack conventions.
 *
 * WARNING: Redaction is best-effort. Users MUST verify output before sharing.
 */

export interface RedactionRule {
  /** Short label used in placeholder: [REDACTED:ID] */
  id: string;
  /** Must have the global flag set. */
  pattern: RegExp;
  description: string;
}

/**
 * Default built-in redaction rules, ordered from most specific to least.
 * Apply in order: earlier rules shadow overlapping patterns from later ones.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  // ── Anthropic API keys ──────────────────────────────────────────────────────
  {
    id: "ANT_KEY",
    pattern: /sk-ant-(?:api03-)?[A-Za-z0-9_\-]{32,}/g,
    description: "Anthropic API key (sk-ant-...)",
  },

  // ── GitHub tokens ───────────────────────────────────────────────────────────
  {
    id: "GH_TOKEN",
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    description: "GitHub personal access / OAuth / refresh / server token",
  },
  {
    id: "GH_FINE",
    pattern: /github_pat_[A-Za-z0-9_]{82}/g,
    description: "GitHub fine-grained personal access token",
  },

  // ── AWS credentials ─────────────────────────────────────────────────────────
  {
    id: "AWS_KEY",
    pattern: /AKIA[0-9A-Z]{16}/g,
    description: "AWS access key ID",
  },
  {
    id: "AWS_SECRET",
    // 40-char base64url after common env-var or config assignment patterns
    pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+]{40}/gi,
    description: "AWS secret access key (labelled assignment)",
  },

  // ── Slack tokens ────────────────────────────────────────────────────────────
  {
    id: "SLACK_TOKEN",
    pattern: /xox[baprs]-(?:[A-Za-z0-9-]{10,48})/g,
    description: "Slack bot / app / user / workspace token",
  },

  // ── JWT (3-segment base64url) ───────────────────────────────────────────────
  {
    id: "JWT",
    // eyJ = base64 of '{"' — JWT headers always start this way
    pattern: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
    description: "JSON Web Token (3-segment base64url)",
  },

  // ── Generic private keys (PEM) ──────────────────────────────────────────────
  {
    id: "PEM_KEY",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    description: "PEM private key block",
  },

  // ── Generic high-entropy strings (≥32 hex chars or base64) ─────────────────
  // Applied last — catches secrets the specific rules miss.
  // Requires word boundary or assignment context to reduce false positives.
  {
    id: "HIGH_ENTROPY",
    pattern: /(?<=[=:'"` \t])[A-Za-z0-9+/]{32,}={0,2}(?=['"` \t\n;,]|$)/gm,
    description: "Generic high-entropy string ≥32 chars (possible secret)",
  },
];
