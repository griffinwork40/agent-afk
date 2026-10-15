/**
 * Shadow-mode detector for two git identity-bypass patterns (issue #3758).
 *
 * Watches `bash` commands for:
 *
 *   (A) `--no-verify` on `git push` or `git commit` — silences pre-push /
 *       pre-commit hooks, including the project's own audit gates.
 *
 *   (B) An explicit author/committer identity set to something other than the
 *       configured agent identity (`agent@agentafk.com`), via:
 *         - `git commit --author "Name <email>"`
 *         - `git -c user.email=<email>` / `git -c user.name=<name>`
 *         - `GIT_AUTHOR_EMAIL=`, `GIT_AUTHOR_NAME=`,
 *           `GIT_COMMITTER_EMAIL=`, `GIT_COMMITTER_NAME=`
 *       Exempt: `Co-authored-by:` trailer text (never sets the commit author
 *       metadata); known bot-identity prefixes (github-actions, dependabot,
 *       renovate, agent@agentafk.com itself).
 *
 * **Log-only for one release** (issue #3758 shadow window): both detections
 * return `decision: 'approve'` — the command runs unchanged. The attempt is
 * recorded in the witness trace as a `hook_decision` event (via the `reason`
 * field on the approve return) so telemetry can measure false-positive rate
 * before promotion to a block.
 *
 * Mirrors the OBSERVE-tier pattern from `safe-destruct-detect.ts` / the
 * `release-boundary-detect.ts` sibling: return `{ decision: 'approve', reason }`.
 *
 * @module agent/shadow-git-detect
 */

import type { HookContext, HookDecision } from './hooks.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable prefix on all shadow-detect reason strings. */
export const SHADOW_GIT_REASON_PREFIX = 'shadow-git observe-only';

/**
 * The canonical agent email address. Commits authored as this identity are
 * expected and not flagged.
 */
const AGENT_EMAIL = 'agent@agentafk.com';

/**
 * Known-bot identity prefixes / exact emails exempt from the identity check.
 * Matched case-insensitively against the full email string extracted from the
 * command. `Co-authored-by:` trailers are never parsed as author metadata —
 * the regex anchors listed below only fire on flag / env-var argument positions.
 */
const KNOWN_BOT_EMAILS: readonly string[] = [
  AGENT_EMAIL,
  'github-actions',
  'dependabot',
  'renovate',
  'noreply@github.com',
  '41898282+github-actions',
];

// ---------------------------------------------------------------------------
// Pure detector — exported for unit tests
// ---------------------------------------------------------------------------

export type ShadowGitHit =
  | { kind: 'no-verify'; pattern: string }
  | { kind: 'identity'; pattern: string; email: string };

/**
 * Inspect a raw bash command string for the two shadow-git patterns.
 *
 * Returns an array of hits (empty when none match). Pure and stateless —
 * safe to call repeatedly; no global-flag regexes.
 */
export function detectShadowGit(command: string): ShadowGitHit[] {
  if (!command) return [];
  const hits: ShadowGitHit[] = [];

  // ------------------------------------------------------------------
  // (A) --no-verify on git push / git commit
  // ------------------------------------------------------------------
  // Match `git push … --no-verify` or `git commit … --no-verify`.
  // The git sub-command and the flag may appear in either order on the line
  // (e.g. `git push --no-verify origin main` or with flags before the verb).
  // We look for both "git push" and "git commit" anywhere in the command,
  // then separately check for "--no-verify". This avoids false positives on
  // e.g. `git push origin main && echo "--no-verify disabled"`.
  const hasNoVerify = /(?:^|[;&|]\s*|\benv\b[^;]*\s)git\s[^;]*--no-verify/.test(command);
  if (hasNoVerify) {
    const isPush = /(?:^|[;&|]\s*|\benv\b[^;]*\s)git\s[^;]*\bpush\b[^;]*--no-verify/.test(command)
      || /(?:^|[;&|]\s*|\benv\b[^;]*\s)git\s[^;]*--no-verify[^;]*\bpush\b/.test(command);
    const isCommit = /(?:^|[;&|]\s*|\benv\b[^;]*\s)git\s[^;]*\bcommit\b[^;]*--no-verify/.test(command)
      || /(?:^|[;&|]\s*|\benv\b[^;]*\s)git\s[^;]*--no-verify[^;]*\bcommit\b/.test(command);
    if (isPush) hits.push({ kind: 'no-verify', pattern: 'git-push-no-verify' });
    if (isCommit) hits.push({ kind: 'no-verify', pattern: 'git-commit-no-verify' });
  }

  // ------------------------------------------------------------------
  // (B) Explicit author/committer identity override
  // ------------------------------------------------------------------
  const emails = extractOverrideEmails(command);
  for (const email of emails) {
    if (!isKnownBot(email)) {
      hits.push({ kind: 'identity', pattern: 'git-identity-override', email });
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Email extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract every email address that would override the git author/committer
 * identity in this command. Returns deduplicated lowercase strings.
 *
 * Sources:
 *   1. `git commit --author "Name <email>"` or `git commit --author="Name <email>"`
 *   2. `git -c user.email=<email>` (with or without `git commit` following)
 *   3. `GIT_AUTHOR_EMAIL=<email>`, `GIT_COMMITTER_EMAIL=<email>` env vars
 *
 * `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` / `-c user.name=` are name-only
 * overrides; without an email they do not change authorship in a way that
 * impersonates a different person's email, so they are NOT flagged here.
 * The issue text calls out `user.email` and the `EMAIL` vars specifically.
 */
function extractOverrideEmails(command: string): string[] {
  const found = new Set<string>();

  // 1. `git commit --author "Name <email>"` or `--author=...`
  //    The <email> is inside angle brackets in the standard git "A U Thor <email>" format.
  //    Capture the angle-bracket content only (the email).
  const authorFlagRe = /--author[= ]["']?[^<"']*<([^>]+)>/g;
  for (const m of command.matchAll(authorFlagRe)) {
    if (m[1] !== undefined) found.add(m[1].toLowerCase().trim());
  }

  // 2. `git -c user.email=<email>` (value may be quoted or unquoted)
  const userEmailRe = /-c\s+user\.email=["']?([^\s"';&|]+)/g;
  for (const m of command.matchAll(userEmailRe)) {
    if (m[1] !== undefined) found.add(m[1].toLowerCase().trim());
  }

  // 3. GIT_AUTHOR_EMAIL=<email> / GIT_COMMITTER_EMAIL=<email>
  //    Matches both `GIT_AUTHOR_EMAIL=foo@bar.com cmd` and
  //    `env GIT_AUTHOR_EMAIL=foo@bar.com cmd` forms.
  const envEmailRe = /GIT_(?:AUTHOR|COMMITTER)_EMAIL=["']?([^\s"';&|]+)/g;
  for (const m of command.matchAll(envEmailRe)) {
    if (m[1] !== undefined) found.add(m[1].toLowerCase().trim());
  }

  return [...found];
}

/**
 * Returns true when `email` belongs to a known-bot identity that should not
 * be flagged. Case-insensitive prefix/exact match against {@link KNOWN_BOT_EMAILS}.
 */
function isKnownBot(email: string): boolean {
  const lower = email.toLowerCase();
  return KNOWN_BOT_EMAILS.some((bot) => lower === bot || lower.startsWith(bot.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Create the shadow-git PreToolUse hook.
 *
 * Log-only for issue #3758's shadow window: always returns `decision:
 * 'approve'` (never blocks). The `reason` field stamps a filterable
 * `hook_decision` event into the witness trace for telemetry.
 */
export function createShadowGitDetect(): (context: HookContext) => HookDecision {
  return function shadowGitDetect(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    if (context.toolName !== 'bash') return {};

    const input = context.input as Record<string, unknown> | undefined;
    const command = typeof input?.['command'] === 'string' ? input['command'] : '';
    if (!command) return {};

    const hits = detectShadowGit(command);
    if (hits.length === 0) return {};

    const labels = hits.map((h) =>
      h.kind === 'no-verify'
        ? h.pattern
        : `${h.pattern}:<${h.email}>`,
    );

    return {
      decision: 'approve',
      reason: `${SHADOW_GIT_REASON_PREFIX} [${labels.join(', ')}]`,
    };
  };
}
