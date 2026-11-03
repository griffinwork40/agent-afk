/**
 * Command-position matching for the bash `safe` rule table.
 *
 * Extracted from `risk-classifier.ts` (350-code-line ceiling); that module keeps
 * its public surface and calls {@link isSafeAtCommandPosition} from
 * `classifyBash` after the HIGH and MEDIUM scans have found nothing.
 *
 * History: `classifyBash` used to accept a command as `safe` when the command
 * string merely CONTAINED a safe-table token anywhere (`cmd.includes(p)`). Any
 * command not caught by HIGH/MEDIUM that had a safe token in an ARGUMENT was
 * therefore auto-allowed: `gh pr create --head x` hit `'head '`,
 * `gh pr create --title "cat food"` hit `'cat '`, `npm publish && ls` hit
 * `'ls '`. Unknown commands are supposed to default to `medium`.
 *
 * @module agent/risk-classifier.bash-safe
 */

import { tokenizeSegments } from './tools/readonly-bash.tokenizer.js';

/**
 * Leading environment assignments that can make an otherwise read-only command
 * execute arbitrary code (binary lookup, dynamic loader, git/pager hooks,
 * interpreter start-up options). A segment that sets any of these is never
 * `safe` — `GIT_EXTERNAL_DIFF=./x git diff` and `PATH=. ls` run attacker code.
 */
const EXEC_HOOK_VAR =
  /^(?:PATH|IFS|ENV|BASH_ENV|SHELLOPTS|PS4|PROMPT_COMMAND|LD_\w*|DYLD_\w*|GIT_\w*|\w*PAGER|LESS\w*|EDITOR|VISUAL|NODE_OPTIONS|NODE_PATH|PYTHON\w*|PERL\w*|RUBY\w*)$/;

/**
 * Launcher prefixes that run their argument command (`npx vitest run`), each
 * with the set of argument commands it may unwrap to (`null` = any safe entry).
 *
 * Invariant: `npx` is restricted to the test runners. When the named binary is
 * not installed locally, `npx <name>` downloads the registry package `<name>`
 * and executes it, so `npx cat` / `npx ls` / `npx echo` would run arbitrary
 * third-party code. `pnpm exec` never downloads (local bins, then PATH), so it
 * may unwrap to any safe entry.
 */
const LAUNCHERS: readonly { prefix: readonly string[]; only: ReadonlySet<string> | null }[] = [
  { prefix: ['npx'], only: new Set(['vitest', 'jest']) },
  { prefix: ['pnpm', 'exec'], only: null },
];

const ASSIGNMENT = /^([A-Za-z_]\w*)=/;

/** fd duplications/closes and discards to /dev/null — no file is written. */
const NEUTRAL_REDIRECT = /(?:\d|&)?>>?(?:&(?:\d+|-)|\s*\/dev\/null\b)/g;

/**
 * True when `cmd` holds a `>` outside single/double quotes, i.e. an output
 * redirection that writes a file. MEDIUM only catches the spaced ` > ` form,
 * so `ls >out.txt` must be refused here rather than reach `safe`.
 */
function hasUnquotedWriteRedirect(cmd: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === '\\') i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '>') return true;
  }
  return false;
}

/** True when `tokens` begins with every word of `pattern` (exact word equality). */
function startsWithWords(tokens: readonly string[], pattern: readonly string[]): boolean {
  if (tokens.length < pattern.length) return false;
  return pattern.every((w, i) => tokens[i] === w);
}

/**
 * Strip leading `VAR=val` assignments. Returns null when an assignment targets
 * an exec-hook variable ({@link EXEC_HOOK_VAR}) — the segment is then not safe.
 */
function stripAssignments(tokens: readonly string[]): readonly string[] | null {
  let i = 0;
  while (i < tokens.length) {
    const m = ASSIGNMENT.exec(tokens[i]!);
    if (m === null) break;
    if (EXEC_HOOK_VAR.test(m[1]!)) return null;
    i++;
  }
  return tokens.slice(i);
}

/** True when one segment's command-position words match a safe-table entry. */
function segmentIsSafe(rawTokens: readonly string[], patterns: readonly (readonly string[])[]): boolean {
  const tokens = stripAssignments(rawTokens);
  // A pure-assignment segment (`X=1; ls`) mutates shell state the following
  // segments resolve against — not judged safe.
  if (tokens === null || tokens.length === 0) return false;
  // `cd <dir>` only changes the shell's own cwd; it is neutral, so the common
  // `cd sub && git status` shape keeps the verdict of its other segments.
  if (tokens[0] === 'cd' && tokens.length <= 2) return true;
  const candidates: (readonly string[])[] = [tokens];
  for (const l of LAUNCHERS) {
    if (!startsWithWords(tokens, l.prefix)) continue;
    const inner = tokens.slice(l.prefix.length);
    if (l.only === null || (inner[0] !== undefined && l.only.has(inner[0]))) candidates.push(inner);
  }
  return candidates.some((c) => patterns.some((p) => startsWithWords(c, p)));
}

/**
 * True when EVERY executable segment of `cmd` is a safe-table command at
 * command position.
 *
 * Invariant: segmentation reuses the readonly-bash tokenizer, which is
 * quote-aware (a `;`/`|` inside quotes never splits), treats `; | & ( )` and
 * newlines as boundaries, and emits `$(…)`/backtick substitution bodies as
 * their own segments — so `ls $(frob)` is judged on `frob` too. A pattern
 * matches only when its words equal the segment's leading tokens exactly, so
 * `--head`, `-siX` and quoted multi-word arguments can never satisfy it.
 * Anything the tokenizer cannot attribute to a safe command (heredoc bodies,
 * `\;`-escaped separators, `$VAR` in command position) falls out as a
 * non-safe segment and the caller's `medium` default applies. Fail-closed:
 * an empty command is not safe.
 */
export function isSafeAtCommandPosition(
  cmd: string,
  safePatterns: readonly string[],
  tokenize: (view: string) => readonly (readonly string[])[] = tokenizeSegments,
): boolean {
  // `2>&1` / `>&2` / `2>/dev/null` neither write a file nor separate commands.
  // Drop them before tokenizing: the tokenizer splits on every `&`, and the
  // remaining-`>` check below must only see real file writes.
  const normalized = cmd.replace(NEUTRAL_REDIRECT, ' ');
  if (hasUnquotedWriteRedirect(normalized)) return false;
  const segments = tokenize(normalized);
  if (segments.length === 0) return false;
  const patterns = safePatterns.map((p) => p.trim().split(/\s+/));
  return segments.every((seg) => segmentIsSafe(seg, patterns));
}
