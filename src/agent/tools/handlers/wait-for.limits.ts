/**
 * Limit notices for the `wait_for` tool.
 *
 * `parseInput` clamps `timeout_ms` into [0, MAX_TIMEOUT_MS] and raises
 * `poll_interval_ms` to MIN_POLL_INTERVAL_MS rather than rejecting, so a large
 * request still makes forward progress. These helpers make that adjustment
 * visible to the model instead of silent, mirroring the `node_timeout_ms
 * clamped:` warning `compose` already emits (compose-input-parse.ts).
 *
 * Contract: `clampNotes` reads the RAW tool input and must only be called after
 * `parseInput` succeeded, so both fields are known to be finite numbers or
 * absent. It returns one sentence per adjusted field, in field order, and an
 * empty array when nothing was adjusted.
 *
 * @module agent/tools/handlers/wait-for.limits
 */

import { MAX_TIMEOUT_MS, MIN_POLL_INTERVAL_MS } from './wait-for-poller.js';

/** Appended to a `timed_out` result so the model knows the condition never held. */
export const TIMED_OUT_HINT =
  'Condition not met within the timeout. Call wait_for again if it is still needed.';

export function clampNotes(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const input = raw as { timeout_ms?: unknown; poll_interval_ms?: unknown };
  const notes: string[] = [];

  const timeout = input.timeout_ms;
  if (typeof timeout === 'number' && timeout > MAX_TIMEOUT_MS) {
    notes.push(
      `timeout_ms clamped: requested ${timeout}ms exceeds the maximum ` +
      `${MAX_TIMEOUT_MS}ms; using ${MAX_TIMEOUT_MS}ms.`,
    );
  } else if (typeof timeout === 'number' && timeout < 0) {
    notes.push(`timeout_ms clamped: requested ${timeout}ms is negative; using 0ms.`);
  }

  const poll = input.poll_interval_ms;
  if (typeof poll === 'number' && poll < MIN_POLL_INTERVAL_MS) {
    notes.push(
      `poll_interval_ms raised: requested ${poll}ms is below the minimum ` +
      `${MIN_POLL_INTERVAL_MS}ms; using ${MIN_POLL_INTERVAL_MS}ms.`,
    );
  }

  return notes;
}
