/**
 * Claude Opus 4.6 / Mythos Preview thinking contract.
 *
 * The SDK console.warns on every request that sends `thinking.type=enabled`
 * to these models (MODELS_TO_WARN_WITH_THINKING_ENABLED). AFK's default
 * `--thinking enabled:max` must therefore resolve to adaptive here, while an
 * explicit finite budget is still honoured as manual extended thinking.
 */

import { describe, it, expect } from 'vitest';
import { resolveThinkingParam } from './resolve-params.js';

describe('resolveThinkingParam on SDK-deprecated enabled-thinking models', () => {
  for (const id of ['claude-opus-4-6', 'claude-opus-4-6-20250901', 'claude-mythos-preview']) {
    it(`promotes unbudgeted enabled to adaptive for ${id}`, () => {
      expect(resolveThinkingParam({ type: 'enabled' }, 64_000, id)).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
    });

    it(`promotes enabled:max (infinite budget) to adaptive for ${id}`, () => {
      const p = resolveThinkingParam({ type: 'enabled', budgetTokens: Number.POSITIVE_INFINITY }, 64_000, id);
      expect(p.type).toBe('adaptive');
    });

    it(`keeps an explicit finite budget as enabled for ${id}`, () => {
      const p = resolveThinkingParam({ type: 'enabled', budgetTokens: 8_000 }, 64_000, id) as {
        type: string;
        budget_tokens?: number;
      };
      expect(p.type).toBe('enabled');
      expect(p.budget_tokens).toBe(8_000);
    });
  }

  it('leaves non-deprecated models (sonnet-4-6, haiku) on manual enabled', () => {
    for (const id of ['claude-sonnet-4-6', 'claude-haiku-4-5']) {
      expect(resolveThinkingParam({ type: 'enabled' }, 64_000, id).type).toBe('enabled');
    }
  });
});
