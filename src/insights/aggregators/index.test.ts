/**
 * Tests for the aggregator barrel (`aggregateAll` + `safeAggregate`).
 *
 * The PR's headline defensive-aggregation guarantee — "one bad source can
 * never break the whole report; a throwing aggregator falls back to its
 * zero-aggregate and the other three still populate" — previously shipped
 * with ZERO regression coverage. These tests force one aggregator to throw
 * (via module mocks that keep the real zero-factories through `importActual`)
 * and assert (a) `aggregateAll` does not reject, (b) the thrown source comes
 * back as its zero-aggregate, (c) the other three still populate, and
 * (d) the failure is observable on stderr (never silent).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Force ONE aggregator (traces) to throw; make the other three return a
// recognizable non-zero value built from their real zero-factory. Using
// `importActual` keeps the genuine zero-factories (the fallback path) intact
// so we exercise the real backstop, not a stubbed one.
vi.mock('./sessions.js', async (importActual) => {
  const actual = await importActual<typeof import('./sessions.js')>();
  return {
    ...actual,
    aggregateSessions: vi.fn(() => ({ ...actual.zeroSessionAggregates(), totalSessions: 7 })),
  };
});
vi.mock('./traces.js', async (importActual) => {
  const actual = await importActual<typeof import('./traces.js')>();
  return {
    ...actual,
    aggregateTraces: vi.fn(() => {
      throw new Error('boom-traces');
    }),
  };
});
vi.mock('./daemon.js', async (importActual) => {
  const actual = await importActual<typeof import('./daemon.js')>();
  return {
    ...actual,
    aggregateDaemonTelemetry: vi.fn(() => ({ ...actual.zeroDaemonAggregates(), totalRuns: 3 })),
  };
});
vi.mock('./routing.js', async (importActual) => {
  const actual = await importActual<typeof import('./routing.js')>();
  return {
    ...actual,
    aggregateRoutingDecisions: vi.fn(() => ({ ...actual.zeroRoutingAggregates(), totalRoutingEvents: 4 })),
  };
});

import { aggregateAll } from './index.js';
import { zeroTraceAggregates } from './traces.js';

// Silence (and capture) the expected "[insights] traces aggregator failed"
// warning that fires in every test here — traces is mocked to throw on
// purpose. Returns the spy so a test can inspect its call history; the
// inferred return type carries `.mock.calls` (an explicit annotation like
// `ReturnType<typeof vi.spyOn>` mistypes it and fails a tests-inclusive tsc).
function silenceStderr() {
  return vi.spyOn(process.stderr, 'write').mockReturnValue(true);
}

describe('aggregateAll — barrel crash-safety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not reject when one aggregator throws', async () => {
    silenceStderr();
    await expect(aggregateAll({ days: 30 })).resolves.toBeDefined();
  });

  it('the throwing source (traces) falls back to its zero-aggregate', async () => {
    silenceStderr();
    const result = await aggregateAll({ days: 30 });
    expect(result.traces).toEqual(zeroTraceAggregates());
  });

  it('the other three sources still populate despite the traces throw', async () => {
    silenceStderr();
    const result = await aggregateAll({ days: 30 });
    expect(result.sessions.totalSessions).toBe(7);
    expect(result.daemon.totalRuns).toBe(3);
    expect(result.routing.totalRoutingEvents).toBe(4);
  });

  it('the failure is observable: a stderr warning names the failed source', async () => {
    const stderrSpy = silenceStderr();
    await aggregateAll({ days: 30 });
    const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(calls).toContain('[insights]');
    expect(calls).toContain('traces');
    expect(calls).toContain('boom-traces');
  });
});
