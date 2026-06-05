/**
 * Unit tests for the pure formatting utilities.
 *
 * Focus: formatTokens' non-finite guard, which keeps the /tokens "total" from
 * rendering as "NaNm" when a loosely-typed usage payload omits totalTokens
 * (undefined at runtime) or yields NaN.
 */

import { describe, it, expect } from 'vitest';
import { formatTokens } from './format-utils.js';

describe('formatTokens', () => {
  it('renders "0" for non-finite inputs (undefined / NaN / Infinity) instead of "NaNm"', () => {
    expect(formatTokens(NaN)).toBe('0');
    // The real-world bug: getContextUsage() omitted totalTokens, so the
    // /tokens consumer passed `undefined` here and the million-branch produced
    // "NaNm" (undefined / 1_000_000 = NaN).
    expect(formatTokens(undefined as unknown as number)).toBe('0');
    expect(formatTokens(Infinity)).toBe('0');
    expect(formatTokens(-Infinity)).toBe('0');
  });

  it('passes through small counts verbatim', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with a k suffix', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(83_560)).toBe('83.6k');
    expect(formatTokens(200_000)).toBe('200k');
  });

  it('formats millions with an m suffix', () => {
    expect(formatTokens(1_000_000)).toBe('1m');
    expect(formatTokens(1_500_000)).toBe('1.5m');
  });
});
