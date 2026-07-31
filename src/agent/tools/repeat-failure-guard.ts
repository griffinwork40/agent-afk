/**
 * Enforcing guard for a tool that keeps FAILING the same way (#723).
 *
 * Invariant: this is a distinct mechanism from the advisory repeat breaker in
 * `repeat-circuit-breaker.ts`, and both stay live. That one counts consecutive
 * BYTE-IDENTICAL calls regardless of outcome and returns a nudge the model may
 * ignore; this one counts consecutive FAILURES of the same normalized call and
 * refuses to execute it again. The distinction matters because the incident that
 * motivated this (~9 rounds of an identically-failing `browser_open`, ~13
 * minutes, ~$7.29) defeated the advisory breaker twice over: it needed 8
 * identical calls, and it never stopped execution.
 *
 * Contract: `check()` is consulted before execution and returns a refusal once a
 * fingerprint has failed {@link REPEAT_FAILURE_REFUSAL_THRESHOLD} times in a
 * row; `note()` is called with every settled result and is what advances or
 * clears the count. A SUCCESS clears the fingerprint entirely, so the guard only
 * ever fires on an unbroken failure streak — a tool that intermittently works is
 * never refused.
 *
 * Deliberately NOT in scope: aborting the turn. A hard abort on a false positive
 * is worse than the loop it prevents, so the refusal is tool-level and leaves the
 * model free to change approach or stop cleanly.
 *
 * @module agent/tools/repeat-failure-guard
 */

import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import { fingerprintToolCall } from './suspected-loop-detector.js';

/**
 * Consecutive identical failures tolerated before the call is refused.
 *
 * Three is chosen to sit below every plausible legitimate retry pattern while
 * still cutting the incident short: two attempts is a normal transient retry
 * (the second frequently succeeds), so the guard must not fire there; the third
 * identical failure is where the evidence for "this will not work" becomes
 * strong. The motivating incident ran ~9 rounds, so a threshold of 3 would have
 * saved roughly two thirds of the wasted time and spend.
 */
export const REPEAT_FAILURE_REFUSAL_THRESHOLD = 3;

/**
 * Input keys stripped before fingerprinting, so trivial jitter cannot defeat the
 * guard the way it defeats the advisory breaker.
 *
 * Invariant: this list is deliberately tiny and must stay that way. Every key
 * removed here makes two genuinely different calls look identical, so only
 * fields that cannot change a call's MEANING belong: a deadline governs how long
 * the same operation may run, never what it does. Anything semantic (a path, a
 * URL, a command) must keep its influence on the fingerprint.
 */
const VOLATILE_INPUT_KEYS: ReadonlySet<string> = new Set(['timeout_ms', 'timeoutMs', 'timeout']);

/** Upper bound on the quoted prior error, so a refusal cannot dump a huge body. */
const MAX_ERROR_SUMMARY_CHARS = 240;

/** A refusal, plus the counters the caller needs for telemetry. */
export interface RepeatFailureVerdict {
  readonly result: ToolResult;
  readonly count: number;
  readonly tool: string;
}

function stripVolatileKeys(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (VOLATILE_INPUT_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Normalized fingerprint: the shared `fingerprintToolCall` already sorts object
 * keys recursively (so re-ordered keys hash identically); this adds the
 * volatile-key strip on top, which is the half key order alone does not cover.
 */
export function repeatFailureFingerprint(call: ToolCall): string {
  return fingerprintToolCall({ ...call, input: stripVolatileKeys(call.input) });
}

/** Condense a failed result's content into one quotable line. */
function summarizeError(result: ToolResult): string {
  const firstLine = result.content.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  if (firstLine.length <= MAX_ERROR_SUMMARY_CHARS) return firstLine;
  return `${firstLine.slice(0, MAX_ERROR_SUMMARY_CHARS)}…`;
}

/**
 * Per-dispatcher failure streaks keyed by normalized fingerprint.
 *
 * Lifetime matches the dispatcher (one per turn), so counts never leak across
 * turns — a call that failed three times last turn starts clean this turn.
 */
export class RepeatFailureGuard {
  private readonly streaks = new Map<string, { count: number; lastError: string }>();

  /**
   * Consult before execution. Returns a refusal when this exact call has
   * already failed {@link REPEAT_FAILURE_REFUSAL_THRESHOLD} times in a row.
   *
   * The message names the repetition count AND quotes the prior failure, because
   * a bare "refused" tells the model nothing it can act on — the whole point is
   * to let it distinguish a fixable environment problem from a transient one.
   */
  check(call: ToolCall): RepeatFailureVerdict | null {
    const streak = this.streaks.get(repeatFailureFingerprint(call));
    if (streak === undefined || streak.count < REPEAT_FAILURE_REFUSAL_THRESHOLD) return null;
    return {
      count: streak.count,
      tool: call.name,
      result: {
        content:
          `Repeat-failure guard: "${call.name}" has already failed ${streak.count} times in a row ` +
          `with the same arguments, so this call was NOT executed again. The last failure was: ` +
          `${streak.lastError}\n\n` +
          `Retrying it verbatim will fail the same way. Fix the underlying cause, change the ` +
          `arguments, use a different tool, or stop and report the blocker.`,
        isError: true,
        failureClass: 'repeat-failure',
      },
    };
  }

  /**
   * Record a settled result. An error advances the streak; anything else clears
   * it, which is what keeps the guard scoped to unbroken failure runs.
   */
  note(call: ToolCall, result: ToolResult): void {
    const fingerprint = repeatFailureFingerprint(call);
    if (result.isError !== true) {
      this.streaks.delete(fingerprint);
      return;
    }
    const existing = this.streaks.get(fingerprint);
    this.streaks.set(fingerprint, {
      count: (existing?.count ?? 0) + 1,
      lastError: summarizeError(result),
    });
  }

  /** Current streak length for a call — exposed for tests and diagnostics. */
  streakFor(call: ToolCall): number {
    return this.streaks.get(repeatFailureFingerprint(call))?.count ?? 0;
  }
}
