/**
 * applyBeforeNextRound — inter-round steering injection (#2420).
 *
 * Regression focus: after an ordinary tool round the history tail is a
 * `role:'tool'` message; steering text must be appended as a new user turn,
 * never silently dropped (the callback has already drained its queue).
 */
import { describe, it, expect } from 'vitest';
import { applyBeforeNextRound } from './turn-driver.js';
import type { OpenAIMessage } from '../messages.js';

const asMsgs = (m: unknown[]): OpenAIMessage[] => m as OpenAIMessage[];

describe('applyBeforeNextRound', () => {
  it('appends a new user turn when the tail is a tool result', () => {
    const turns = asMsgs([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]);
    applyBeforeNextRound(turns, 'steer: stop and summarize', undefined, 'sub-1');
    expect(turns).toHaveLength(4);
    expect(turns.at(-1)).toEqual({ role: 'user', content: 'steer: stop and summarize' });
    // The tool message is untouched (OpenAI tool{} content must stay the tool result).
    expect(turns[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });

  it('merges into an existing trailing string user message', () => {
    const turns = asMsgs([{ role: 'user', content: 'image follow-up' }]);
    applyBeforeNextRound(turns, 'steer', undefined, undefined);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ role: 'user', content: 'image follow-up\n\nsteer' });
  });

  it('appends a text part to a trailing array-content user message', () => {
    const turns = asMsgs([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }]);
    applyBeforeNextRound(turns, 'steer', undefined, undefined);
    expect(turns).toHaveLength(1);
    expect((turns[0] as { content: unknown[] }).content.at(-1)).toEqual({ type: 'text', text: 'steer' });
  });

  it('is a no-op when there is no steering text', () => {
    const turns = asMsgs([{ role: 'tool', tool_call_id: 'c1', content: 'ok' }]);
    applyBeforeNextRound(turns, undefined, undefined, undefined);
    applyBeforeNextRound(turns, '', undefined, undefined);
    expect(turns).toHaveLength(1);
  });
});

// ── contextWindowTokens carry-forward when usage is absent ────────────────────

import { usageFromState, createStreamState } from '../translate.js';
import { sumProviderUsage } from '../../../usage.js';
import type { ProviderUsage } from '../../../provider.js';

describe('contextWindowTokens carry-forward when usage is absent', () => {
  it('carries forward contextWindowTokens when round has no usage tokens', () => {
    // Simulate the turn-driver logic for two rounds:
    // Round 1: real usage (100 in, 50 out) → contextWindowTokens = 150.
    // Round 2: no usage (drop-then-accept) → must carry forward 150, not zero.

    const base: ProviderUsage = { stopReason: null, resultSubtype: 'success', isError: false };

    // Round 1: state with real usage.
    const state1 = createStreamState();
    state1.usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    state1.finishReason = 'stop';
    const round1Usage = usageFromState(state1);
    let acc = sumProviderUsage(base, round1Usage);
    if (round1Usage.inputTokens !== undefined || round1Usage.outputTokens !== undefined) {
      acc.contextWindowTokens = (round1Usage.inputTokens ?? 0) + (round1Usage.outputTokens ?? 0);
    } else {
      acc.contextWindowTokens = 0; // previous lastUsage was base (no footprint)
    }
    const lastUsageAfterRound1: ProviderUsage = { ...acc };
    expect(lastUsageAfterRound1.contextWindowTokens).toBe(150);

    // Round 2: state WITHOUT usage (drop-then-accept before usage chunk arrived).
    const state2 = createStreamState();
    state2.finishReason = 'stop';
    // state2.usage === null
    const round2Usage = usageFromState(state2);
    // Apply the carry-forward logic from turn-driver.ts:
    acc = sumProviderUsage(acc, round2Usage);
    if (round2Usage.inputTokens !== undefined || round2Usage.outputTokens !== undefined) {
      acc.contextWindowTokens = (round2Usage.inputTokens ?? 0) + (round2Usage.outputTokens ?? 0);
    } else {
      // Carry forward from lastUsage (the value after round 1).
      acc.contextWindowTokens = lastUsageAfterRound1.contextWindowTokens ?? 0;
    }

    // Must preserve 150, NOT zero out.
    expect(acc.contextWindowTokens).toBe(150);
  });

  it('initializes contextWindowTokens to 0 when no prior usage exists and round has no usage', () => {
    // Edge case: very first round drops before usage. No prior footprint to carry.
    const base: ProviderUsage = { stopReason: null, resultSubtype: 'success', isError: false };
    const state = createStreamState();
    state.finishReason = 'stop';
    const roundUsage = usageFromState(state);
    let acc = sumProviderUsage(base, roundUsage);
    const lastUsage: ProviderUsage | undefined = undefined; // no prior round
    if (roundUsage.inputTokens !== undefined || roundUsage.outputTokens !== undefined) {
      acc.contextWindowTokens = (roundUsage.inputTokens ?? 0) + (roundUsage.outputTokens ?? 0);
    } else {
      acc.contextWindowTokens = lastUsage?.contextWindowTokens ?? 0;
    }
    expect(acc.contextWindowTokens).toBe(0);
  });
});
