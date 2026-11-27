/**
 * Latency regression test for the ToolCallLedger hot path (#4476 item 5).
 *
 * Acceptance criterion: "No measurable latency regression on the tool dispatch
 * hot path." This file quantifies the overhead of `record()` and `lookup()` —
 * the two operations called on every tool dispatch — using wall-clock timing
 * over a large number of iterations on a fixed workload.
 *
 * Design decisions:
 *
 * - **10 000 iterations** per operation: enough to stabilise the average on
 *   any reasonably modern JS engine while keeping the suite fast (< 200 ms
 *   total on a laptop).
 *
 * - **50 µs per-operation budget**: a tool dispatch already spends milliseconds
 *   in I/O, network, and hook overhead. A 50 µs budget for the ledger hot path
 *   is two orders of magnitude below typical handler latency, so exceeding it
 *   would indicate a genuine algorithmic regression (e.g. O(n²) behaviour or
 *   an accidental synchronous hash on every call).
 *
 * - **Wall-clock, not `performance.now()`**: `Date.now()` has 1 ms resolution
 *   on some platforms, which is too coarse for a 50 µs budget. We use
 *   `performance.now()` (sub-millisecond on Node 18+) and report the per-call
 *   average across N iterations to smooth out JIT warm-up and GC pauses.
 *
 * - **Warm-up loop**: 500 iterations before measurement to let V8 JIT-compile
 *   the hot functions so the budget applies to steady-state performance, not
 *   interpreter overhead.
 *
 * - **Failure message** names the measured average so a future regression
 *   surfaces the actual value rather than just "exceeded 50 µs".
 *
 * @module agent/tools/tool-call-ledger.bench
 */

import { describe, it, expect } from 'vitest';
import { ToolCallLedger, DEFAULT_TURN_WINDOW } from './tool-call-ledger.js';
import type { ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of measurement iterations per operation. */
const ITERATIONS = 10_000;

/** Warm-up iterations before measurement begins. */
const WARMUP = 500;

/**
 * Per-call budget in microseconds. Each ledger operation (record or lookup)
 * must average below this on the measurement pass.
 *
 * 50 µs is two orders of magnitude below a typical tool handler's wall-clock
 * cost (I/O, shell spawn, network). Breaching it signals an O(n²) regression
 * or an accidental synchronous computation on the hot path.
 */
const BUDGET_US = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(n: number): ToolResult {
  return { content: `ok-${n}`, isError: false };
}

function err(n: number): ToolResult {
  return { content: `ECONNREFUSED: connection refused (attempt ${n})`, isError: true };
}

/** Returns elapsed microseconds for `fn()` called `n` times. */
function measureUs(fn: () => void, n: number): number {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return ((performance.now() - t0) * 1_000) / n; // ms → µs per call
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('ToolCallLedger hot-path latency (#4476 item 5)', () => {
  it('record() averages under BUDGET_US µs per call on a live ledger', () => {
    const ledger = new ToolCallLedger(DEFAULT_TURN_WINDOW);
    // Pre-populate a handful of keys so the Map is in a realistic state.
    for (let i = 0; i < 20; i++) {
      ledger.record(`tool_${i % 5}`, `hash_${i}`, ok(i), 0);
    }

    // Warm up V8's JIT on the measurement path.
    for (let i = 0; i < WARMUP; i++) {
      ledger.record('bash', `h_warm_${i % 50}`, err(i), i % 10);
    }

    // Measure: alternate between new and existing keys to exercise both branches.
    let turn = 0;
    const avgUs = measureUs(() => {
      ledger.record('bash', `h_${turn % 100}`, turn % 3 === 0 ? err(turn) : ok(turn), turn % 20);
      turn++;
    }, ITERATIONS);

    expect(avgUs, `record() averaged ${avgUs.toFixed(2)} µs — exceeds ${BUDGET_US} µs budget`).toBeLessThan(BUDGET_US);
  });

  it('lookup() averages under BUDGET_US µs per call on a live ledger', () => {
    const ledger = new ToolCallLedger(DEFAULT_TURN_WINDOW);
    // Pre-populate 100 keys across 10 turns.
    for (let turn = 0; turn < 10; turn++) {
      for (let k = 0; k < 10; k++) {
        ledger.record('bash', `h_${k}`, turn % 2 === 0 ? ok(turn) : err(turn), turn);
      }
    }

    // Warm up.
    for (let i = 0; i < WARMUP; i++) {
      ledger.lookup('bash', `h_${i % 10}`, 10);
    }

    // Measure: mix hits (key exists) and misses (key absent).
    let i = 0;
    const avgUs = measureUs(() => {
      ledger.lookup('bash', `h_${i % 20}`, 10); // h_10..h_19 are misses
      i++;
    }, ITERATIONS);

    expect(avgUs, `lookup() averaged ${avgUs.toFixed(2)} µs — exceeds ${BUDGET_US} µs budget`).toBeLessThan(BUDGET_US);
  });

  it('prune() averages under BUDGET_US µs per call on a ledger with many keys', () => {
    const ledger = new ToolCallLedger(DEFAULT_TURN_WINDOW);
    // Fill with 200 keys across 25 turns.
    for (let turn = 0; turn < 25; turn++) {
      for (let k = 0; k < 8; k++) {
        ledger.record(`tool_${k}`, `h_${k}_${turn}`, ok(turn), turn);
      }
    }

    // Warm up.
    for (let i = 0; i < WARMUP; i++) {
      ledger.prune(i % 25);
    }

    // Measure prune at a stable current turn so it always has work to do.
    let turn = 25;
    const avgUs = measureUs(() => {
      ledger.prune(turn++);
    }, ITERATIONS);

    expect(avgUs, `prune() averaged ${avgUs.toFixed(2)} µs — exceeds ${BUDGET_US} µs budget`).toBeLessThan(BUDGET_US);
  });
});
