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
// chmod secondary predicate (#5293, #5329)
// ---------------------------------------------------------------------------

// Invariant: these module-level constants are pre-compiled once and reused
// across every call to isChmodDangerous. They must not be mutated.
//
// OCTAL_MODE_ONLY matches a token that is entirely octal digits (1-4 digits).
// Used after mode extraction so we test only the mode argument, not filenames
// or redirect fd numbers elsewhere on the command line.
// Special-bit prefix digits (1=sticky, 2=setgid, 4=setuid) are part of the
// 1-4 digit range: `0777`, `777`, `1777`, `4777` are all matched.
const OCTAL_MODE_ONLY = /^[0-7]{1,4}$/;

// Copy permissions may include write even when the mode has no literal `w`.
// Each clause can contain multiple operations, such as g=u-w or u+x+g.
function isSymbolicModeDangerous(mode: string): boolean {
  for (const clause of mode.split(',')) {
    const match = /^([ugoa]*)((?:[+=-][rwxXstugo]*)+)$/.exec(clause);
    // Unknown syntax must not silently turn a potentially dangerous mode safe.
    if (!match) return true;
    const who = match[1]!;
    if (who && !/[goa]/.test(who)) continue;
    for (const operation of match[2]!.matchAll(/([+=-])([rwxXstugo]*)/g)) {
      // Removal cannot grant permissions. Copies may include write at runtime.
      if (operation[1] !== '-' && /[wugo]/.test(operation[2]!)) return true;
    }
  }
  return false;
}

/** Extract the literal mode, or return null for ambiguous/reference syntax. */
function extractChmodMode(afterChmod: string): string | null {
  const tokens = afterChmod.trim().split(/\s+/);
  // GNU chmod can accept options after operands as well as before them.
  if (tokens.some((t) => /^['"]?--reference(?:=|['"]?$)/.test(t))) return null;
  let options = true;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (options && t === '--') { options = false; continue; }
    // --reference replaces the mode with permissions unknown at classify time.
    if (options && t.startsWith('--reference')) return null;
    // A leading '-' may be a symbolic mode, not an option.
    if (options && /^-[rwxXstugo]+(?:[+=-][rwxXstugo]*)*$/.test(t)) return t;
    if (options && t.startsWith('-')) continue;
    return t.replace(/^(['"])(.*)\1$/, '$2');
  }
  return null;
}

/**
 * Secondary predicate for `chmod` (#5293, #5329).
 *
 * Returns `true` (HIGH) when the invocation is genuinely permission-widening:
 *   - Octal mode grants group-write or other-write (e.g. `777`, `666`, `022`).
 *   - Symbolic mode grants write to group/other/all (`g+w`, `o+w`, `+w`,
 *     `ug=rw`, `go+rw`, ...).
 *   - Comma-separated clause list includes a widening clause (`u+x,g+w`).
 *   - Mode argument is dynamic/unresolved (`$VAR`, `${VAR}`, `$(cmd)`,
 *     backtick) -- conservative: treat as high (#5329 F2).
 *   - `-R` / `--recursive` flag is present, including IFS-expanded forms
 *     (`${IFS}-R`, `$IFS-R`) (#5329 F4).
 *   - Target path is under a system directory or traverses `..`, including
 *     when the path is quoted (`"/etc/shadow"`) (#5329 F3).
 *   - Mode token is absent (ambiguous shell syntax) -- fail-closed.
 *
 * Returns `false` (allow) for benign patterns: `chmod +x script.sh`,
 * `chmod u+x`, `chmod 755 file`, `chmod 644 file`, `chmod u=g file`.
 *
 * Invariant: this function is only called when `chmod` appears at a word
 * start in `cmd` -- the caller is responsible for that pre-check.
 *
 * F5 (#5329): The mode argument is identified by position (first non-flag
 * token after `chmod`), not by scanning all tokens. This prevents redirect
 * fd numbers (`2` in `chmod 644 file 2>/dev/null` or `2> /dev/null`),
 * spaced redirects, bare trailing digits, and numeric-prefixed filenames
 * from ever being mistaken for a mode.
 */
export function isChmodDangerous(cmd: string): boolean {
  // F4 (#5329): Recursive flag, including IFS-expanded separator forms.
  // Original: `[\s$]` before `-R`; extended to cover `${IFS}`, `$IFS`, and
  // variable-in-flag forms like `-${R}` and `-$R`.
  // Conservative: any `chmod` invocation that contains `-R`/`--recursive` after
  // any shell expansion token is treated as recursive.
  if (/\bchmod\b[^;|&\n]*(?:[\s$]|-\$|\$\{[^}]*\})(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b/.test(cmd)) return true;
  // Also catch `-${R}` / `-$R` literally inside the flag word itself.
  if (/\bchmod\b[^;|&\n]*-[a-zA-Z]*\$(?:\{[^}]*\}|\w+)[a-zA-Z]*/.test(cmd)) return true;

  // F3 (#5329): Target path under a system directory or traversing `..`,
  // including when the path argument is quoted (`"/etc/shadow"`, `'../etc'`).
  // The unquoted check covers bare paths; the second regex strips surrounding
  // quotes and retests for quoted paths.
  // Negative lookbehind (?<!>) excludes redirect targets like `2> /dev/null`:
  // whitespace immediately after `>` introduces a redirect destination, not a chmod path argument.
  if (/\bchmod\b[^;|&\n]*(?<!>)\s(?:\/(?:bin|sbin|usr|etc|lib|boot|sys|proc|dev)\b|\.\.(?:\/|$))/.test(cmd)) return true;
  // Quoted path form: `chmod 755 "/etc/shadow"`, `chmod +x '/usr/local/bin/x'`.
  if (/\bchmod\b[^;|&\n]*\s['"](?:\/(?:bin|sbin|usr|etc|lib|boot|sys|proc|dev)(?:[^a-zA-Z0-9_]|$)|\.\.(?:\/|['"]|$))/.test(cmd)) return true;

  // Iterate ALL chmod invocations in the command (handles chained commands
  // like `chmod 755 a && chmod 777 b`). For each invocation:
  //   1. F2 (#5329): Dynamic mode check -- shell variable or substitution
  //      anywhere after `chmod`. Fail-closed: treat as high.
  //   2. Extract the mode argument positionally (first non-flag token).
  //      Fail-closed: missing mode token -> high.
  //   3. Octal mode: check only when the token is entirely octal digits.
  //      Use the last 3 digits for group-write / other-write analysis.
  //      `oct.slice(-3).padStart(3, '0')` handles 1-4-digit octals uniformly
  //      (e.g. `7` -> `007`, `77` -> `077`, `777` -> `777`, `1777` -> `777`,
  //      `4755` -> `755`). Once classified as octal, skip symbolic check.
  //   4. Symbolic mode: check each clause and operation, including copies.
  for (const cm of cmd.matchAll(/\bchmod\b[^;|&\n]*/g)) {
    const afterChmod = cm[0]!;

    // F2: Dynamic/unresolved mode argument -- shell variable or substitution
    // anywhere after `chmod`. Cannot resolve at classify time; treat as high.
    if (/(?:\$(?:\{[^}]*\}|\([^)]*\)|\w+)|`)/.test(afterChmod)) return true;

    // Extract the mode argument positionally (first non-flag token).
    // Fail-closed: no mode token -> ambiguous shell syntax -> high.
    const mode = extractChmodMode(afterChmod);
    if (mode === null) return true;

    // Octal mode: only when the entire token is octal digits.
    if (OCTAL_MODE_ONLY.test(mode)) {
      const last3 = mode.slice(-3).padStart(3, '0');
      const groupDigit = parseInt(last3[1]!, 8);
      const otherDigit = parseInt(last3[2]!, 8);
      if ((groupDigit & 0o2) !== 0 || (otherDigit & 0o2) !== 0) return true;
      // Octal fully classified -- not widening. Skip symbolic check.
      continue;
    }

    // Symbolic mode: test the extracted mode token directly.
    if (isSymbolicModeDangerous(mode)) return true;
  }

  return false;
}
