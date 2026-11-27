/**
 * Tests for `TurnTrace` awaiting-user and paused timing fields (#4833).
 *
 * Verifies that:
 *   - `addAwaitingUser` / `addPaused` accumulate correctly across multiple calls
 *   - `finish()` includes the accumulated values on the `loop_end` phase event
 *   - Zero-ms and negative-ms inputs are ignored (never produce a negative total)
 *   - Fields are absent from `loop_end` when no time was recorded
 *
 * @module agent/providers/shared/turn-trace.awaiting-user.test
 */

import { describe, it, expect, vi } from 'vitest';
import { TurnTrace } from './turn-trace.js';
import type { TraceSink } from '../../trace/writer.js';
import type { TraceEventInput } from '../../trace/types.js';
import type { SessionPhasePayload } from '../../trace/types.session-phase.js';

// ---------------------------------------------------------------------------
// Minimal TraceSink stub — captures what gets written
// ---------------------------------------------------------------------------

function makeSink() {
  const written: TraceEventInput[] = [];
  const sink: TraceSink = {
    write: vi.fn(async (event: TraceEventInput) => {
      written.push(event);
    }),
    getTracePath: () => 'in-memory://trace',
  };
  return { sink, written };
}

function loopEndPayload(written: TraceEventInput[]): SessionPhasePayload | undefined {
  const ev = written.find(
    (e) => e.kind === 'session_phase' && (e.payload as SessionPhasePayload).phase === 'loop_end',
  );
  return ev ? (ev.payload as SessionPhasePayload) : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrace(sink: ReturnType<typeof makeSink>['sink']) {
  const ctrl = new AbortController();
  return { trace: new TurnTrace(ctrl.signal, sink, 'anthropic-direct'), ctrl };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TurnTrace#addAwaitingUser', () => {
  it('is absent on loop_end when no awaiting-user time was recorded', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.finish(100);
    const payload = loopEndPayload(written);
    expect(payload).toBeDefined();
    expect(payload!.awaitingUserMs).toBeUndefined();
  });

  it('reports awaitingUserMs when addAwaitingUser was called', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addAwaitingUser(500);
    trace.finish(1000);
    const payload = loopEndPayload(written);
    expect(payload!.awaitingUserMs).toBe(500);
  });

  it('accumulates across multiple elicitation calls', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addAwaitingUser(300);
    trace.addAwaitingUser(700);
    trace.addAwaitingUser(200);
    trace.finish(2000);
    const payload = loopEndPayload(written);
    expect(payload!.awaitingUserMs).toBe(1200);
  });

  it('ignores zero-ms calls', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addAwaitingUser(0);
    trace.finish(100);
    const payload = loopEndPayload(written);
    // Zero → still absent (threshold is > 0)
    expect(payload!.awaitingUserMs).toBeUndefined();
  });

  it('ignores negative-ms calls (clock skew guard)', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addAwaitingUser(-50);
    trace.finish(100);
    const payload = loopEndPayload(written);
    expect(payload!.awaitingUserMs).toBeUndefined();
  });
});

describe('TurnTrace#addPaused', () => {
  it('is absent on loop_end when no paused time was recorded', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.finish(100);
    const payload = loopEndPayload(written);
    expect(payload!.pausedMs).toBeUndefined();
  });

  it('reports pausedMs when addPaused was called', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addPaused(1500);
    trace.finish(2000);
    const payload = loopEndPayload(written);
    expect(payload!.pausedMs).toBe(1500);
  });

  it('accumulates across multiple park events', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addPaused(1000);
    trace.addPaused(500);
    trace.finish(3000);
    const payload = loopEndPayload(written);
    expect(payload!.pausedMs).toBe(1500);
  });

  it('ignores zero-ms calls', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addPaused(0);
    trace.finish(100);
    const payload = loopEndPayload(written);
    expect(payload!.pausedMs).toBeUndefined();
  });
});

describe('TurnTrace awaiting-user + paused combined', () => {
  it('reports both fields independently', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addAwaitingUser(400);
    trace.addPaused(600);
    trace.finish(2000);
    const payload = loopEndPayload(written);
    expect(payload!.awaitingUserMs).toBe(400);
    expect(payload!.pausedMs).toBe(600);
    // durationMs is still the whole-turn wall clock
    expect(payload!.durationMs).toBe(2000);
  });

  it('active time = durationMs - awaitingUserMs - pausedMs', () => {
    const { sink, written } = makeSink();
    const { trace } = makeTrace(sink);
    trace.addAwaitingUser(2673 * 60 * 1000); // 2673 min in ms
    trace.addAwaitingUser(99 * 60 * 1000);   // 99 min in ms
    trace.finish(2793 * 60 * 1000);          // 2793 min total
    const payload = loopEndPayload(written);
    const awaiting = payload!.awaitingUserMs ?? 0;
    const paused = payload!.pausedMs ?? 0;
    const active = payload!.durationMs! - awaiting - paused;
    // Active time should be 21 minutes (the remaining non-elicitation time)
    expect(active).toBe(21 * 60 * 1000);
  });
});
