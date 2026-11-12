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
 * `nextLine` covers the wrapped form, where the call line ends at the opening
 * parenthesis and the argument starts on the following line.
 */
export function isBracketTagStderrWrite(line: string, nextLine: string | undefined): boolean {
  const call = STDERR_WRITE_RE.exec(line);
  if (!call) return false;
  const rest = line.slice(call.index + call[0].length);
  const firstArg = rest.trim() === '' ? (nextLine ?? '') : rest;
  return BRACKET_TAG_LITERAL_RE.test(firstArg);
}
