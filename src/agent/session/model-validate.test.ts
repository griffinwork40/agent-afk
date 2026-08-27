/**
 * Tests for the shared model-argument validation predicate.
 * @module agent/session/model-validate.test
 */

import { describe, expect, it } from 'vitest';
import { isValidModelArg } from './model-validate.js';

describe('isValidModelArg', () => {
  it('accepts the grok alias (DIRECT_MODEL_ALIASES entry)', () => {
    expect(isValidModelArg('grok')).toBe(true);
  });

  it('accepts grok-4.6 (xai wire id passthrough)', () => {
    expect(isValidModelArg('grok-4.6')).toBe(true);
  });

  it('accepts grok-4.5 (xai wire id passthrough)', () => {
    expect(isValidModelArg('grok-4.5')).toBe(true);
  });

  it('accepts claude-sonnet-4-6 (Anthropic wire id)', () => {
    expect(isValidModelArg('claude-sonnet-4-6')).toBe(true);
  });

  it('accepts sonnet (direct alias)', () => {
    expect(isValidModelArg('sonnet')).toBe(true);
  });

  it('accepts small (slot name)', () => {
    expect(isValidModelArg('small')).toBe(true);
  });

  it('rejects not-a-model (unknown string)', () => {
    expect(isValidModelArg('not-a-model')).toBe(false);
  });

  it('rejects grokk (typo)', () => {
    expect(isValidModelArg('grokk')).toBe(false);
  });
});
