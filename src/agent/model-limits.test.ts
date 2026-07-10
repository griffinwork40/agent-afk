/**
 * Tests for autoCompactLimitFor — the per-model auto-compaction working budget.
 *
 * Base `sonnet` has a truthful 1M window (see MODEL_CONTEXT_LIMITS) but is
 * capped at a 200k compaction budget so long default sessions compact early for
 * cost/latency. The `sonnet_1m` opt-in and every non-sonnet model use their
 * full context window. See src/agent/model-limits.ts.
 */

import { describe, it, expect } from 'vitest';
import { autoCompactLimitFor, contextLimitFor } from './model-limits.js';

describe('autoCompactLimitFor', () => {
  it('caps the default sonnet alias at the 200k working budget (not its 1M window)', () => {
    // The window is truthfully 1M; only the compaction trigger is reduced.
    expect(contextLimitFor('sonnet')).toBe(1_000_000);
    expect(autoCompactLimitFor('sonnet')).toBe(200_000);
  });

  it('caps the claude-sonnet-5 wire id at 200k (requestedModel may be the wire id)', () => {
    expect(autoCompactLimitFor('claude-sonnet-5')).toBe(200_000);
  });

  it('the sonnet_1m opt-in bypasses the budget and uses the full 1M window', () => {
    expect(autoCompactLimitFor('sonnet_1m')).toBe(1_000_000);
  });

  it('leaves opus / opus_1m / haiku / fable at their full window (no budget)', () => {
    expect(autoCompactLimitFor('opus')).toBe(200_000);
    expect(autoCompactLimitFor('opus_1m')).toBe(1_000_000);
    expect(autoCompactLimitFor('haiku')).toBe(200_000);
    expect(autoCompactLimitFor('fable')).toBe(1_000_000);
    expect(autoCompactLimitFor('claude-fable-5')).toBe(1_000_000);
  });

  it('falls back to the model window for unknown / openai-compatible models', () => {
    expect(autoCompactLimitFor('gpt-4.1')).toBe(1_000_000);
    expect(autoCompactLimitFor('claude-xyz' as unknown as 'opus')).toBe(200_000);
    expect(autoCompactLimitFor('mlx-community/qwen3-32b-4bit')).toBe(128_000);
  });

  it('reports the explicit 1M window for the GPT-5.6 family (alias + all variants)', () => {
    // These are explicit MODEL_CONTEXT_LIMITS entries, not the 262k
    // openai-compatible fallback — a regression here means a gpt-5.6 id fell
    // through and would silently allow context overruns.
    for (const id of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) {
      expect(contextLimitFor(id), id).toBe(1_000_000);
      expect(autoCompactLimitFor(id), id).toBe(1_000_000);
    }
  });
});
