/**
 * Pure helpers for comparing `engines.node` lower bounds in package.json.
 *
 * Used by `scripts/check-engines-node-floor.ts` (the CLI) and by
 * `tests/engines-node-floor.test.ts` (unit tests that run inside `pnpm test`
 * so the check is exercised on every PR, not only in CI auto-release).
 *
 * Contract: pure — no I/O, no side effects, no process.exit. The caller owns
 * printing and exit so the script can use its own error messages.
 */

/**
 * Parse the minimum Node.js version from an `engines.node` range string.
 *
 * Accepts common `>=`-prefixed lower-bound forms used in npm package.json:
 *   >=X.Y.Z  >=X.Y  >=X  (with optional leading whitespace after `>=`)
 *
 * Returns null for any value that cannot be reliably parsed as a simple
 * lower-bound semver so the caller can decide whether to warn or skip.
 * Missing minor / patch components default to 0 (e.g. `>=24` → [24, 0, 0]).
 *
 * @example parseNodeFloor('>=22.13.0')   // => [22, 13, 0]
 * @example parseNodeFloor('>=22.0.0')    // => [22, 0, 0]
 * @example parseNodeFloor('>=24')        // => [24, 0, 0]
 * @example parseNodeFloor('>=24.0')      // => [24, 0, 0]
 * @example parseNodeFloor('>= 24.0.0')   // => [24, 0, 0]
 * @example parseNodeFloor('^22.0.0')     // => null  (caret — not a floor)
 */
export function parseNodeFloor(enginesNode: string): [number, number, number] | null {
  // Invariant: only `>=`-prefixed lower bounds with no additional constraints
  // (e.g. no upper bound, no `||`, no spaces between version components) are
  // valid floor specifiers. Tolerate optional whitespace after `>=` to accept
  // common npm range spellings like `>= 24.0.0`.
  const match = /^>= ?(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(enginesNode.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  return [major, minor, patch];
}

/**
 * Compare two [major, minor, patch] triples.
 *
 * @returns  1 if `a` is higher than `b`
 *           0 if equal
 *          -1 if `a` is lower than `b`
 */
export function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): 1 | 0 | -1 {
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) > (b[i] as number)) return 1;
    if ((a[i] as number) < (b[i] as number)) return -1;
  }
  return 0;
}

/**
 * Determine whether a move from `oldRange` to `newRange` raises the minimum
 * Node.js version floor.
 *
 * @returns `'raised'`          — the floor is strictly higher in `newRange`
 *          `'same-or-lower'`   — the floor stayed the same or went down
 *          `'unparseable'`     — at least one range could not be parsed
 *          `'changed-unparseable'` — the ranges DIFFER as raw strings but
 *                                   at least one cannot be parsed; the caller
 *                                   MUST NOT silently ignore this case because
 *                                   an un-parseable bump may still be a floor
 *                                   raise and the gate would silently bypass.
 */
export function nodeFloorStatus(
  oldRange: string,
  newRange: string,
): 'raised' | 'same-or-lower' | 'unparseable' | 'changed-unparseable' {
  const oldFloor = parseNodeFloor(oldRange);
  const newFloor = parseNodeFloor(newRange);
  if (!oldFloor || !newFloor) {
    // Contract: if the raw strings changed we cannot guarantee the floor
    // was NOT raised — return a distinct variant so callers fail closed.
    if (oldRange.trim() !== newRange.trim()) return 'changed-unparseable';
    return 'unparseable';
  }
  return compareSemver(newFloor, oldFloor) === 1 ? 'raised' : 'same-or-lower';
}
