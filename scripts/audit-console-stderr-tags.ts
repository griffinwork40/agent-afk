/**
 * Bracket-tagged `process.stderr.write` detection for `audit-console.ts`.
 *
 * Why: the REPL places and styles diagnostics through mechanisms that all hang
 * off `console.warn` / `console.error`: the boot-warning buffer, the console
 * bridge that commits output through the armed compositor, and the raw-console
 * rule in `audit-console.ts`. A direct `process.stderr.write('[tag] ...')`
 * bypasses every one of them and lands raw in the terminal. The unconditional
 * `[startup-recall] findLatestCwdSession took 108ms` banner line was one.
 *
 * Scope is the REPL subtree only. One-shot commands (chat, whatif, acp, trace)
 * own no compositor, and a tagged stderr line is ordinary CLI output there.
 */

/** Repo-relative, forward-slash prefix of the files this rule applies to. */
export const STDERR_TAG_SCOPE = 'src/cli/commands/interactive/';

/** `method` label recorded on a violation found by this rule. */
export const STDERR_TAG_METHOD = 'process.stderr.write [tag]';

/** Baseline `reason` for a file whose only violations come from this rule. */
export const STDERR_TAG_REASON = 'grandfathered: predates bracket-tag stderr gate';

const STDERR_WRITE_RE = /\bprocess\.stderr\.write\s*\(/;

// A string or template literal that opens with a bracket tag: `[afk] ...`,
// '[startup-recall] ...'. Quotes are excluded from the tag body so a
// concatenation such as '[' + name + ']' is not read as one tag, and a literal
// that opens with an escape (`\x1b[2K`) never reaches the `[`.
const BRACKET_TAG_LITERAL_RE = /^\s*[`'"]\[[^\]\s`'"][^\]\n`'"]{0,40}\]/;

/** Whether `relPath` (repo-relative, forward slashes) falls under this rule. */
export function inStderrTagScope(relPath: string): boolean {
  return relPath.startsWith(STDERR_TAG_SCOPE);
}

/**
 * True when `line` opens a `process.stderr.write(` call whose first argument is
 * a string or template literal that starts with a bracket tag.
 *
 * `followingLines`, starting at `nextLineIndex`, cover wrapped arguments. Skip
 * leading whitespace and comments only, never comment markers inside a literal.
 */
export function isBracketTagStderrWrite(
  line: string,
  followingLines: readonly string[] = [],
  nextLineIndex = 0,
): boolean {
  const call = STDERR_WRITE_RE.exec(line);
  if (!call) return false;
  let rest = line.slice(call.index + call[0].length);
  let inBlockComment = false;
  for (let i = nextLineIndex; ; i++) {
    rest = rest.trimStart();
    while (rest || inBlockComment) {
      if (inBlockComment) {
        const end = rest.indexOf('*/');
        if (end === -1) break;
        rest = rest.slice(end + 2).trimStart();
        inBlockComment = false;
      } else if (rest.startsWith('/*')) {
        rest = rest.slice(2);
        inBlockComment = true;
      } else if (rest.startsWith('//')) {
        break;
      } else {
        return BRACKET_TAG_LITERAL_RE.test(rest);
      }
    }
    if (i >= followingLines.length) return false;
    rest = followingLines[i]!;
  }
}
