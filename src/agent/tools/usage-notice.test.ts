/**
 * Tests for the fan-out usage notice: text on warn/over only, trace event
 * emitted alongside, nothing for ok / unknown / stale / non-Claude parents.
 *
 * @module agent/tools/usage-notice.test
 */

import { describe, it, expect } from 'vitest';
import { buildUsageNotice, evaluateDispatchUsage } from './usage-notice.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { USAGE_STALE_AFTER_MS, type UsageRecord } from '../usage/usage-record.js';
import { evaluateUsage } from '../usage/usage-budget.js';

function rec(opts: { fiveHour?: number; sevenDay?: number; fiveHourResetsAt?: number; ageMs?: number }): UsageRecord {
  return {
    v: 1,
    provider: 'anthropic',
    account: 'oauth',
    windows: {
      ...(opts.fiveHour !== undefined
        ? { fiveHour: { utilization: opts.fiveHour, ...(opts.fiveHourResetsAt !== undefined ? { resetsAt: opts.fiveHourResetsAt } : {}) } }
        : {}),
      ...(opts.sevenDay !== undefined ? { sevenDay: { utilization: opts.sevenDay } } : {}),
      observedAt: Date.now() - (opts.ageMs ?? 0),
    },
  };
}

function phaseEvents(writer: InMemoryTraceWriter) {
  return writer.events.filter((e) => e.kind === 'session_phase');
}

describe('buildUsageNotice', () => {
  it('returns undefined for ok and unknown', () => {
    expect(buildUsageNotice(evaluateUsage(rec({ fiveHour: 0.5 })))).toBeUndefined();
    expect(buildUsageNotice(evaluateUsage(undefined))).toBeUndefined();
  });

  it('formats warn / over from the binding window', () => {
    expect(buildUsageNotice(evaluateUsage(rec({ fiveHour: 0.86, sevenDay: 0.1 })))).toBe('Usage notice: Claude 5h window at 86%');
    expect(buildUsageNotice(evaluateUsage(rec({ fiveHour: 0.2, sevenDay: 1 })))).toBe('Usage notice: Claude 7d window at 100%');
  });

  it('includes the reset countdown when known', () => {
    const notice = buildUsageNotice(evaluateUsage(rec({ fiveHour: 0.86, fiveHourResetsAt: Date.now() + 61 * 60_000 })));
    expect(notice).toMatch(/^Usage notice: Claude 5h window at 86%, resets in 1h\dm$/);
  });
});

describe('evaluateDispatchUsage', () => {
  it('ignores non-Claude parents', async () => {
    const writer = new InMemoryTraceWriter();
    expect(await evaluateDispatchUsage('openai-compatible', writer, () => rec({ fiveHour: 0.95 }))).toBeUndefined();
    expect(phaseEvents(writer)).toHaveLength(0);
  });

  it.each([
    ['ok', () => rec({ fiveHour: 0.5 })],
    ['unknown', () => undefined],
    ['stale', () => rec({ fiveHour: 0.99, ageMs: USAGE_STALE_AFTER_MS + 1000 })],
  ])('adds nothing when %s', async (_label, read) => {
    const writer = new InMemoryTraceWriter();
    expect(await evaluateDispatchUsage('anthropic-direct', writer, read)).toBeUndefined();
    expect(phaseEvents(writer)).toHaveLength(0);
  });

  it('returns the notice and emits usage_notice on warn', async () => {
    const writer = new InMemoryTraceWriter();
    const resetsAt = Date.now() + 3_600_000;
    const result = await evaluateDispatchUsage('anthropic-direct', writer, () => rec({ fiveHour: 0.86, fiveHourResetsAt: resetsAt }));
    expect(result).toContain('Usage notice: Claude 5h window at 86%');
    const events = phaseEvents(writer);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== 'session_phase') throw new Error('unreachable');
    expect(ev.payload.phase).toBe('usage_notice');
    expect(ev.payload.metadata).toMatchObject({ level: 'warn', pct: 86, windowLabel: '5h', resetsAtMs: resetsAt });
  });

  it('emits level=over at 100%', async () => {
    const writer = new InMemoryTraceWriter();
    await evaluateDispatchUsage('anthropic-direct', writer, () => rec({ fiveHour: 1 }));
    const ev = phaseEvents(writer)[0]!;
    if (ev.kind !== 'session_phase') throw new Error('unreachable');
    expect(ev.payload.metadata?.level).toBe('over');
  });

  it('works without a trace writer', async () => {
    expect(await evaluateDispatchUsage('anthropic-direct', undefined, () => rec({ fiveHour: 0.9 }))).toBeTruthy();
  });
});
