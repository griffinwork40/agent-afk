/**
 * Tests for `projectOutputEvent` — focused on the model-fallback notice
 * persistence rule and the skipping of other notice kinds.
 */

import { describe, it, expect } from 'vitest';
import { projectOutputEvent } from './session-ledger-project.js';
import type { OutputEvent } from './types/session-types.js';

function makeFallbackNotice(overrides?: Partial<Extract<OutputEvent, { type: 'notice' }>>): OutputEvent {
  return {
    type: 'notice',
    text: 'opus hit its usage limit. Continuing on sonnet.',
    kind: 'model-fallback',
    fallback: { from: 'opus', to: 'sonnet', reason: 'usage-limit' },
    ...overrides,
  };
}

describe('projectOutputEvent — model-fallback notice', () => {
  it('persists a model-fallback notice with fallback payload as model_fallback record', () => {
    const result = projectOutputEvent(makeFallbackNotice());
    expect(result).toEqual({
      kind: 'model_fallback',
      from: 'opus',
      to: 'sonnet',
      reason: 'usage-limit',
      text: 'opus hit its usage limit. Continuing on sonnet.',
    });
  });

  it('persists credit-exhausted reason', () => {
    const event = makeFallbackNotice({
      fallback: { from: 'opus', to: 'haiku', reason: 'credit-exhausted' },
    });
    const result = projectOutputEvent(event);
    expect(result).toMatchObject({ kind: 'model_fallback', reason: 'credit-exhausted' });
  });

  it('skips a model-fallback notice that lacks the fallback payload', () => {
    // A model-fallback notice without the fallback field should not be persisted.
    const event: OutputEvent = {
      type: 'notice',
      text: 'some fallback text',
      kind: 'model-fallback',
      // fallback intentionally absent
    };
    expect(projectOutputEvent(event)).toBeNull();
  });

  it('skips truncation notices', () => {
    const event: OutputEvent = { type: 'notice', text: 'truncated', kind: 'truncation' };
    expect(projectOutputEvent(event)).toBeNull();
  });

  it('skips refusal notices', () => {
    const event: OutputEvent = { type: 'notice', text: 'refused', kind: 'refusal' };
    expect(projectOutputEvent(event)).toBeNull();
  });

  it('skips fast-tier notices', () => {
    const event: OutputEvent = { type: 'notice', text: 'fast tier', kind: 'fast-tier' };
    expect(projectOutputEvent(event)).toBeNull();
  });
});
