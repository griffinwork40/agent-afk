/**
 * OBSERVE-ONLY suspected-loop telemetry for forked sub-agents.
 *
 * A forked child can get stuck issuing the SAME tool call with the SAME
 * (normalized) arguments over and over inside a single turn — a genuine
 * busy-loop that makes no progress. The two enforcing breakers do NOT measure
 * this class as data:
 *   - the repeat breaker ({@link import('./repeat-circuit-breaker.js')}) only
 *     catches CONSECUTIVE byte-identical calls (an A A A run), and it ABORTS;
 *   - the denial breaker ({@link import('./denial-circuit-breaker.js')}) only
 *     catches consecutive path-approval read denials, and it ABORTS.
 *
 * This detector closes an OBSERVABILITY gap, not an enforcement one. It flags a
 * fingerprint that recurs within a sliding window even when interleaved with
 * other calls (an A B A C A … pattern the consecutive repeat breaker misses),
 * and its ONLY effect is a `suspected_loop` trace emission on the witness side
 * channel. It is pure data-gathering to answer "do real busy-loops happen in
 * practice?" BEFORE deciding whether an enforcing loop-detector is ever
 * warranted.
 *
 * THE CRITICAL INVARIANT — OBSERVE-ONLY. This module and its dispatcher wiring
 * MUST NEVER abort the fork, NEVER set a `failureClass`, NEVER alter or delay a
 * tool result, and NEVER change control flow. Everything here is a pure
 * predicate over a bounded ring buffer plus a debounce flag; the sole side
 * effect (a fire-and-forget trace write) lives at the dispatcher call site.
 *
 * The stateful window (per-dispatcher, so per-forked-query) lives on
 * `SessionToolDispatcher` as a {@link SuspectedLoopWindow}; the pure fingerprint
 * function, the recurrence predicate, the window mutator, and the fixed
 * thresholds live here. Mirrors the fixed-constant + pure-helper style of the
 * two breaker files.
 *
 * Scope: the dispatcher gates this to FORKED children only (a `parentSessionId`
 * check, exactly like the denial breaker) so interactive sessions — where the
 * operator drives the loop and legitimate repetition is common — never emit.
 *
 * NOTE ON WHAT THIS DELIBERATELY DOES NOT CATCH: distinct-arg fan-out. The
 * documented `/review` per-citation trap issues a fresh call with DIFFERENT args
 * each round, so no fingerprint recurs — it never fires here, and that is
 * correct. That trap is budget-shaped and handled elsewhere; this signal
 * targets GENUINE (tool, args) repetition only.
 *
 * @module agent/tools/suspected-loop-detector
 */

import { createHash } from 'node:crypto';
import type { ToolCall } from '../providers/anthropic-direct/types.js';

/**
 * Recurrence count that constitutes a "suspected loop": a fingerprint seen this
 * many times within the last {@link SUSPECTED_LOOP_WINDOW_SIZE} tool rounds.
 * Fixed constant, in the style of `REPEAT_CIRCUIT_BREAKER_THRESHOLD` /
 * `DENIAL_CIRCUIT_BREAKER_THRESHOLD`.
 *
 * Chosen at 5 (within a window of 20): high enough that ordinary, legitimate
 * repetition (a couple of re-reads of the same file, a retried grep) never
 * trips, while still catching a fork that keeps returning to the exact same
 * no-progress call several times across a 20-round window. Because this is
 * OBSERVE-ONLY, a mildly conservative threshold is the right default — a missed
 * marginal loop costs nothing, whereas a noisy false positive would pollute the
 * very telemetry this exists to gather. Tune only against real trace data.
 */
export const SUSPECTED_LOOP_THRESHOLD = 5;

/**
 * Sliding-window size, in tool rounds, over which {@link SUSPECTED_LOOP_THRESHOLD}
 * recurrences are counted. Fixed constant. At 20 rounds the window is wide
 * enough to span an interleaved loop (A B A C A D A … — which the CONSECUTIVE
 * repeat breaker cannot see) yet bounded so retained state is O(20) fingerprints
 * per dispatcher and the signal reflects RECENT behavior, not the whole turn.
 * Must be >= {@link SUSPECTED_LOOP_THRESHOLD} for the predicate to ever be able
 * to fire.
 */
export const SUSPECTED_LOOP_WINDOW_SIZE = 20;

/**
 * Per-dispatcher mutable state for the observe-only detector. Held on
 * `SessionToolDispatcher` (one per forked `query()`, so this is per-turn and
 * resets between turns via dispatcher reconstruction — exactly like the two
 * breakers' state).
 *
 * - `recent` is a bounded ring buffer (FIFO, capped at
 *   {@link SUSPECTED_LOOP_WINDOW_SIZE}) of the most recent fingerprints.
 * - `firedFingerprints` records the fingerprints already reported this turn so
 *   the signal emits AT MOST ONCE per detected loop (debounce) rather than on
 *   every round once the threshold is first crossed. Once a fingerprint fires,
 *   its later recurrences within the same turn are silent.
 */
export interface SuspectedLoopWindow {
  /** FIFO of recent fingerprints, oldest first, length <= window size. */
  recent: string[];
  /** Fingerprints already emitted this turn (debounce set). */
  firedFingerprints: Set<string>;
}

/** A fresh, empty detector window. */
export function createSuspectedLoopWindow(): SuspectedLoopWindow {
  return { recent: [], firedFingerprints: new Set<string>() };
}

/**
 * Stable fingerprint of a tool call for recurrence detection: sha256 over
 * `name \0 canonicalJSON(input)`. Hashing bounds retained state to 64 hex chars
 * regardless of input size.
 *
 * Unlike {@link import('./repeat-circuit-breaker.js').repeatCallFingerprint},
 * which relies on the model serializing byte-identical tool_use blocks
 * identically, this NORMALIZES the argument object by sorting keys recursively
 * before stringifying. Two calls that are semantically the same but differ only
 * in key order (`{a,b}` vs `{b,a}`) therefore collide — the right behavior for a
 * telemetry signal whose whole point is detecting the SAME logical call
 * recurring, independent of incidental serialization order.
 */
export function fingerprintToolCall(call: ToolCall): string {
  let input: string;
  try {
    input = canonicalStringify(call.input);
  } catch {
    // Defensive: a value that cannot be canonicalized (unexpected shape,
    // circular ref) still yields a stable-ish string. Never throws — an
    // observe-only path must not perturb dispatch.
    input = String(call.input);
  }
  return createHash('sha256').update(call.name).update('\u0000').update(input).digest('hex');
}

/**
 * Deterministic JSON stringify with recursively sorted object keys, so
 * key-order differences never change the fingerprint. Arrays keep their order
 * (order is semantic there); primitives stringify as normal JSON. Falls back to
 * `JSON.stringify` semantics for `undefined`/functions (dropped) to stay a pure
 * value→string map.
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? 'null';
}

/** Recursively sort object keys; leave arrays and primitives structurally intact. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = sortDeep(src[key]);
    }
    return out;
  }
  return value;
}

/** Outcome of pushing one fingerprint into the window. */
export interface SuspectedLoopObservation {
  /**
   * True only on the FIRST round where `fingerprint` crosses
   * {@link SUSPECTED_LOOP_THRESHOLD} within the window AND has not already been
   * reported this turn. This is the single edge the caller emits on; it can be
   * true at most once per fingerprint per turn (debounce).
   */
  fired: boolean;
  /** Occurrences of `fingerprint` within the current window (post-push). */
  count: number;
}

/**
 * Pure recurrence predicate: count how many times `fingerprint` appears in the
 * current window contents. Exported for direct unit testing of the core rule.
 */
export function countInWindow(recent: readonly string[], fingerprint: string): number {
  let n = 0;
  for (const f of recent) if (f === fingerprint) n += 1;
  return n;
}

/**
 * Push `fingerprint` into the bounded window and evaluate the observe-only
 * suspected-loop rule. Mutates `window` in place:
 *   1. append the fingerprint, evicting the oldest if the ring is full;
 *   2. count its occurrences in the resulting window;
 *   3. report `fired: true` iff the count is at or above the threshold AND this
 *      fingerprint has not already fired this turn (then latch it so later
 *      recurrences stay silent — the debounce).
 *
 * PURELY observational: returns a verdict; performs no I/O, no abort, no result
 * mutation. The caller owns the (fire-and-forget) trace emission.
 */
export function observeToolCall(
  window: SuspectedLoopWindow,
  fingerprint: string,
): SuspectedLoopObservation {
  window.recent.push(fingerprint);
  if (window.recent.length > SUSPECTED_LOOP_WINDOW_SIZE) {
    window.recent.shift();
  }
  const count = countInWindow(window.recent, fingerprint);
  if (count >= SUSPECTED_LOOP_THRESHOLD && !window.firedFingerprints.has(fingerprint)) {
    window.firedFingerprints.add(fingerprint);
    return { fired: true, count };
  }
  return { fired: false, count };
}
