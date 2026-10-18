/**
 * Read-only gate for the bash carve-out scrub.
 *
 * Invariant: the exact-file read carve-outs (`READ_ALLOWLIST_REL`: `~/.ssh/config`,
 * `~/.ssh/known_hosts`, `~/.afk/config/mcp.json`, `schedules.json`) and the SSH
 * public-key carve-out are READ grants. The bash hook is a LEXICAL scanner, so
 * before this gate it blanked those spellings regardless of what the command
 * did with them — `echo … >> ~/.ssh/config` (a `ProxyCommand` is code
 * execution on the next ssh), `cp /tmp/x ~/.ssh/known_hosts` (trust injection),
 * `tee -a ~/.afk/config/mcp.json` (an MCP server command is code execution),
 * `sed -i`, and interpreter one-liners all returned allow. The scrub now
 * applies ONLY when {@link isProvablyReadOnly} says so; every other command
 * that mentions a carve-out is scanned unscrubbed and blocked by the enclosing
 * root.
 *
 * Contract: FAIL CLOSED. This is an allowlist of pure readers, never an
 * enumeration of write shapes. A command qualifies only when:
 *   - it contains none of: `>` (every output redirection form, incl. `>>`,
 *     `>|`, `&>`, `N>`, `<>`), `&` (background, `&&`, `|&`), `;`, `||`,
 *     newline / CR, backtick, `$(`, `(`/`)` outside single quotes, and no `$`
 *     outside single quotes except the `$HOME`/`$AFK_HOME` idioms the scanner
 *     itself normalizes. The two discard redirections `2>/dev/null` and
 *     `>/dev/null` (and `2>&1`) are the only exceptions — they cannot persist
 *     anything.
 *   - it splits on `|` into segments whose command word is a bare name in
 *     {@link READ_ONLY_COMMANDS} (no path, no `VAR=` prefix, no wrapper).
 * Commands omitted on purpose: `sed`/`awk` (`-i`, `w`, `print > f`), `sort`
 * (`-o`), `uniq`/`xxd` (second operand is an output file), `rg` (`--pre` runs a
 * command), `less`/`more` (`v` opens an editor, `s` saves), `file` (`-C`
 * writes), `base64` (BSD `-o`), `ssh-keygen` (`-R` rewrites known_hosts),
 * `tee`/`cp`/`mv`/`install`/`ln`/`dd`/`truncate`, `xargs`/`env`/interpreters.
 *
 * @module agent/tools/hooks/bash-restriction-hook.readonly-gate
 */

import { tokenizeSegments } from '../readonly-bash.tokenizer.js';

/**
 * Pure readers: no option of these writes a file or runs a command. Adding an
 * entry requires checking every option of every platform's implementation.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'ls', 'stat', 'cut', 'nl',
  'od', 'hexdump', 'strings', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'shasum',
]);

/** Discard-only redirections; stripped before the operator scan. */
const DISCARD_REDIRECTS = /(^|[ \t])(?:[12]?>[ \t]*\/dev\/null|2>&1)(?=[ \t]|$)/g;

/** `$` followed by one of the idioms `normalizeHomeRefs` rewrites. */
const ALLOWED_DOLLAR = /^\$(?:HOME\b|AFK_HOME\b|\{HOME\}|\{AFK_HOME\})/;

/** Characters that disqualify a command wherever they appear (even quoted). */
const ALWAYS_FORBIDDEN = /[>&;\n\r`]|\$\(|\|\|/;

/** Assignment prefix (`VAR=val cmd`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Scan outside single quotes for `(`, `)`, and non-idiom `$`. */
function hasUnquotedExpansion(text: string): boolean {
  let single = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") { single = !single; continue; }
    if (single) continue;
    if (ch === '(' || ch === ')') return true;
    if (ch === '$' && !ALLOWED_DOLLAR.test(text.slice(i))) return true;
  }
  return single; // an unterminated quote is not a shape we can reason about
}

/**
 * True only when `command` is a pipeline of allowlisted pure readers with no
 * redirection, chaining, substitution, or expansion other than the home
 * idioms. See the module contract; anything uncertain returns false.
 */
export function isProvablyReadOnly(command: string): boolean {
  const stripped = command.replace(DISCARD_REDIRECTS, '$1');
  if (ALWAYS_FORBIDDEN.test(stripped)) return false;
  if (hasUnquotedExpansion(stripped)) return false;
  const segments = tokenizeSegments(stripped);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    const cmd = seg[0];
    if (cmd === undefined || ASSIGNMENT.test(cmd)) return false;
    return READ_ONLY_COMMANDS.has(cmd);
  });
}
