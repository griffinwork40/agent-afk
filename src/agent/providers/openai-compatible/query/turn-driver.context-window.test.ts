/**
 * roundContextWindowTokens — carry-forward of the context-window footprint when
 * a round carries no usage (#2780, PR #2786 review M1).
 */
import { describe, it, expect } from 'vitest';
import { roundContextWindowTokens } from './turn-driver.context-window.js';
import { usageFromState, createStreamState } from '../translate.js';

describe('roundContextWindowTokens', () => {
  it('uses input + output when the round carried usage', () => {
    const state = createStreamState();
    state.usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    state.finishReason = 'stop';
    expect(roundContextWindowTokens(usageFromState(state), { contextWindowTokens: 9_999 })).toBe(150);
  });

  it('carries the last known footprint forward when the round has no usage', () => {
    const state = createStreamState();
    state.finishReason = 'stop'; // accepted after a drop before the usage chunk
    expect(roundContextWindowTokens(usageFromState(state), { contextWindowTokens: 150 })).toBe(150);
  });

  it('falls back to input + output of a resume seed that has no contextWindowTokens', () => {
    // resumedUsage() (journal-wiring.ts) seeds only inputTokens.
    const state = createStreamState();
    state.finishReason = 'stop';
    expect(roundContextWindowTokens(usageFromState(state), { inputTokens: 42_000 })).toBe(42_000);
  });

  it('returns 0 when the round has no usage and nothing is known yet', () => {
    const state = createStreamState();
    state.finishReason = 'stop';
    expect(roundContextWindowTokens(usageFromState(state), null)).toBe(0);
    expect(roundContextWindowTokens(usageFromState(state), undefined)).toBe(0);
  });
});
