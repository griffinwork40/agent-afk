/**
 * Defense-in-depth environment containment for project-local MCP stdio servers.
 *
 * Issue #578: project-local `.mcp.json` servers are untrusted — they come from
 * the working directory, not the user's own `~/.afk/config/mcp.json`. Two attack
 * surfaces are closed here:
 *
 *   1. **Secret expansion refusal** — `${AWS_SECRET_ACCESS_KEY}` in a project
 *      server's `env` block would silently forward host credentials to the child
 *      process. Known-secret patterns are blocked; the user must opt-in explicitly
 *      via `allowSecretEnv: ["SPECIFIC_TOKEN"]` in the server config.
 *
 *   2. **Dangerous env inheritance scrub** — variables like `NODE_OPTIONS` or
 *      `LD_PRELOAD` can fundamentally alter the child's runtime without being
 *      visible in the MCP config. These are stripped from the inherited base env
 *      before being handed to `StdioClientTransport`.
 *
 * User-global servers (`~/.afk/config/mcp.json`) are fully trusted and bypass
 * both restrictions.
 *
 * @module agent/mcp/env-containment
 */

/** Which config layer a server originates from. */
export type McpServerLayer = 'project' | 'user-global' | 'plugin' | 'cli';

// ── Secret-pattern matching ──────────────────────────────────────────────────

/**
 * Glob-style patterns that identify env vars that commonly hold credentials.
 * Stored as RegExp objects built once at module load time. The list covers the
 * most common naming conventions; it is intentionally conservative — any false
 * positives are immediately visible via a console.warn and the user has an
 * `allowSecretEnv` opt-out.
 *
 * Pattern rationale:
 *   - `*_API_KEY`, `*_TOKEN`, `*_SECRET*`, `*_PASSWORD` — universal conventions
 *   - `AWS_*`, `GCP_*`, `AZURE_*` — cloud provider families
 *   - `ANTHROPIC_*`, `OPENAI_*` — AI provider keys used by the host tool
 */
const SECRET_PATTERNS: RegExp[] = [
  /^.+_API_KEY$/i,
  /^.+_TOKEN/i,       // prefix match: *_TOKEN, *_TOKEN_READONLY, *_TOKEN_EXPIRY …
  /^.+_SECRET/i,      // prefix match: *_SECRET, *_SECRET_KEY, *_SECRET_VALUE … (consistent with _TOKEN: no $)
  /^.+_PASSWORD$/i,
  /^AWS_/i,
  /^GCP_/i,
  /^AZURE_/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
];

/**
 * Return `true` when `varName` matches at least one of the known-secret
 * patterns. Case-insensitive (patterns carry `/i`).
 */
export function isSecretPattern(varName: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(varName));
}

// ── Dangerous inherited-env scrub list ──────────────────────────────────────

/**
 * Env vars that alter the child process's runtime in ways that are
 * impossible to audit from the MCP config alone. Stripping them from the
 * inherited base prevents a project `.mcp.json` from silently exploiting the
 * parent session's runtime environment.
 *
 * - `NODE_OPTIONS`   — can inject `--require`, `--experimental-*`, etc.
 * - `NODE_PATH`      — redirects Node.js module resolution order
 * - `LD_PRELOAD`     — Linux dynamic-linker injection
 * - `DYLD_*`         — macOS dynamic-linker injection (family match)
 * - `PYTHON*`        — can redirect imports, set encoding, alter paths
 * - `PERL5*`         — Perl module/lib path injection
 * - `RUBYOPT`        — Ruby runtime option injection
 */
const DANGEROUS_INHERIT_EXACT: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'RUBYOPT',
]);

const DANGEROUS_INHERIT_PREFIX: readonly string[] = [
  'DYLD_',
  'PYTHON',
  'PERL5',
];

/**
 * Return `true` when `varName` is on the dangerous-inheritance scrub list.
 * Exact matches are O(1); prefix matches scan a short array.
 */
export function isDangerousInherited(varName: string): boolean {
  if (DANGEROUS_INHERIT_EXACT.has(varName)) return true;
  for (const prefix of DANGEROUS_INHERIT_PREFIX) {
    if (varName.startsWith(prefix)) return true;
  }
  return false;
}

// ── Layer-aware expansion gate ───────────────────────────────────────────────

/**
 * Result of a layer-aware secret-expansion check on a single variable name
 * that appeared inside a `${VAR}` placeholder in a project-local env block.
 */
export interface SecretCheckResult {
  /** Whether the expansion should be allowed to proceed. */
  allowed: boolean;
  /**
   * When `allowed` is false, a human-readable warning message that the
   * caller should emit via `console.warn`. `undefined` when `allowed` is
   * true.
   */
  warning?: string;
}

/**
 * Decide whether a `${VAR}` expansion for `varName` is permitted given the
 * server's layer and its optional `allowSecretEnv` allowlist.
 *
 * Rules:
 *  - User-global / CLI / plugin servers: always allowed (trusted operator).
 *  - Project-layer servers: blocked when `varName` matches a secret pattern,
 *    UNLESS `varName` appears in `allowSecretEnv`.
 */
export function checkSecretExpansion(
  varName: string,
  layer: McpServerLayer,
  serverName: string,
  allowSecretEnv: readonly string[] = [],
): SecretCheckResult {
  // Non-project layers are unconditionally trusted.
  if (layer !== 'project') return { allowed: true };

  // Variable is not a secret pattern — allow.
  if (!isSecretPattern(varName)) return { allowed: true };

  // Explicitly allowed by the server config's opt-in list.
  if (allowSecretEnv.includes(varName)) return { allowed: true };

  return {
    allowed: false,
    warning:
      `[mcp:${serverName}] blocked secret expansion: \${${varName}} matches a known-secret ` +
      `pattern and this is a project-local server. ` +
      `To opt in, add \`"allowSecretEnv": ["${varName}"]\` to this server's entry in ` +
      `~/.afk/config/mcp.json (not in the project .mcp.json — project files cannot self-authorize).`,
  };
}

// ── Dangerous inherited-env scrubber ────────────────────────────────────────

/**
 * Remove dangerous inherited variables from `base` in-place and return the
 * list of variable names that were scrubbed (for logging).
 *
 * **Only call this for project-layer servers.** User-global / CLI / plugin
 * servers receive the full inherited base without modification.
 */
export function scrubDangerousEnv(
  base: Record<string, string>,
): string[] {
  const scrubbed: string[] = [];
  for (const key of Object.keys(base)) {
    if (isDangerousInherited(key)) {
      delete base[key];
      scrubbed.push(key);
    }
  }
  return scrubbed;
}
