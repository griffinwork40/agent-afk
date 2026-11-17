/**
 * Nested-command payload extraction for the destructive-git classifier.
 *
 * Extracted from `readonly-bash.destructive-git.ts` to keep that file within
 * the 350-code-line ceiling. Each helper here is PURE: it returns the command
 * strings a shell would go on to execute (an interpreter's `-c` string, an
 * `eval` payload, a command substitution standing in for the command name),
 * and the caller (`classifyDestructiveGit`) classifies each one recursively.
 * Keeping the recursion in the caller avoids an import cycle.
 *
 * @module agent/tools/readonly-bash.destructive-git.nested
 */

import { baseName } from './readonly-bash.tokenizer.js';

/** Shell interpreters that execute a string argument (`-c`) or piped stdin. */
export const SHELL_INTERPS = new Set([
  'bash', 'sh', 'dash', 'zsh', 'ksh',
  '/bin/bash', '/bin/sh', '/bin/dash', '/bin/zsh', '/bin/ksh',
]);

/** Wrappers that prefix a shell interpreter without changing its identity (e.g. `sudo bash`). */
export const INTERP_WRAPPERS = new Set(['sudo', 'env', 'command']);

/** A single-dash option bundle that includes `c` (`-c`, `-lc`, `-ec`, `-xc`). */
function isCommandStringFlag(tok: string): boolean {
  return /^-[A-Za-z]*c[A-Za-z]*$/.test(tok);
}

/**
 * Command strings an interpreter would execute from its `-c` option, found
 * anywhere in one raw token segment (so wrappers such as `sudo` / `env` and
 * compound keywords such as `then` in front of the interpreter do not hide
 * it). Every non-option token after the `-c` bundle is returned: the first is
 * the script, the rest are `$0`/positional args. Returning all of them errs
 * toward blocking, which is the safe direction for this gate. An interpreter
 * with no `-c` (a script file, stdin) yields nothing here.
 */
export function interpreterCommandStrings(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!SHELL_INTERPS.has(baseName(tokens[i]!))) continue;
    // Find the `-c` bundle among the interpreter's options; options that take
    // a value (`-o pipefail`, `--rcfile x`) may sit in front of it.
    let k = i + 1;
    while (k < tokens.length && !isCommandStringFlag(tokens[k]!)) k++;
    for (let j = k + 1; j < tokens.length; j++) {
      if (!tokens[j]!.startsWith('-')) out.push(tokens[j]!);
    }
  }
  return out;
}

/**
 * The string an `eval` would run, for each `eval` token in one raw segment.
 * `eval` joins its arguments with spaces and runs the result, so
 * `eval 'git checkout main'` and `eval git 'checkout main'` both yield
 * `git checkout main`.
 */
export function evalPayloads(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (baseName(tokens[i]!) === 'eval') out.push(tokens.slice(i + 1).join(' '));
  }
  return out;
}

// A `$( … )` (no nested parens) or backtick span in COMMAND position: at the
// start of the string, after a separator, or after a keyword / wrapper that
// runs the next word as a command. A substitution in argument position
// (`echo "$(git rev-parse HEAD)"`, `git -C $(pwd) status`) is not rewritten,
// so recon that merely prints git output is not over-blocked.
const SUBSTITUTION_RE =
  /(^|[;&|(\n{]|\b(?:then|do|else|sudo|env|command|eval|exec|nohup|time))(\s*)(?:\$\(([^()]*)\)|`([^`]*)`)/g;

/**
 * Rewrites of `command` in which each command-position substitution is
 * replaced by a guess at its output, so a substitution standing in for the
 * command name (`$(echo git) checkout main`, `` `which git` reset --hard ``)
 * is judged as the git command it produces. Two guesses per substitution:
 *   1. the substitution mentions `git` → it becomes the word `git`;
 *   2. its leading `echo` / `printf` is dropped → its printed text
 *      (`$(echo git checkout main)` → `git checkout main`).
 * Every rewrite is strictly shorter than its input, so recursing on it ends.
 * Returns an empty list when nothing is rewritten.
 */
export function substitutionRewrites(command: string): string[] {
  if (!/\$\(|`/.test(command)) return [];
  const inner = (a?: string, b?: string): string => a ?? b ?? '';
  const asGit = command.replace(SUBSTITUTION_RE, (m, pre: string, ws: string, a?: string, b?: string) =>
    /\bgit\b/.test(inner(a, b)) ? `${pre}${ws}git` : m);
  const asPrinted = command.replace(SUBSTITUTION_RE, (_m, pre: string, ws: string, a?: string, b?: string) =>
    `${pre}${ws}${inner(a, b).trim().replace(/^(?:echo|printf)\s+(?:-[A-Za-z]+\s+)*/, '')}`);
  return [asGit, asPrinted].filter((s) => s !== command);
}
