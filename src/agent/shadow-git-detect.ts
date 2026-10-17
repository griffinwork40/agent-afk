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
  // (A) --no-verify / -n on git push / git commit
  // ------------------------------------------------------------------
  // Strategy: tokenize on shell segment boundaries (;, &&, ||, |, newline)
  // and inspect each segment independently. Within a segment we only scan
  // the git argument list — content inside quoted strings is excluded so
  // `git commit -m "document --no-verify"` does not fire. Short form `-n`
  // is treated as equivalent to `--no-verify` for `git commit` (per
  // `git commit -h`: "-n, --no-verify").
  for (const segment of splitSegments(command)) {
    const stripped = stripQuotedContent(segment);
    const gitArgList = extractGitArgList(stripped);
    if (gitArgList === null) continue;
    const { verb, args } = gitArgList;
    // `git push` only recognises --no-verify (long form); `-n` on push means
    // --dry-run. `git commit` recognises both `-n` and `--no-verify`.
    // Bundled short flags like `-an` / `-na` must also match: check any
    // `-[a-z]+` cluster that contains `n` (but not `--` long flags).
    const longNoVerify = /(?:^|\s)--no-verify(?:\s|$)/.test(args);
    const shortNoVerify =
      /(?:^|\s)-n(?:\s|$)/.test(args) ||
      /(?:^|\s)-[a-mo-z]*n[a-mo-z]*(?:\s|$)/.test(args); // bundled: -an, -na, etc.
    if (verb === 'push' && longNoVerify)
      hits.push({ kind: 'no-verify', pattern: 'git-push-no-verify' });
    if (verb === 'commit' && (longNoVerify || shortNoVerify))
      hits.push({ kind: 'no-verify', pattern: 'git-commit-no-verify' });
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
// Segment / quote helpers (used by both (A) and (B) detectors)
// ---------------------------------------------------------------------------

/**
 * Split a shell command string into segments on unquoted boundaries:
 * `;`, `&&`, `||`, `|`, and newlines. Each segment is one logical command
 * and is inspected independently so a flag in a later compound command
 * (e.g. `echo --no-verify`) does not bleed into an earlier git invocation.
 *
 * Contract: this is a heuristic tokenizer, not a full shell parser. It is
 * accurate for the subset of commands the agent produces (single-level
 * quoting, no nested subshells in the critical paths). Backtick / $(...)
 * subshells are not expanded — the literal characters are preserved.
 */
function splitSegments(command: string): string[] {
  // Collapse backslash line-continuations before splitting: `git push \\\n--no-verify`
  // becomes `git push  --no-verify` so both tokens land in the same segment.
  const joined = command.replace(/\\\n/g, ' ');
  // Split on ;, &&, ||, |, or \n — but only when NOT inside a quoted string.
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]!;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (inSingle || inDouble) { current += ch; continue; }
    // Unquoted — check for segment boundary.
    if (ch === '\n' || ch === ';') {
      segments.push(current); current = ''; continue;
    }
    if ((ch === '&' || ch === '|') && i + 1 < joined.length && joined[i + 1] === ch) {
      segments.push(current); current = ''; i++; continue;
    }
    if (ch === '|') {
      segments.push(current); current = ''; continue;
    }
    current += ch;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Replace the contents of single- and double-quoted strings in `s` with
 * a single space, so that flags embedded in commit messages do not match
 * subsequent argument-scanning regexes.
 *
 * Contract: only strips content; preserves the surrounding quote characters
 * so downstream length-estimation stays approximately correct.
 */
function stripQuotedContent(s: string): string {
  // Replace "..." and '...' contents with a placeholder space.
  // The double-quote pattern skips escaped quotes (`\\"`), preventing
  // `"say \"hi\" --no-verify"` from leaking the flag text out of the string.
  return s
    .replace(/"(?:[^"\\]|\\.)*"/g, '" "')
    .replace(/'[^']*'/g, "' '");
}

/**
 * Given a (already quote-stripped) shell segment, detect whether it contains
 * a `git` invocation and return the git sub-command verb and the rest of the
 * argument list. Returns `null` when the segment contains no `git` call.
 *
 * Handles:
 *   - `git <verb> [args]`
 *   - `git -c key=val <verb> [args]` (one or more -c options before verb)
 *   - `env VAR=val git <verb> [args]` prefix
 *   - `VAR=val git <verb> [args]` bare env-assignment prefix
 */
function extractGitArgList(segment: string): { verb: string; args: string } | null {
  // Match optional env-prefix then `git`, optional -c flags, then verb.
  // Invariant: segment has already had quoted content stripped, so we will
  // not match flags embedded inside commit messages.
  //
  // Contract: `-c key=val` values may become `' '` after quote-stripping
  // (e.g. `-c user.email='foo@bar.com'` → `-c user.email=' '`). The value
  // pattern `[^\s]*(?:'\s*')?[^\s]*` accepts both unquoted tokens and the
  // stripped `key=' '` form so git detection still fires.
  const m = /(?:^|\s)(?:(?:[A-Z_]+=\S*\s+)*(?:env\s+)?)?git(?:\s+-c\s+[^\s]*(?:'\s*'[^\s]*)?)*\s+(\w+)(.*)$/
    .exec(segment);
  if (!m) return null;
  return { verb: m[1]!, args: m[2] ?? '' };
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
 *      — scoped to segments containing a real git invocation.
 *   2. `git -c user.email=<email>` — already scoped by the `-c` flag being a
 *      git option; the regex requires the git context via `extractGitArgList`.
 *   3. `GIT_AUTHOR_EMAIL=<email>`, `GIT_COMMITTER_EMAIL=<email>` env vars —
 *      only when the same segment also contains a `git` invocation, so that
 *      `echo GIT_AUTHOR_EMAIL=human@example.com` does not fire.
 *
 * `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` / `-c user.name=` are name-only
 * overrides; without an email they do not change authorship in a way that
 * impersonates a different person's email, so they are NOT flagged here.
 * The issue text calls out `user.email` and the `EMAIL` vars specifically.
 */
function extractOverrideEmails(command: string): string[] {
  const found = new Set<string>();

  for (const segment of splitSegments(command)) {
    const stripped = stripQuotedContent(segment);
    const hasGit = extractGitArgList(stripped) !== null;

    // 1. `--author "Name <email>"` or `--author=...`
    //    Only meaningful when this segment is a git invocation.
    if (hasGit) {
      const authorFlagRe = /--author[= ]["']?[^<"']*<([^>]+)>/g;
      for (const m of segment.matchAll(authorFlagRe)) {
        if (m[1] !== undefined) found.add(m[1].toLowerCase().trim());
      }
    }

    // 2. `git -c user.email=<email>` — match on the original segment (not
    //    stripped) so that quoted values like -c user.email='foo@bar.com' are
    //    captured; strip outer quotes from the captured group.
    if (hasGit) {
      const userEmailRe = /-c\s+user\.email=["']?([^\s"';&|]+)/g;
      for (const m of segment.matchAll(userEmailRe)) {
        if (m[1] !== undefined) found.add(m[1].toLowerCase().trim());
      }
    }

    // 3. GIT_AUTHOR/COMMITTER_EMAIL — only flag when the same segment also
    //    calls git, so `echo GIT_AUTHOR_EMAIL=human@example.com` is ignored.
    if (hasGit) {
      const envEmailRe = /GIT_(?:AUTHOR|COMMITTER)_EMAIL=["']?([^\s"';&|]+)/g;
      for (const m of stripped.matchAll(envEmailRe)) {
        if (m[1] !== undefined) found.add(m[1].toLowerCase().trim());
      }
    }
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
