import { describe, expect, it } from 'vitest';
import { isModelFallbackArmed } from './model-fallback-armed.js';

describe('isModelFallbackArmed', () => {
  it('is false when the config or the flag is absent', () => {
    expect(isModelFallbackArmed(undefined)).toBe(false);
    expect(isModelFallbackArmed({})).toBe(false);
    expect(isModelFallbackArmed({ modelFallbackArmed: false })).toBe(false);
  });

  it('accepts a plain true', () => {
    expect(isModelFallbackArmed({ modelFallbackArmed: true })).toBe(true);
  });

  it('reads a predicate live on every call', () => {
    let armed = true;
    const config = { modelFallbackArmed: () => armed };
    expect(isModelFallbackArmed(config)).toBe(true);
    armed = false;
    expect(isModelFallbackArmed(config)).toBe(false);
  });

  it('treats a throwing predicate as not armed', () => {
    const config = {
      modelFallbackArmed: (): boolean => {
        throw new Error('router bug');
      },
    };
    expect(isModelFallbackArmed(config)).toBe(false);
  });
});
