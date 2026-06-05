import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { parseThinking, parseEffort, parseMaxOutputTokens, getMaxOutputTokens } from './index.js';

describe('parseThinking', () => {
  it('parses adaptive mode', () => {
    expect(parseThinking('adaptive')).toEqual({ type: 'adaptive' });
  });

  it('parses disabled mode', () => {
    expect(parseThinking('disabled')).toEqual({ type: 'disabled' });
  });

  it('parses enabled mode with budget tokens', () => {
    expect(parseThinking('enabled:5000')).toEqual({ type: 'enabled', budgetTokens: 5000 });
  });

  it('parses enabled:max as Infinity sentinel (resolved in buildQueryOptions)', () => {
    expect(parseThinking('enabled:max')).toEqual({
      type: 'enabled',
      budgetTokens: Number.POSITIVE_INFINITY,
    });
  });

  it('returns undefined when input is undefined', () => {
    expect(parseThinking(undefined)).toBeUndefined();
  });

  it('throws error on invalid mode', () => {
    expect(() => parseThinking('garbage')).toThrow(/Invalid --thinking value/);
  });

  it('throws error on enabled with non-numeric budget', () => {
    expect(() => parseThinking('enabled:abc')).toThrow(/Invalid --thinking value/);
  });

  it('throws error on enabled with no budget', () => {
    expect(() => parseThinking('enabled')).toThrow(/Invalid --thinking value/);
  });

  it('throws error on enabled with negative budget', () => {
    expect(() => parseThinking('enabled:-1000')).toThrow(/Invalid --thinking value/);
  });
});

describe('parseMaxOutputTokens', () => {
  it('parses positive integer', () => {
    expect(parseMaxOutputTokens('32000')).toBe(32000);
  });

  it("parses 'max' as Infinity sentinel", () => {
    expect(parseMaxOutputTokens('max')).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns undefined when input is undefined', () => {
    expect(parseMaxOutputTokens(undefined)).toBeUndefined();
  });

  it('throws on zero', () => {
    expect(() => parseMaxOutputTokens('0')).toThrow(/Invalid --max-output-tokens/);
  });

  it('throws on negative', () => {
    expect(() => parseMaxOutputTokens('-1')).toThrow(/Invalid --max-output-tokens/);
  });

  it('throws on non-integer', () => {
    expect(() => parseMaxOutputTokens('32.5')).toThrow(/Invalid --max-output-tokens/);
  });

  it('throws on non-numeric string', () => {
    expect(() => parseMaxOutputTokens('huge')).toThrow(/Invalid --max-output-tokens/);
  });

  it('throws on empty string', () => {
    expect(() => parseMaxOutputTokens('')).toThrow(/Invalid --max-output-tokens/);
  });

  it('throws on "NaN"', () => {
    expect(() => parseMaxOutputTokens('NaN')).toThrow(/Invalid --max-output-tokens/);
  });
});

describe('getMaxOutputTokens (env-var reader)', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env['AFK_MAX_OUTPUT_TOKENS'];
    delete process.env['AFK_MAX_OUTPUT_TOKENS'];
  });

  afterEach(() => {
    if (original !== undefined) process.env['AFK_MAX_OUTPUT_TOKENS'] = original;
    else delete process.env['AFK_MAX_OUTPUT_TOKENS'];
  });

  it('returns undefined when AFK_MAX_OUTPUT_TOKENS is not set', () => {
    expect(getMaxOutputTokens()).toBeUndefined();
  });

  it('reads AFK_MAX_OUTPUT_TOKENS when set', () => {
    process.env['AFK_MAX_OUTPUT_TOKENS'] = '50000';
    expect(getMaxOutputTokens()).toBe(50000);
  });

  it("reads 'max' sentinel from env", () => {
    process.env['AFK_MAX_OUTPUT_TOKENS'] = 'max';
    expect(getMaxOutputTokens()).toBe(Number.POSITIVE_INFINITY);
  });

  it('propagates parser errors for malformed env values', () => {
    process.env['AFK_MAX_OUTPUT_TOKENS'] = 'unlimited';
    expect(() => getMaxOutputTokens()).toThrow(/Invalid --max-output-tokens/);
  });
});

describe('parseEffort', () => {
  it('parses low effort', () => {
    expect(parseEffort('low')).toBe('low');
  });

  it('parses medium effort', () => {
    expect(parseEffort('medium')).toBe('medium');
  });

  it('parses high effort', () => {
    expect(parseEffort('high')).toBe('high');
  });

  it('parses xhigh effort', () => {
    expect(parseEffort('xhigh')).toBe('xhigh');
  });

  it('parses max effort', () => {
    expect(parseEffort('max')).toBe('max');
  });

  it('returns undefined when input is undefined', () => {
    expect(parseEffort(undefined)).toBeUndefined();
  });

  it('throws error on invalid effort level', () => {
    expect(() => parseEffort('mega')).toThrow(/Invalid --effort value/);
  });

  it('throws error on empty string', () => {
    expect(() => parseEffort('')).toThrow(/Invalid --effort value/);
  });
});
