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
 * APFS) `RM` resolves to /bin/rm. `grm`/`srm`/`GRM`/`SRM` (GNU and secure rm,
 * upper-case variants) are covered by the optional prefix `[gsGS]`.
 */
const SEPARATOR_EVASION = /((?:[gsGS])?[Rr][Mm]|eval)(?=[\s$'"\\;|])/g;

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

// ---------------------------------------------------------------------------
// chmod secondary predicate (#5293)
// ---------------------------------------------------------------------------

// Invariant: these module-level constants are pre-compiled once and reused
// across every call to isChmodDangerous. They must not be mutated.
//
// OCTAL_MODE captures 3- or 4-digit octal strings (optional leading `0` for
// the sticky/setuid/setgid bit). Group-write is bit 2 of the middle digit;
// other-write is bit 2 of the last digit. `0777` is dangerous; `0755` is not.
//
// WRITE_WIDENING_SYMBOLIC matches symbolic mode clauses that grant write
// access to group (`g`), other (`o`), or all (`a` / bare `+`):
//   `+w`, `a+w`, `g+w`, `o+w`, `ug+rw`, `go+w`, `g=w`, `o=rw`, …
// The pattern anchors on a word boundary or comma so it does not false-fire
// on the file argument (`g+w_script.sh` is a filename, not a mode).
const OCTAL_MODE = /\b(0?[0-7]{3})\b/g;
// Who-list must contain at least one of a/g/o for a write grant to be widening.
// A bare `+w` (empty who-list) is treated as `a+w` by POSIX and is widening.
// `u+rw` grants only to the owner — not widening. `ug+rw` has `g` — widening.
const WRITE_WIDENING_SYMBOLIC =
  /(?:^|[,\s])(?:[ugo]*[ago][ugo]*[+][^,\s]*[w][^,\s]*|[+][^,\s]*[w][^,\s]*|[ago][+=][^,\s]*[w][^,\s]*)/;

/**
 * Secondary predicate for `chmod` (#5293).
 *
 * Returns `true` (HIGH) when the invocation is genuinely permission-widening:
 *   - Octal mode grants group-write or other-write (e.g. `777`, `666`, `022`).
 *   - Symbolic mode grants write to group/other/all (`g+w`, `o+w`, `+w`, …).
 *   - `-R` / `--recursive` flag is present.
 *   - Target path is under a system directory or traverses `..`.
 *
 * Returns `false` (allow) for benign patterns: `chmod +x script.sh`,
 * `chmod u+x`, `chmod 755 file`, `chmod 644 file`.
 *
 * Invariant: this function is only called when `chmod` appears at a word
 * start in `cmd` — the caller is responsible for that pre-check.
 */
export function isChmodDangerous(cmd: string): boolean {
  // Recursive flag: chmod -R … touches an unbounded subtree.
  if (/\bchmod\b[^;|&\n]*\s(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b/.test(cmd)) return true;

  // Target path under a system directory or traversing `..`.
  if (/\bchmod\b[^;|&\n]*\s(?:\/(?:bin|sbin|usr|etc|lib|boot|sys|proc|dev)\b|\.\.(?:\/|$))/.test(cmd)) return true;

  // Extract the tokens after `chmod` up to the next shell separator so we
  // examine only this command's arguments, not a chained command's args.
  const afterChmod = cmd.match(/\bchmod\b[^;|&\n]*/)?.[0] ?? cmd;

  // Octal mode: group-write (bit 2 of middle digit) or other-write (bit 2 of last digit).
  for (const m of afterChmod.matchAll(OCTAL_MODE)) {
    const oct = m[1]!;
    // Strip optional leading special-mode digit (0755 → 755).
    const digits = oct.replace(/^0/, '');
    const groupDigit = parseInt(digits[digits.length - 2]!, 8);
    const otherDigit = parseInt(digits[digits.length - 1]!, 8);
    if ((groupDigit & 0o2) !== 0 || (otherDigit & 0o2) !== 0) return true;
  }

  // Symbolic mode: write granted to group, other, or all.
  if (WRITE_WIDENING_SYMBOLIC.test(afterChmod)) return true;

  return false;
}
