/**
 * Word-start matching for the bash `high` rule table (#3534).
 *
 * Extracted from `risk-classifier.ts` (350-code-line ceiling); that module keeps
 * its public surface and calls {@link findHighBashPattern} from `classifyBash`.
 *
 * @module agent/risk-classifier.bash-boundary
 */

/** ASCII shell word characters. Anything else (incl. non-ASCII) is a boundary. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Invariant: separator-evasion shapes for the two prose-prone tokens. `'rm '`
 * and `'eval '` only match a literal space, so `rm<TAB>x`, `rm${IFS}-rf`,
 * `rm$IFS`, `rm\ x`, `$'rm' -rf` and `eval"$x"` slipped through as non-high
 * before #3534. This regex closes those gaps; hits are kept only at a word
 * start ({@link isWordStart}) so it adds no prose false positives inside
 * words. `RM` is matched too: on a case-insensitive filesystem (default macOS
 * APFS) `RM` resolves to /bin/rm. `grm`/`srm` (GNU and secure rm) are covered
 * by the optional prefix.
 */
const SEPARATOR_EVASION = /((?:[gs])?[Rr][Mm]|eval)(?=[\s$'"\\])/g;

/**
 * True when position `i` of `cmd` can begin a shell word (or a word segment
 * that may become the whole word after expansion).
 *
 * Invariant: returns false ONLY when `cmd[i - 1]` is an ASCII word character
 * that is not a positional-parameter digit (`$0`..`$9`). In shell grammar two
 * adjacent word characters belong to the same word, so the occurrence cannot
 * start a command name or flag: `platform ` is the word `platform`, not `rm`;
 * `retrieval ` is not `eval`. The `$<digit>` exception exists because `$1rm`
 * is `${1}rm`, which runs `rm` when `$1` is empty. Every other predecessor
 * (start of string, whitespace, `;`, `&`, `|`, `(`, `$(`, backtick, quote,
 * `/`, `\`, `}`, `-`, non-ASCII, …) still counts as a word start.
 */
function isWordStart(cmd: string, i: number): boolean {
  if (i === 0) return true;
  const prev = cmd[i - 1]!;
  if (!WORD_CHAR.test(prev)) return true;
  return /[0-9]/.test(prev) && i >= 2 && cmd[i - 2] === '$';
}

/**
 * True when `token` occurs in `cmd` at a word start.
 *
 * Invariant: strictly narrower than the pre-#3534 `cmd.includes(token)` only
 * for occurrences discounted by {@link isWordStart} — in-word occurrences that
 * cannot execute. Tokens beginning with a non-word character (`| sh`,
 * `-X POST`, `--request …`) are never discounted at all. No heredoc or quote
 * parsing is attempted, so ambiguous shapes (heredocs fed to interpreters,
 * `bash -c`, written-then-sourced scripts) keep the old high verdict.
 */
export function matchesAtWordStart(cmd: string, token: string): boolean {
  if (token.length === 0) return false;
  if (!WORD_CHAR.test(token[0]!)) return cmd.includes(token);
  let i = cmd.indexOf(token);
  while (i !== -1) {
    if (isWordStart(cmd, i)) return true;
    i = cmd.indexOf(token, i + 1);
  }
  return false;
}

/**
 * Return the first `high` pattern that fires for `cmd`, or `undefined`.
 * Table tokens are checked in order with {@link matchesAtWordStart}; the
 * separator-evasion regex is checked last and reported by its matched word.
 */
export function findHighBashPattern(
  cmd: string,
  patterns: readonly string[],
): string | undefined {
  for (const p of patterns) {
    if (matchesAtWordStart(cmd, p)) return p;
  }
  for (const m of cmd.matchAll(SEPARATOR_EVASION)) {
    if (isWordStart(cmd, m.index)) return m[1];
  }
  return undefined;
}
