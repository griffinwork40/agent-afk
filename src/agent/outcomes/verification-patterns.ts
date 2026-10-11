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

import { redactSecrets } from '../redact-secrets.js';

// ---------------------------------------------------------------------------
// resultTail constant
// ---------------------------------------------------------------------------

/**
 * Maximum characters to keep in the `resultTail` field on verification tool
 * events. All three production sites (turn-handler.stream-events.ts,
 * run-skill-dispatch-turn.ts, journal-turns.ts) import this value and the
 * shared {@link buildVerificationResultTail} helper so they cannot drift.
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
// resultTail builder
// ---------------------------------------------------------------------------

/**
 * Build the `resultTail` string for a verification-command tool event.
 *
 * **When to use:** call this whenever a tool result arrives for a tool whose
 * name is `test_run` or whose bash input matches {@link isVerificationCommand}.
 * The result should be stored on `ToolEvent.resultTail` so the outcome
 * labeling functions can parse pass/fail even when the full output was
 * truncated.
 *
 * @param toolName    - The tool's name (e.g. `'bash'`, `'test_run'`).
 * @param input       - The tool's input summary (bash command string, or
 *                      ignored when `toolName` is `'test_run'` (the tool
 *                      carries no meaningful input string).
 * @param rawContent  - The flat result text. For stream events this is the
 *                      chunk's `.content` field; for journal-derived events
 *                      it is the already-flat concatenated result text.
 * @param tailPreview - Optional pre-extracted tail lines from the stream
 *                      chunk (`.tailPreview`). When present and non-empty,
 *                      these lines are joined and used in place of slicing
 *                      `rawContent` directly — they are already the last N
 *                      non-empty lines, so they carry more signal per byte
 *                      than a raw character slice. Omit (or pass `undefined`)
 *                      when calling from a journal/flat-text path.
 *
 * @returns The redacted tail string, or `undefined` when the tool is not a
 *          verification command or the result is empty.
 */
export function buildVerificationResultTail(
  toolName: string,
  input: string,
  rawContent: string,
  tailPreview?: string[],
): string | undefined {
  const isVerify = toolName === 'test_run' ||
    (toolName === 'bash' && isVerificationCommand(input));
  if (!isVerify) return undefined;
  const base = tailPreview !== undefined && tailPreview.length > 0
    ? tailPreview.join('\n')
    : rawContent;
  if (base.length === 0) return undefined;
  const tail = base.length > RESULT_TAIL_CHARS
    ? base.slice(-RESULT_TAIL_CHARS)
    : base;
  return redactSecrets(tail);
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
