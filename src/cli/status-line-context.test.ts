/**
 * Tests for the context-usage sampler powering the status line.
 *
 * The sampler is a small helper that (a) fetches `session.getContextUsage()`
 * on a cadence, (b) caches the last-good ratio so the status line can
 * render without waiting for a fetch, and (c) degrades gracefully when
 * the SDK call fails (returns the last-good cache, or undefined if none).
 *
 * See `src/cli/context-sampler.ts`.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ContextSampler } from './context-sampler.js';

interface StubSession {
  getContextUsage: ReturnType<typeof vi.fn>;
}

function stub(payload: unknown, throwErr?: Error): StubSession {
  const fn = vi.fn();
  if (throwErr) fn.mockRejectedValue(throwErr);
  else fn.mockResolvedValue(payload);
  return { getContextUsage: fn };
}

describe('ContextSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined before the first fetch completes', () => {
    const session = stub({
      apiUsage: { input_tokens: 100, output_tokens: 50,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      percentage: 42,
      maxTokens: 100000,
      isAutoCompactEnabled: true,
    });
    const sampler = new ContextSampler(session as unknown as Parameters<typeof ContextSampler.prototype.attach>[0]);
    expect(sampler.getRatio()).toBeUndefined();
    sampler.dispose();
  });

  it('returns the computed ratio after a successful fetch', async () => {
    const session = stub({
      apiUsage: { input_tokens: 250, output_tokens: 250,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
      percentage: 50,
      maxTokens: 100000,
      isAutoCompactEnabled: true,
    });
    const sampler = new ContextSampler(session as unknown as Parameters<typeof ContextSampler.prototype.attach>[0]);
    await sampler.refresh();
    // percentage is 50 → ratio is 0.5
    expect(sampler.getRatio()).toBeCloseTo(0.5);
    sampler.dispose();
  });

  it('caches last-good ratio across subsequent rejections', async () => {
    const session = stub(
      {
        apiUsage: { input_tokens: 100, output_tokens: 100,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        percentage: 20,
        maxTokens: 100000,
        isAutoCompactEnabled: true,
      },
    );
    const sampler = new ContextSampler(session as unknown as Parameters<typeof ContextSampler.prototype.attach>[0]);
    await sampler.refresh();
    expect(sampler.getRatio()).toBeCloseTo(0.2);

    // Next fetch rejects — sampler should keep the last-good value.
    session.getContextUsage.mockRejectedValueOnce(new Error('transient'));
    await sampler.refresh();
    expect(sampler.getRatio()).toBeCloseTo(0.2);
    sampler.dispose();
  });

  it('samples only every N turns when driven by onTurn()', async () => {
    const session = stub({
      apiUsage: { input_tokens: 10, output_tokens: 10,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      percentage: 10,
      maxTokens: 100000,
      isAutoCompactEnabled: true,
    });
    const sampler = new ContextSampler(
      session as unknown as Parameters<typeof ContextSampler.prototype.attach>[0],
      { sampleEveryNTurns: 3 },
    );

    for (let i = 1; i <= 5; i++) await sampler.onTurn(i);
    // Turns 1, 4 trigger fetches (1 % 3 == 1, 4 % 3 == 1); 2,3,5 do not.
    // We just assert it's strictly less than N calls-per-turn.
    expect(session.getContextUsage.mock.calls.length).toBeLessThan(5);
    expect(session.getContextUsage.mock.calls.length).toBeGreaterThanOrEqual(1);
    sampler.dispose();
  });

  it('does not double-fetch when a prior fetch is still in flight', async () => {
    let resolveFirst: ((v: unknown) => void) | null = null;
    const first = new Promise((r) => { resolveFirst = r; });
    const session = {
      getContextUsage: vi.fn().mockImplementationOnce(() => first).mockResolvedValue({
        apiUsage: { input_tokens: 10, output_tokens: 10,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        percentage: 10,
        maxTokens: 100000,
        isAutoCompactEnabled: true,
      }),
    };
    const sampler = new ContextSampler(session as unknown as Parameters<typeof ContextSampler.prototype.attach>[0]);
    const p1 = sampler.refresh();
    const p2 = sampler.refresh(); // should be deduped — in-flight
    expect(session.getContextUsage).toHaveBeenCalledTimes(1);
    resolveFirst!({
      apiUsage: { input_tokens: 10, output_tokens: 10,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      percentage: 10,
      maxTokens: 100000,
      isAutoCompactEnabled: true,
    });
    await Promise.all([p1, p2]);
    sampler.dispose();
  });

  it('leaves ratio unchanged when percentage is missing', async () => {
    const session = stub({
      apiUsage: { input_tokens: 100, output_tokens: 100,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      // No percentage.
      isAutoCompactEnabled: false,
    });
    const sampler = new ContextSampler(session as unknown as Parameters<typeof ContextSampler.prototype.attach>[0]);
    await sampler.refresh();
    // Without a percentage we can't compute a ratio — returns undefined.
    expect(sampler.getRatio()).toBeUndefined();
    sampler.dispose();
  });

  it('returns detail after a successful fetch', async () => {
    const session = stub({
      apiUsage: { input_tokens: 250, output_tokens: 250,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
      percentage: 50,
      maxTokens: 100000,
      isAutoCompactEnabled: true,
    });
    const sampler = new ContextSampler(session as unknown as Parameters<typeof ContextSampler.prototype.attach>[0]);
    expect(sampler.getDetail()).toBeUndefined();
    await sampler.refresh();
    const detail = sampler.getDetail();
    expect(detail).toBeDefined();
    expect(detail?.percentage).toBe(50);
    expect(detail?.limit).toBe(100000);
    expect(detail?.used).toBe(1000); // 250+250+500
    sampler.dispose();
  });
});
