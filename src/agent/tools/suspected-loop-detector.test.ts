import { describe, expect, it } from 'vitest';
import { SessionToolDispatcher } from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import type { ToolCall, ToolHandler } from './types.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import type { TraceEvent } from '../trace/types.js';
import {
  SUSPECTED_LOOP_THRESHOLD,
  SUSPECTED_LOOP_WINDOW_SIZE,
  createSuspectedLoopWindow,
  fingerprintToolCall,
  countInWindow,
  observeToolCall,
} from './suspected-loop-detector.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function call(name: string, input: unknown): ToolCall {
  return { id: `${name}-1`, name, input, signal: new AbortController().signal };
}

describe('suspected-loop-detector pure helpers', () => {
  it('thresholds are small fixed positive constants, window >= threshold', () => {
    expect(SUSPECTED_LOOP_THRESHOLD).toBe(5);
    expect(SUSPECTED_LOOP_WINDOW_SIZE).toBe(20);
    // The predicate can only ever fire when the window can hold `threshold` hits.
    expect(SUSPECTED_LOOP_WINDOW_SIZE).toBeGreaterThanOrEqual(SUSPECTED_LOOP_THRESHOLD);
  });

  it('fingerprintToolCall is a stable 64-hex sha256 and identical calls collide', () => {
    const a = fingerprintToolCall(call('read_file', { file_path: '/a.ts' }));
    const b = fingerprintToolCall(call('read_file', { file_path: '/a.ts' }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('different tool names or args yield different fingerprints', () => {
    const base = fingerprintToolCall(call('read_file', { file_path: '/a.ts' }));
    expect(fingerprintToolCall(call('grep', { file_path: '/a.ts' }))).not.toBe(base);
    expect(fingerprintToolCall(call('read_file', { file_path: '/b.ts' }))).not.toBe(base);
  });

  it('normalizes object key ORDER so semantically-identical calls collide', () => {
    // The whole point of a telemetry fingerprint: the SAME logical call recurs
    // regardless of incidental key serialization order.
    const one = fingerprintToolCall(call('grep', { pattern: 'x', path: '/p' }));
    const two = fingerprintToolCall(call('grep', { path: '/p', pattern: 'x' }));
    expect(one).toBe(two);
  });

  it('normalizes NESTED object key order too, but preserves array order', () => {
    const one = fingerprintToolCall(call('t', { a: { x: 1, y: 2 }, list: [1, 2] }));
    const two = fingerprintToolCall(call('t', { a: { y: 2, x: 1 }, list: [1, 2] }));
    expect(one).toBe(two);
    // Array order is semantic → different order is a different fingerprint.
    const three = fingerprintToolCall(call('t', { a: { x: 1, y: 2 }, list: [2, 1] }));
    expect(three).not.toBe(one);
  });

  it('does not throw on odd inputs (observe-only must never perturb dispatch)', () => {
    expect(() => fingerprintToolCall(call('t', undefined))).not.toThrow();
    expect(() => fingerprintToolCall(call('t', null))).not.toThrow();
    expect(() => fingerprintToolCall(call('t', 42))).not.toThrow();
  });

  it('countInWindow counts occurrences of a fingerprint', () => {
    expect(countInWindow(['a', 'b', 'a', 'a'], 'a')).toBe(3);
    expect(countInWindow(['a', 'b'], 'z')).toBe(0);
    expect(countInWindow([], 'a')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// observeToolCall — window mutation, threshold, debounce
// ---------------------------------------------------------------------------

describe('observeToolCall (pure window rule)', () => {
  it('fires exactly once, on the round the count first reaches threshold', () => {
    const w = createSuspectedLoopWindow();
    const fp = 'deadbeef';
    for (let i = 1; i < SUSPECTED_LOOP_THRESHOLD; i++) {
      const obs = observeToolCall(w, fp);
      expect(obs.fired).toBe(false);
      expect(obs.count).toBe(i);
    }
    // Threshold-th occurrence: first (and only) fire.
    const trip = observeToolCall(w, fp);
    expect(trip.fired).toBe(true);
    expect(trip.count).toBe(SUSPECTED_LOOP_THRESHOLD);
  });

  it('debounces: never fires again for the same fingerprint in the same window', () => {
    const w = createSuspectedLoopWindow();
    const fp = 'cafef00d';
    for (let i = 0; i < SUSPECTED_LOOP_THRESHOLD; i++) observeToolCall(w, fp);
    // Many more recurrences past the threshold — all silent.
    for (let i = 0; i < SUSPECTED_LOOP_WINDOW_SIZE * 2; i++) {
      expect(observeToolCall(w, fp).fired).toBe(false);
    }
  });

  it('detects an INTERLEAVED loop the consecutive repeat breaker would miss', () => {
    // A B A C A D A E A pattern: `A` recurs 5× within the window while never
    // appearing consecutively. This is precisely the gap this signal fills.
    const w = createSuspectedLoopWindow();
    const others = ['B', 'C', 'D', 'E'];
    let fired = false;
    // A once up front, then (other, A) pairs. A hits its 5th occurrence on the
    // 4th pair.
    observeToolCall(w, 'A');
    for (let i = 0; i < others.length; i++) {
      observeToolCall(w, others[i]!);
      const obs = observeToolCall(w, 'A');
      if (obs.fired) {
        fired = true;
        expect(obs.count).toBe(SUSPECTED_LOOP_THRESHOLD);
      }
    }
    expect(fired).toBe(true);
  });

  it('does NOT fire when a fingerprint ages out of the sliding window', () => {
    // Space `A` occurrences more than `window` apart with filler so no window
    // ever holds `threshold` copies at once.
    const w = createSuspectedLoopWindow();
    let everFired = false;
    for (let round = 0; round < SUSPECTED_LOOP_THRESHOLD; round++) {
      if (observeToolCall(w, 'A').fired) everFired = true;
      // Flood the window with unique fillers to evict the A before the next A.
      for (let f = 0; f < SUSPECTED_LOOP_WINDOW_SIZE; f++) {
        if (observeToolCall(w, `filler-${round}-${f}`).fired) everFired = true;
      }
    }
    expect(everFired).toBe(false);
  });

  it('bounds retained state to the window size (ring buffer eviction)', () => {
    const w = createSuspectedLoopWindow();
    for (let i = 0; i < SUSPECTED_LOOP_WINDOW_SIZE * 3; i++) {
      observeToolCall(w, `fp-${i}`);
    }
    expect(w.recent.length).toBe(SUSPECTED_LOOP_WINDOW_SIZE);
  });

  it('distinct-arg fan-out never fires (each round is a unique fingerprint)', () => {
    // Models the /review per-citation trap: same tool, DIFFERENT args each call.
    const w = createSuspectedLoopWindow();
    let everFired = false;
    for (let i = 0; i < SUSPECTED_LOOP_WINDOW_SIZE * 2; i++) {
      const fp = fingerprintToolCall(call('read_file', { file_path: `/cite-${i}.ts` }));
      if (observeToolCall(w, fp).fired) everFired = true;
    }
    expect(everFired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher integration — OBSERVE-ONLY invariant
// ---------------------------------------------------------------------------

const PARENT = 'parent-session-1';

function echoHandler(): ToolHandler {
  return async (input: unknown) => ({
    content: String((input as { message?: string }).message ?? 'ok'),
  });
}

/** A dispatcher wired like a forked child (parentSessionId set) by default. */
function makeDispatcher(opts?: {
  fork?: boolean;
  writer?: InMemoryTraceWriter;
}): SessionToolDispatcher {
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([
      ['echo', echoHandler()],
      ['echo2', echoHandler()],
    ]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: ['echo', 'echo2'] },
    ...(opts?.fork !== false ? { parentSessionId: PARENT } : {}),
    ...(opts?.writer ? { traceWriter: opts.writer } : {}),
  });
}

function echoCall(message: string, name = 'echo'): ToolCall {
  return { id: `${name}-${message}`, name, input: { message }, signal: new AbortController().signal };
}

function suspectedLoopEvents(writer: InMemoryTraceWriter): TraceEvent[] {
  return writer.events.filter(
    (e) => e.kind === 'session_phase' && e.payload.phase === 'suspected_loop',
  );
}

describe('suspected-loop detector — dispatcher integration (OBSERVE-ONLY)', () => {
  it('emits ONE suspected_loop trace event on the threshold-th identical forked call', async () => {
    const writer = new InMemoryTraceWriter();
    const d = makeDispatcher({ writer });

    // The first THRESHOLD-1 identical calls: no emission yet.
    for (let i = 0; i < SUSPECTED_LOOP_THRESHOLD - 1; i++) {
      const r = await d.execute(echoCall('same'));
      expect(r.isError).toBeUndefined();
      expect(r.content).toBe('same');
    }
    expect(suspectedLoopEvents(writer)).toHaveLength(0);

    // Threshold-th call: exactly one emission, carrying { tool, count, windowSize }.
    const trip = await d.execute(echoCall('same'));
    const events = suspectedLoopEvents(writer);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== 'session_phase') throw new Error('unreachable');
    expect(ev.payload.metadata).toEqual({
      tool: 'echo',
      count: SUSPECTED_LOOP_THRESHOLD,
      windowSize: SUSPECTED_LOOP_WINDOW_SIZE,
    });

    // OBSERVE-ONLY: the tripping call still ran the handler and returned the
    // normal result — no error, no failureClass, content unchanged.
    expect(trip.isError).toBeUndefined();
    expect(trip.content).toBe('same');
    expect(trip.failureClass).toBeUndefined();
    expect(trip.circuitBreaker).toBeUndefined();
  });

  it('debounces: further identical calls after the first fire emit nothing more', async () => {
    const writer = new InMemoryTraceWriter();
    const d = makeDispatcher({ writer });
    // Interleave a distinct filler tool so the CONSECUTIVE repeat circuit
    // breaker (an orthogonal mechanism, threshold 8) never trips — this test
    // isolates the windowed observe-only signal, which must fire exactly once
    // for echo("same") no matter how many more times it recurs.
    for (let i = 0; i < (SUSPECTED_LOOP_THRESHOLD + 10) * 2; i++) {
      const r =
        i % 2 === 0
          ? await d.execute(echoCall('same'))
          : await d.execute(echoCall(`filler-${i}`, 'echo2'));
      // Every call keeps returning the real result — never blocked.
      expect(r.isError).toBeUndefined();
    }
    expect(suspectedLoopEvents(writer)).toHaveLength(1);
  });

  it('NEVER emits for a top-level (non-forked) session, no matter how many repeats', async () => {
    const writer = new InMemoryTraceWriter();
    const d = makeDispatcher({ fork: false, writer });
    // Interleave a filler so the consecutive repeat breaker does not trip; the
    // point of this test is that even sustained windowed repetition emits no
    // suspected_loop signal for a top-level session (it is forked-only scoped).
    for (let i = 0; i < SUSPECTED_LOOP_WINDOW_SIZE * 2; i++) {
      const r =
        i % 2 === 0
          ? await d.execute(echoCall('same'))
          : await d.execute(echoCall(`filler-${i}`, 'echo2'));
      expect(r.isError).toBeUndefined();
    }
    expect(suspectedLoopEvents(writer)).toHaveLength(0);
  });

  it('detects an INTERLEAVED loop across tool rounds (echo … echo2 … echo …)', async () => {
    const writer = new InMemoryTraceWriter();
    const d = makeDispatcher({ writer });
    // echo("same") once, then (echo2, echo("same")) pairs. echo("same") hits its
    // THRESHOLD-th occurrence within the window even though never consecutive.
    await d.execute(echoCall('same'));
    for (let i = 0; i < SUSPECTED_LOOP_THRESHOLD; i++) {
      await d.execute(echoCall(`filler-${i}`, 'echo2'));
      await d.execute(echoCall('same'));
    }
    const events = suspectedLoopEvents(writer);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0]!;
    if (ev.kind !== 'session_phase') throw new Error('unreachable');
    expect(ev.payload.metadata?.['tool']).toBe('echo');
  });

  it('does NOT emit for distinct-arg fan-out (same tool, different input each call)', async () => {
    const writer = new InMemoryTraceWriter();
    const d = makeDispatcher({ writer });
    for (let i = 0; i < SUSPECTED_LOOP_WINDOW_SIZE * 2; i++) {
      await d.execute(echoCall(`distinct-${i}`));
    }
    expect(suspectedLoopEvents(writer)).toHaveLength(0);
  });

  it('normalizes key order: {a,b} and {b,a} count as the SAME fingerprint', async () => {
    const writer = new InMemoryTraceWriter();
    const d = makeDispatcher({ writer });
    // Alternate key order every call; all THRESHOLD count as one fingerprint.
    for (let i = 0; i < SUSPECTED_LOOP_THRESHOLD; i++) {
      const input = i % 2 === 0 ? { message: 'x', extra: 1 } : { extra: 1, message: 'x' };
      await d.execute({
        id: `k-${i}`,
        name: 'echo',
        input,
        signal: new AbortController().signal,
      });
    }
    expect(suspectedLoopEvents(writer)).toHaveLength(1);
  });

  it('works with no traceWriter attached — never throws, still observe-only', async () => {
    // No writer: emission is a silent no-op (emitSessionPhase early-returns).
    // Stay at THRESHOLD+2 consecutive identical calls: enough to cross the
    // suspected-loop threshold (5) and exercise the fire path, but under the
    // orthogonal repeat circuit breaker's consecutive limit (8) so results are
    // the real handler output.
    const d = makeDispatcher();
    for (let i = 0; i < SUSPECTED_LOOP_THRESHOLD + 2; i++) {
      const r = await d.execute(echoCall('same'));
      expect(r.content).toBe('same');
      expect(r.isError).toBeUndefined();
    }
  });

  it('fires on the batch path too, without altering any batched result', async () => {
    const writer = new InMemoryTraceWriter();
    const d = makeDispatcher({ writer });
    const calls = Array.from({ length: SUSPECTED_LOOP_THRESHOLD }, (_, i) => ({
      id: `b-${i}`,
      name: 'echo',
      input: { message: 'same' },
      signal: new AbortController().signal,
    }));
    const results = await d.executeBatch(calls);
    // Every batched call returned its real result — observe-only never blocks.
    for (const r of results) {
      expect(r?.content).toBe('same');
      expect(r?.isError).toBeUndefined();
      expect(r?.failureClass).toBeUndefined();
    }
    expect(suspectedLoopEvents(writer)).toHaveLength(1);
  });

  it('a fresh dispatcher (next turn) starts with a clean window', async () => {
    const w1 = new InMemoryTraceWriter();
    const d1 = makeDispatcher({ writer: w1 });
    for (let i = 0; i < SUSPECTED_LOOP_THRESHOLD; i++) await d1.execute(echoCall('same'));
    expect(suspectedLoopEvents(w1)).toHaveLength(1);

    // New dispatcher == new query/turn: window resets, so the count restarts.
    const w2 = new InMemoryTraceWriter();
    const d2 = makeDispatcher({ writer: w2 });
    for (let i = 0; i < SUSPECTED_LOOP_THRESHOLD - 1; i++) await d2.execute(echoCall('same'));
    expect(suspectedLoopEvents(w2)).toHaveLength(0);
  });
});
