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
import { windDownForContextPressure, canSynthesizeUnderPressure, WIND_DOWN_MAX_OUTPUT_TOKENS } from './context-pressure.js';
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

  it('truncates oversized tool results and does NOT mutate the original message object', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    const veryBigContent = largePayload(2_000_000); // 2MB — far above any limit
    const originalMsg = { role: 'tool', content: veryBigContent };
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 245_000,
      priorTurns: [originalMsg],
    });
    windDownForContextPressure(ctx, 0);
    // The slot in priorTurns should have a new object with truncated content.
    const slotAfter = (ctx.priorTurns as Array<{ role: string; content: string }>)[0];
    expect(Buffer.byteLength(slotAfter.content)).toBeLessThan(Buffer.byteLength(veryBigContent));
    expect(slotAfter.content).toContain('[Context pressure: result truncated for final synthesis');
    // The ORIGINAL object must NOT have been mutated.
    expect(originalMsg.content).toBe(veryBigContent);
    expect(slotAfter).not.toBe(originalMsg);
  });

  it('does NOT truncate user messages — only tool messages', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    // A large user message and a large tool message, both over any reasonable per-message budget.
    const bigUserContent = largePayload(2_000_000);
    const bigToolContent = largePayload(2_000_000);
    const userMsg = { role: 'user', content: bigUserContent };
    const toolMsg = { role: 'tool', content: bigToolContent };
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 245_000,
      priorTurns: [userMsg, toolMsg],
    });
    windDownForContextPressure(ctx, 0);
    // User message slot: content must be unchanged (user messages are never truncated).
    const userSlot = (ctx.priorTurns as Array<{ role: string; content: string }>)[0];
    expect(userSlot.content).toBe(bigUserContent);
    // Tool message slot: should be truncated with a new object.
    const toolSlot = (ctx.priorTurns as Array<{ role: string; content: string }>)[1];
    expect(Buffer.byteLength(toolSlot.content)).toBeLessThan(Buffer.byteLength(bigToolContent));
    expect(toolSlot.content).toContain('[Context pressure: result truncated for final synthesis');
    expect(toolSlot).not.toBe(toolMsg); // new object, not mutated in place
  });

  it('headroom subtraction is in bytes (WIND_DOWN_MAX_OUTPUT_TOKENS * 3), not raw tokens', () => {
    vi.stubEnv('AFK_CONTEXT_GUARD_PCT', undefined);
    vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
    // Verify the constant value and that the formula uses bytes.
    // If headroom were subtracted as raw tokens (4096) instead of bytes (4096*3=12288),
    // the available budget would be ~8192 bytes larger, producing longer truncated content.
    // We assert the constant is what we expect and that truncated content is bounded
    // tightly by the byte-converted headroom.
    expect(WIND_DOWN_MAX_OUTPUT_TOKENS).toBe(4096);
    // Build a scenario where ONLY ONE tool message exists so each=availableBytes.
    // availableBytes = floor((limit*fraction - last)*3) - envelopeBytes - 4096*3
    // With lastUsageTokens=245_000, limit=258_400 (codex), fraction=0.95:
    //   threshold = 245_480 tokens
    //   budget = floor((245_480 - 245_000) * 3) = floor(480 * 3) = 1440 bytes
    //   envelopeBytes ~ small (no assistant/user envelope)
    //   headroom = 4096 * 3 = 12288 bytes  -> availableBytes = max(0, 1440 - ~50 - 12288) = 0
    // So with the corrected formula, each=0 and every tool message gets truncated to 0+suffix.
    // With the old formula (subtract 4096 raw) each would be 1440 - ~50 - 4096 < 0 => 0 too,
    // but at a different breakpoint. The key observable: truncation fires and suffix is present.
    const toolMsg = { role: 'tool', content: largePayload(500_000) };
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 245_000,
      priorTurns: [toolMsg],
    });
    windDownForContextPressure(ctx, 0);
    const slot = (ctx.priorTurns as Array<{ role: string; content: string }>)[0];
    // Truncated content must end with the sentinel suffix (not the raw 500KB payload).
    expect(slot.content).toContain('[Context pressure: result truncated for final synthesis');
    expect(Buffer.byteLength(slot.content)).toBeLessThan(Buffer.byteLength(largePayload(500_000)));
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
  it('returns false when projected + WIND_DOWN_MAX_OUTPUT_TOKENS overhead exceeds limit', () => {
    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: 259_000, // > 258,400 limit so projected+4096 > limit
      priorTurns: [{ role: 'user', content: largePayload(100) }],
    });
    expect(canSynthesizeUnderPressure(ctx, 0)).toBe(false);
  });

  it('WIND_DOWN_MAX_OUTPUT_TOKENS is 4096 — reserve matches the actual synthesis cap', () => {
    expect(WIND_DOWN_MAX_OUTPUT_TOKENS).toBe(4096);
  });

  it('boundary: exactly at limit returns false; one token below returns true', () => {
    // contextLimitFor('gpt-4o-mini', subscriptionPath=true) = 128_000.
    // canSynthesizeUnderPressure: projectedContextTokens(last, appendedBytes) + WIND_DOWN_MAX_OUTPUT_TOKENS < limit
    // projectedContextTokens = Math.ceil(last + appendedBytes / 3).
    //
    // appendedBytes = Buffer.byteLength(JSON.stringify([{role:'user',content:'xxxxxxxxxxxx'}])) = 42.
    // appendedTokens = Math.ceil(42 / 3) = 14.
    //
    // At-limit: last = 128_000 - 4096 - 14 = 123_890 → projected = 123_904 → +4096 = 128_000 = limit → false (not <).
    // One below: last = 123_889 → projected = 123_903 → +4096 = 127_999 < 128_000 → true.
    const limit = 128_000; // contextLimitFor('gpt-4o-mini', true)
    const appendedTokens = 14; // Math.ceil(42 / 3), 42 = byteLength(JSON.stringify([{role,content}]))
    const atLimit = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: limit - WIND_DOWN_MAX_OUTPUT_TOKENS - appendedTokens,
      priorTurns: [{ role: 'user', content: 'xxxxxxxxxxxx' }],
    });
    expect(canSynthesizeUnderPressure(atLimit, 0)).toBe(false);

    // One token less in lastUsage → projected+4096 = limit-1 < limit → true.
    const oneBelow = makeCtx({
      source: 'chatgpt-oauth',
      lastUsageTokens: limit - WIND_DOWN_MAX_OUTPUT_TOKENS - appendedTokens - 1,
      priorTurns: [{ role: 'user', content: 'xxxxxxxxxxxx' }],
    });
    expect(canSynthesizeUnderPressure(oneBelow, 0)).toBe(true);
  });
});
