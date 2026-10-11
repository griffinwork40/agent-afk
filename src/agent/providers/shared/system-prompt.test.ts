/**
 * Tests for `normalizeSystemPromptOverlay` in shared/system-prompt.ts.
 *
 * Regression for issue #3261: the OpenAI-compatible provider used
 * `typeof config.systemPrompt === 'string' ? ... : undefined`, which
 * silently dropped the `append` text of a preset object.  The shared
 * normalizer ensures both providers handle all input shapes identically.
 */

import { describe, it, expect } from 'vitest';
import { normalizeSystemPromptOverlay } from './system-prompt.js';

describe('normalizeSystemPromptOverlay', () => {
  // --- string inputs ---
  it('returns a non-empty string as-is', () => {
    expect(normalizeSystemPromptOverlay('Be terse.')).toBe('Be terse.');
  });

  it('returns null for an empty string', () => {
    expect(normalizeSystemPromptOverlay('')).toBeNull();
  });

  // --- undefined ---
  it('returns null for undefined', () => {
    expect(normalizeSystemPromptOverlay(undefined)).toBeNull();
  });

  // --- preset objects: regression coverage for #3261 ---
  it('returns the append text from a preset object (bug #3261)', () => {
    const sp = { type: 'preset' as const, preset: 'claude_code' as const, append: 'Extra instructions.' };
    expect(normalizeSystemPromptOverlay(sp)).toBe('Extra instructions.');
  });

  it('returns null for a preset object with no append field', () => {
    const sp = { type: 'preset' as const, preset: 'claude_code' as const };
    expect(normalizeSystemPromptOverlay(sp)).toBeNull();
  });

  it('returns null for a preset object with an empty append string', () => {
    const sp = { type: 'preset' as const, preset: 'claude_code' as const, append: '' };
    expect(normalizeSystemPromptOverlay(sp)).toBeNull();
  });

  // --- parity: resolveUserSystem (anthropic-direct) must match ---
  it('parity: anthropic resolveUserSystem produces same result as normalizeSystemPromptOverlay', async () => {
    const { resolveUserSystem } = await import('../anthropic-direct/provider-query-setup.js');
    const cases: Array<import('../../types/config-types.js').AgentConfig['systemPrompt']> = [
      undefined,
      '',
      'Be terse.',
      { type: 'preset', preset: 'claude_code', append: 'Extra.' },
      { type: 'preset', preset: 'claude_code', append: '' },
      { type: 'preset', preset: 'claude_code' },
    ];
    for (const sp of cases) {
      expect(resolveUserSystem(sp)).toEqual(normalizeSystemPromptOverlay(sp));
    }
  });
});
