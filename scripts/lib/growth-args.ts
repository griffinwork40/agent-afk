/**
 * Shared pure parser for `--allow-growth` / `--reason` CLI flags used by the
 * size-ceiling scripts. Extracted so both `check-file-size.ts` and
 * `check-function-size.ts` share identical validation logic.
 *
 * Contract: pure — no I/O, no side effects, no process.exit. The caller owns
 * printing and exit so each script can use its own prefix.
 */

export interface GrowthArgs {
  allowGrowth: boolean;
  reason: string;
}

export interface GrowthArgsError {
  error: string;
}

/**
 * Parse `--allow-growth` and `--reason` from an argv slice.
 *
 * Rules:
 *   - `--reason` without `--allow-growth` → error.
 *   - `--allow-growth` without `--reason` (or empty reason) → error.
 *   - `--reason` present but its next token is one of `knownFlags` → error
 *     (the caller forgot the value).
 *   - `--reason "<text>"` where `<text>` is not a known flag → accepted even
 *     if it starts with `--` (legitimate reason text).
 *   - Neither flag → `{ allowGrowth: false, reason: '' }` (success, no growth).
 *
 * @param argv       Process argv slice (typically `process.argv.slice(2)`).
 * @param knownFlags The full set of flag tokens this script recognises, e.g.
 *                   `['--check', '--update-baseline', '--allow-growth', '--reason', ...]`.
 *                   Used to detect a missing reason value.
 */
export function parseGrowthArgs(
  argv: readonly string[],
  knownFlags: readonly string[],
): GrowthArgs | GrowthArgsError {
  const allowGrowth = argv.includes('--allow-growth');
  const reasonIdx = argv.indexOf('--reason');

  // --reason present but no value token follows (end of argv or next token is a known flag).
  if (reasonIdx >= 0) {
    const nextToken = argv[reasonIdx + 1];
    if (nextToken === undefined || knownFlags.includes(nextToken)) {
      return {
        error:
          '--reason requires a non-empty value. Did you forget the text? e.g. --reason "why this growth is intentional"',
      };
    }
  }

  const reason = reasonIdx >= 0 ? (argv[reasonIdx + 1] ?? '') : '';

  // --reason without --allow-growth is meaningless and likely a mistake.
  if (reasonIdx >= 0 && !allowGrowth) {
    return { error: '--reason has no effect without --allow-growth. Add --allow-growth or remove --reason.' };
  }

  // --allow-growth without --reason (or empty reason after all checks above).
  if (allowGrowth && !reason) {
    return { error: '--allow-growth requires --reason "<text>" (non-empty).' };
  }

  return { allowGrowth, reason };
}
