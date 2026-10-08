/**
 * Shared verification-command patterns and summary parser.
 *
 * Consumed by both `lf-immediate.ts` (to detect verification commands in the
 * stored session event list) and `session-store.ts` (to decide which tool
 * events need a `resultTail` snapshot at record time). Kept in one place so
 * the two sites never drift.
 *
 * @module agent/outcomes/verification-patterns
 */

// ---------------------------------------------------------------------------
// resultTail constant
// ---------------------------------------------------------------------------

/**
 * Maximum characters to keep in the `resultTail` field on verification tool
 * events. Exported so journal-turns.ts (and any future consumer) can reuse
 * the same value without duplicating the magic number. The two CLI sites
 * (turn-handler.stream-events.ts and run-skill-dispatch-turn.ts) each define
 * a local RESULT_TAIL_CHARS = 240 from this same value, and may be updated
 * to import this export instead.
 */
export const RESULT_TAIL_CHARS = 240;

// ---------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------

/** Regexes that identify a shell command as a verification (test/lint/build) run. */
export const VERIFICATION_PATTERNS: RegExp[] = [
  /\bpnpm\s+test\b/,
  /\bvitest\b/,
  /\btsc\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\btest_run\b/,
  /\bnpm\s+test\b/,
  /\byarn\s+test\b/,
  /\bpnpm\s+lint\b/,
  /\bpnpm\s+build\b/,
  /\beslint\b/,
  /\bmypy\b/,
  /\bruff\b/,
];

/** Returns true when `input` matches any verification-command pattern. */
export function isVerificationCommand(input: string): boolean {
  return VERIFICATION_PATTERNS.some((p) => p.test(input));
}

// ---------------------------------------------------------------------------
// Summary parser
// ---------------------------------------------------------------------------

/**
 * Parse a verification summary out of the last ~240 characters of tool output.
 *
 * Returns:
 * - `'pass'` — a recognisable success pattern was found.
 * - `'fail'` — a recognisable failure pattern was found.
 * - `null`   — the tail was too ambiguous to classify.
 *
 * Patterns recognised (each source lists pass then fail):
 *   vitest/jest    "Tests  N passed" / "N failed"
 *   pytest         "N passed" / "N failed" / "error"
 *   tsc            empty tail on unpiped clean run (caller must supply
 *                  context) / "Found N error(s)"
 *   cargo/go       "test result: ok" / "test result: FAILED"
 *                  "^ok " / "^FAIL "
 *   eslint         "0 problems" (pass) / "N problems" N>0 (fail)
 *   pnpm lifecycle "ELIFECYCLE" / "Command failed"
 */
export function parseVerificationSummary(tail: string): 'pass' | 'fail' | null {
  if (tail.length === 0) return null;

  // ── Explicit failure patterns (checked first — higher priority) ──────────

  // vitest/jest: "N failed" where N > 0
  if (/\b([1-9]\d*)\s+failed\b/i.test(tail)) return 'fail';

  // tsc: "Found N error(s)"
  if (/Found\s+\d+\s+error/i.test(tail)) return 'fail';

  // cargo/go test failure
  if (/test result:\s*FAILED/i.test(tail)) return 'fail';
  if (/^FAIL\b/m.test(tail)) return 'fail';

  // pnpm lifecycle / npm run failure
  if (/ELIFECYCLE/i.test(tail)) return 'fail';
  if (/Command failed/i.test(tail)) return 'fail';

  // eslint: N problems (N > 0)
  const eslintProblems = /\b(\d+)\s+problem/i.exec(tail);
  if (eslintProblems !== null && parseInt(eslintProblems[1] ?? '0', 10) > 0) return 'fail';

  // pytest: "N failed" already covered; "error" at end of summary line
  if (/\berror\b/i.test(tail) && /\d+\s+error/i.test(tail)) return 'fail';

  // ── Pass patterns ─────────────────────────────────────────────────────────

  // vitest/jest: "Tests  N passed" or "passed N"
  if (/\bTests\b.*\bpassed\b/i.test(tail)) return 'pass';
  if (/\b\d+\s+passed\b/i.test(tail)) return 'pass';

  // cargo/go test pass
  if (/test result:\s*ok\b/i.test(tail)) return 'pass';
  if (/^ok\b/m.test(tail)) return 'pass';

  // eslint: "0 problems"
  if (/\b0\s+problems?\b/i.test(tail)) return 'pass';

  return null;
}
