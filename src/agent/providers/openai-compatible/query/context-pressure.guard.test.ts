/**
 * Validation tests for the configurable context pressure guard.
 *
 * Covers:
 * - Oversized tool results trigger wind-down before the provider limit
 * - Below-threshold runs are unchanged
 * - Off switch (AFK_CONTEXT_GUARD_DISABLE) restores old behavior
 * - Codex subscription route uses the catalog effective limit
 * - API-key routes are disabled by default
 *
 * @module agent/providers/openai-compatible/query/context-pressure.guard.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { windDownForContextPressure, canSynthesizeUnderPressure } from './context-pressure.js';
import type { TurnDriverContext } from './turn-driver.js';

afterEach(() => { vi.unstubAllEnvs(); });

/**
 * Build a minimal TurnDriverContext for testing windDownForContextPressure.
 * Only the fields read by windDownForContextPressure are required.
 */
function makeCtx(overrides: {
  source?: 'chatgpt-oauth' | 'api-key';
  lastUsageTokens?: number;
  priorTurns?: Array<{ role: string; content: string }>;
  model?: string;
}): TurnDriverContext {
  const { source = 'chatgpt-oauth', lastUsageTokens = 0, priorTurns = [], model = 'gpt-4o-mini' } = overrides;
  return {
    opts: {
      config: {} as never,
      auth: { apiKey: 'tok', source, accountId: 'acct_test', last4: 'test' } as never,
    },
    currentModel: model,
    lastUsage: lastUsageTokens > 0 ? { contextWindowTokens: lastUsageTokens } : null,
    priorTurns: priorTurns as never,
    traceWriter: undefined,
    // Fields not used by windDownForContextPressure:
    abort: {} as never,
    toolDispatcher: undefined,
    journal: { sync: () => {} } as never,
    initSessionId: 'test-session',
    currentPermissionMode: 'default',
    closed: false,
    beforeNextRound: undefined,
    beforeTurnEnd: undefined,
    wireMode: 'default' as never,
    useOpenAIPricing: false,
    client: {} as never,
    fastTier: {} as never,
    activeOpenAITools: () => undefined,
  } as unknown as TurnDriverContext;
}

/** Build a large string payload to push above a token count. */
function largePayload(approximateBytes: number): string {
  // Repeat ASCII chars: ~1 byte/char, ~1 token/3 chars at the guard's estimate
  return 'x'.repeat(approximateBytes);
}

describe('windDownForContextPressure — codex subscription route', () => {
  it('fires when projected tokens exceed operational threshold', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    // contextLimitFor with subscriptionPath=true returns 258,400 (272,000 * 0.95)
    // 95% of 258,400 = 245,480 tokens operational threshold
    // lastUsageTokens=245,000; appended ~1500 bytes => projected = 245,000 + ceil(1500/3)=500 = 245,500 >= 245,480
    const bigPayload = largePayload(1500);
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 245_000,
      priorTurns: [{ role: 'user', content: bigPayload }],
    });
    expect(windDownForContextPressure(ctx, 0)).toBe(true);
  });

  it('does not fire when projected tokens are below operational threshold', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    // lastUsageTokens=100,000 well below 245,480
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 100_000,
      priorTurns: [{ role: 'user', content: largePayload(3000) }],
    });
    expect(windDownForContextPressure(ctx, 0)).toBe(false);
  });

  it('truncates oversized tool results, keeping content short enough for synthesis', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    const veryBigContent = largePayload(2_000_000); // 2MB — far above any limit
    const msg: { role: string; content: string } = { role: 'user', content: veryBigContent };
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 245_000,
      priorTurns: [msg],
    });
    windDownForContextPressure(ctx, 0);
    // Content should be truncated
    expect(Buffer.byteLength(msg.content)).toBeLessThan(Buffer.byteLength(veryBigContent));
    expect(msg.content).toContain('[Context pressure: result truncated for final synthesis');
  });
});

describe('windDownForContextPressure — off switch', () => {
  it('AFK_CONTEXT_GUARD_DISABLE=1: guard does not fire even when far over threshold', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', '1');
    // Would normally fire: well over threshold
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 260_000,
      priorTurns: [{ role: 'user', content: largePayload(1000) }],
    });
    expect(windDownForContextPressure(ctx, 0)).toBe(false);
  });
});

describe('windDownForContextPressure — api-key route', () => {
  it('fires by default on api-key route using contextLimitFor (not catalog)', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    // For api-key model 'gpt-4o-mini', contextLimitFor returns 128,000.
    // 95% of 128,000 = 121,600. lastUsageTokens=122,000 + 0 = 122,000 >= 121,600 -> true
    const ctx = makeCtx({
      source: 'api-key',
      lastUsageTokens: 122_000,
      priorTurns: [{ role: 'user', content: 'small' }],
    });
    expect(windDownForContextPressure(ctx, 0)).toBe(true);
  });

  it('does not fire on api-key route below threshold', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    // 50,000 << 121,600
    const ctx = makeCtx({
      source: 'api-key',
      lastUsageTokens: 50_000,
      priorTurns: [{ role: 'user', content: largePayload(100) }],
    });
    expect(windDownForContextPressure(ctx, 0)).toBe(false);
  });
});

describe('windDownForContextPressure — appendedAt slicing', () => {
  it('only counts turns from appendedAt onward', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    // 3 turns; appendedAt=2 so only the last 1 turn counts
    const turns = [
      { role: 'user', content: largePayload(500_000) }, // old turn — not counted
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'small' },               // only this is appended
    ];
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 100_000, // well below threshold when only last turn counted
      priorTurns: turns,
    });
    // appendedAt=2: only last turn ('small') matters → projected 100,000+2≈100,002 < 245,480
    expect(windDownForContextPressure(ctx, 2)).toBe(false);
  });
});

describe('canSynthesizeUnderPressure', () => {
  it('returns true when projected fits under limit', () => {
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 100_000,
      priorTurns: [{ role: 'user', content: largePayload(100) }],
    });
    expect(canSynthesizeUnderPressure(ctx, 0)).toBe(true);
  });
  it('returns false when projected + 8192 overhead exceeds limit', () => {
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 259_000, // > 258,400 limit so projected+8192 > limit
      priorTurns: [{ role: 'user', content: largePayload(100) }],
    });
    expect(canSynthesizeUnderPressure(ctx, 0)).toBe(false);
  });
});
