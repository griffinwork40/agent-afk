/** Literal-text guard for the #4993 `restore --staged` / `clean -n` exemptions.
 *
 * The exemptions read flags from a tokenized argv, but the shell can change
 * that argv in ways the tokenizer does not model: a `#` starts a comment (so
 * a "flag" after it never reaches git), backslash-newline joins the next line
 * into the same argv, and expansions, globs and braces can supply any word.
 * Aliases, sourced files and shell functions can redefine `git` itself.
 * The exemption is therefore granted only when the command string is plain
 * literal text; anything else keeps main's fail-closed verdict.
 */
import { tokenizeSegments } from './readonly-bash.tokenizer.js';

// Expansion, substitution, escape/continuation, comment, glob, brace and
// subshell/function syntax. Quotes are allowed: quote removal is literal.
const NON_LITERAL_CHARS = /[$`\\#*?[\]{}()]/;
// Environment that makes a later shell run startup code first.
const STARTUP_ENV = /(^|[\s;&|])(?:BASH_ENV|ENV)=/;
// Words that can redefine what a later `git` word runs.
const REDEFINING_WORDS = new Set(['alias', 'unalias', 'function', 'source', 'enable', 'shopt']);

/** True when `command` contains only plain literal shell text, so every flag
 * the tokenizer reports is exactly a word git will receive. */
export function isLiteralCommand(command: string): boolean {
  if (NON_LITERAL_CHARS.test(command) || STARTUP_ENV.test(command)) return false;
  for (const tokens of tokenizeSegments(command)) {
    if (tokens[0] === '.') return false;
    if (tokens.some((t) => REDEFINING_WORDS.has(t))) return false;
  }
  return true;
}
