import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextGuardFraction, contextPressure, projectedContextTokens, traceContextPressure } from './context-pressure.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('projectedContextTokens', () => {
  it('projects from one round and appended bytes, not cumulative billing usage', () => {
    expect(projectedContextTokens(1000, 300)).toBe(1100);
  });
});

describe('contextPressure', () => {
  it('below threshold: no wind-down', () => {
    expect(contextPressure(1000, 300, 2000)).toBe(false);
  });
  it('at threshold: fires', () => {
    // 1600 + ceil(300/3)=100 = 1700 >= 2000*0.95=1900? No. Use exact values.
    // 1800 + 0 = 1800 >= 2000*0.90=1800 -> true
    expect(contextPressure(1800, 0, 2000, 0.90)).toBe(true);
  });
  it('above threshold: fires', () => {
    // 1900 + ceil(0/3)=0 = 1900. 2000*0.95=1900. 1900 >= 1900 -> true
    expect(contextPressure(1900, 0, 2000, 0.95)).toBe(true);
    // 1850 + ceil(300/3)=100 = 1950. 2000*0.95=1900. 1950 >= 1900 -> true
    expect(contextPressure(1850, 300, 2000, 0.95)).toBe(true);
  });
  it('limit=0 disables guard', () => {
    expect(contextPressure(10_000, 100_000, 0)).toBe(false);
  });
  it('respects custom fraction', () => {
    // limit=1000, fraction=0.80: threshold=800. projected=800+0=800. 800>=800 -> true
    expect(contextPressure(800, 0, 1000, 0.80)).toBe(true);
    // projected=799: false
    expect(contextPressure(799, 0, 1000, 0.80)).toBe(false);
  });
});

describe('contextGuardFraction', () => {
  it('codex-subscription: defaults to 0.95', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    expect(contextGuardFraction('codex-subscription')).toBe(0.95);
  });
  it('openai-api: defaults to 0.95 (same as subscription route)', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    expect(contextGuardFraction('openai-api')).toBe(0.95);
  });
  it('openai-api: custom percent applies', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', '90');
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    expect(contextGuardFraction('openai-api')).toBe(0.90);
  });
  it('off switch: AFK_CONTEXT_GUARD_DISABLE=1 returns null for subscription route', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', '1');
    expect(contextGuardFraction('codex-subscription')).toBe(null);
  });
  it('off switch: various truthy values', () => {
    for (const v of ['true', 'yes', 'on', 'YES', 'TRUE']) {
      vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', v);
      expect(contextGuardFraction('codex-subscription'), `value=${v}`).toBe(null);
    }
  });
  it('off switch: falsy values do not disable', () => {
    for (const v of ['0', 'false', 'no', 'off', '']) {
      vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', v);
      vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
      const result = contextGuardFraction('codex-subscription');
      expect(result, `value=${v}`).toBe(0.95);
    }
  });
  it('custom percent parses correctly', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', '90');
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    expect(contextGuardFraction('codex-subscription')).toBe(0.90);
  });
  it('out-of-range percent falls back to 95', () => {
    for (const v of ['0', '100', '-5', 'banana', '']) {
      vi.stubEnv('AFK_CONTEXT_GUARD_PCT', v);
      vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
      expect(contextGuardFraction('codex-subscription'), `value=${v}`).toBe(0.95);
    }
  });
  it('anthropic route: enabled when AFK_CONTEXT_GUARD_PCT is set', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', '85');
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    expect(contextGuardFraction('anthropic')).toBe(0.85);
  });
  it('anthropic route: defaults to 0.95 when not set', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    expect(contextGuardFraction('anthropic')).toBe(0.95);
  });
});

describe('traceContextPressure', () => {
  it('trace failure cannot change guard behavior', async () => {
    traceContextPressure({ write: async () => { throw new Error('offline'); } }, 100, 120);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(contextPressure(100, 0, 120)).toBe(false);
  });
  it('emits the actual fraction in the trace, not a hardcoded value', async () => {
    const events: unknown[] = [];
    const sink = { write: async (ev: unknown) => { events.push(ev); } };
    traceContextPressure(sink, 245_000, 258_400, 0.95);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.length).toBeGreaterThan(0);
    const ev = events[0] as { payload?: { metadata?: { operationalThresholdTokens?: number; operationalThresholdFraction?: number } } };
    expect(ev.payload?.metadata?.operationalThresholdFraction).toBe(0.95);
    expect(ev.payload?.metadata?.operationalThresholdTokens).toBe(Math.round(258_400 * 0.95));
  });
});
