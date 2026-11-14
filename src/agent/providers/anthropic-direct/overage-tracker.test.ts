/**
 * Overage header rule and tracker (#4883).
 */
import { describe, expect, it } from 'vitest';
import { classifyOverage, OverageTracker, overageUsageFields } from './overage-tracker.js';
import { InMemoryTraceWriter } from '../../trace/writer.js';

const P = 'anthropic-ratelimit-unified-';

function h(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('classifyOverage', () => {
  it('arm 1: overage-in-use true is overage', () => {
    const c = classifyOverage(h({ [`${P}overage-in-use`]: 'true', [`${P}status`]: 'allowed' }));
    expect(c).toMatchObject({ measured: true, overage: true });
  });

  it.each(['allowed', 'allowed_warning'])('arm 2: status rejected with overage-status %s is overage', (os) => {
    const c = classifyOverage(h({ [`${P}status`]: 'rejected', [`${P}overage-status`]: os }));
    expect(c).toMatchObject({ measured: true, overage: true });
  });

  it('arm 2 needs status rejected: allowed status with allowed overage-status is not overage', () => {
    const c = classifyOverage(h({ [`${P}status`]: 'allowed', [`${P}overage-status`]: 'allowed' }));
    expect(c).toMatchObject({ measured: true, overage: false });
  });

  it('arm 2 needs an allowed overage-status: rejected + rejected is not overage', () => {
    const c = classifyOverage(h({ [`${P}status`]: 'rejected', [`${P}overage-status`]: 'rejected' }));
    expect(c).toMatchObject({ measured: true, overage: false });
  });

  it('header names are case-insensitive and values are trimmed and case-folded', () => {
    const c = classifyOverage(h({ 'Anthropic-RateLimit-Unified-Overage-In-Use': ' TRUE ' }));
    expect(c).toMatchObject({ measured: true, overage: true });
    const d = classifyOverage(h({ 'ANTHROPIC-RATELIMIT-UNIFIED-STATUS': 'Rejected', 'anthropic-ratelimit-unified-OVERAGE-status': 'Allowed_Warning' }));
    expect(d.overage).toBe(true);
  });

  it('absent unified headers: not measured, not overage', () => {
    const c = classifyOverage(h({ 'content-type': 'text/event-stream', 'anthropic-ratelimit-requests-limit': '50' }));
    expect(c).toEqual({ measured: false, overage: false, evidence: {} });
  });

  it('unified headers present but no overage headers: measured, not overage', () => {
    const c = classifyOverage(h({ [`${P}5h-utilization`]: '0.2' }));
    expect(c).toMatchObject({ measured: true, overage: false });
  });

  it.each(['1', 'yes', 'tru', '', 'true;q=1', 'false'])('garbage overage-in-use %j is not overage', (v) => {
    const c = classifyOverage(h({ [`${P}overage-in-use`]: v, [`${P}status`]: 'allowed' }));
    expect(c.overage).toBe(false);
  });

  it('caps evidence values to short strings', () => {
    const c = classifyOverage(h({ [`${P}representative-claim`]: 'x'.repeat(500) }));
    expect(c.evidence.representativeClaim?.length).toBe(64);
  });
});

describe('overageUsageFields', () => {
  it('unmeasured response: no fields', () => {
    expect(overageUsageFields(undefined, 1)).toEqual({});
    expect(overageUsageFields({ measured: false, overage: false }, 1)).toEqual({});
  });
  it('measured, flagged, known cost: the response cost and one request', () => {
    expect(overageUsageFields({ measured: true, overage: true }, 0.25)).toEqual({ overageCostUsd: 0.25, overageRequests: 1 });
  });
  it('measured, not flagged: zeros', () => {
    expect(overageUsageFields({ measured: true, overage: false }, 0.25)).toEqual({ overageCostUsd: 0, overageRequests: 0 });
  });
  it('flagged with unknown cost is counted as not flagged (no guessed dollars)', () => {
    expect(overageUsageFields({ measured: true, overage: true }, undefined)).toEqual({ overageCostUsd: 0, overageRequests: 0 });
  });
});

describe('OverageTracker', () => {
  it('takeForResponse hands the latest observation once', () => {
    const t = new OverageTracker();
    t.observe(h({ [`${P}overage-in-use`]: 'true' }));
    expect(t.takeForResponse()).toEqual({ measured: true, overage: true });
    expect(t.takeForResponse()).toBeUndefined();
  });

  it('a later observation replaces an earlier one (retries keep only the response that streamed)', () => {
    const t = new OverageTracker();
    t.observe(h({ [`${P}overage-in-use`]: 'true' }));
    t.observe(h({ [`${P}status`]: 'allowed' }));
    expect(t.takeForResponse()).toEqual({ measured: true, overage: false });
    t.observe(h({ [`${P}status`]: 'allowed' }));
    t.observe(h({}));
    expect(t.takeForResponse()).toBeUndefined();
  });

  it('writes the raw-evidence record at first observation and on change only', async () => {
    const w = new InMemoryTraceWriter();
    const t = new OverageTracker(w);
    const allowed = { [`${P}status`]: 'allowed', [`${P}overage-status`]: 'allowed', [`${P}representative-claim`]: 'five_hour' };
    t.observe(h(allowed));
    t.observe(h(allowed));
    t.observe(h({ ...allowed, [`${P}5h-utilization`]: '0.9' }));
    t.observe(h({ ...allowed, [`${P}status`]: 'rejected' }));
    t.observe(h({ ...allowed, [`${P}status`]: 'rejected' }));
    t.observe(h({ 'content-type': 'x' }));
    await new Promise((r) => setTimeout(r, 0));
    const recs = w.events.filter((e) => e.kind === 'session_phase');
    expect(recs).toHaveLength(2);
    expect(recs[0]?.payload).toEqual({
      phase: 'ratelimit_unified_state',
      metadata: { status: 'allowed', overageStatus: 'allowed', representativeClaim: 'five_hour', overage: false },
    });
    expect(recs[1]?.payload).toMatchObject({ metadata: { status: 'rejected', overage: true } });
  });

  it('never throws, even when the writer throws or headers are broken', () => {
    const t = new OverageTracker({ write: () => { throw new Error('boom'); } } as never);
    expect(() => t.observe(h({ [`${P}status`]: 'allowed' }))).not.toThrow();
    expect(() => t.observe(null as unknown as Headers)).not.toThrow();
  });
});
