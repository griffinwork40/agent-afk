/**
 * Tests for src/cli/render/session-summary.ts
 */

import { describe, it, expect } from 'vitest';
import { costTokenParts } from './session-summary.js';

describe('costTokenParts', () => {
  // ── both absent / zero ──────────────────────────────────────────────────────

  it('returns [] when both costUsd and tokens are undefined', () => {
    expect(costTokenParts({})).toEqual([]);
  });

  it('returns [] when costUsd is 0 and includeZeroCost is false (default)', () => {
    expect(costTokenParts({ costUsd: 0 })).toEqual([]);
  });

  it('returns [] when tokens is 0', () => {
    expect(costTokenParts({ tokens: 0 })).toEqual([]);
  });

  it('returns [] when both costUsd is 0 and tokens is 0', () => {
    expect(costTokenParts({ costUsd: 0, tokens: 0 })).toEqual([]);
  });

  // ── cost only ───────────────────────────────────────────────────────────────

  it('returns cost fragment when costUsd > 0', () => {
    const result = costTokenParts({ costUsd: 1.23 });
    expect(result).toEqual(['$1.23']);
  });

  it('returns cost fragment for a sub-cent cost', () => {
    const result = costTokenParts({ costUsd: 0.0012 });
    expect(result).toEqual(['$0.0012']);
  });

  it('returns zero-cost fragment when includeZeroCost is true', () => {
    const result = costTokenParts({ costUsd: 0, includeZeroCost: true });
    expect(result).toEqual(['$0.00']);
  });

  it('omits cost when costUsd is undefined even with includeZeroCost true', () => {
    const result = costTokenParts({ includeZeroCost: true });
    expect(result).toEqual([]);
  });

  // ── tokens only ─────────────────────────────────────────────────────────────

  it('returns token fragment when tokens > 0', () => {
    const result = costTokenParts({ tokens: 500 });
    expect(result).toEqual(['500 tokens']);
  });

  it('returns formatted k-suffix for large token counts', () => {
    const result = costTokenParts({ tokens: 1500 });
    expect(result).toEqual(['1.5k tokens']);
  });

  it('returns formatted m-suffix for million-scale token counts', () => {
    const result = costTokenParts({ tokens: 2_000_000 });
    expect(result).toEqual(['2m tokens']);
  });

  it('skips token fragment when tokens is undefined', () => {
    const result = costTokenParts({ costUsd: 0.5 });
    expect(result).toEqual(['$0.50']);
  });

  // ── both present ────────────────────────────────────────────────────────────

  it('returns [cost, tokens] in that order when both are positive', () => {
    const result = costTokenParts({ costUsd: 0.05, tokens: 1200 });
    expect(result).toEqual(['$0.05', '1.2k tokens']);
  });

  it('returns [cost, tokens] with includeZeroCost when cost is zero', () => {
    const result = costTokenParts({ costUsd: 0, tokens: 42, includeZeroCost: true });
    expect(result).toEqual(['$0.00', '42 tokens']);
  });

  it('returns [tokens] only when costUsd is 0 and includeZeroCost is false', () => {
    const result = costTokenParts({ costUsd: 0, tokens: 42 });
    expect(result).toEqual(['42 tokens']);
  });

  // ── edge / defensive ────────────────────────────────────────────────────────

  it('handles NaN tokens gracefully — skips token fragment', () => {
    // formatTokens('NaN') returns '0'; tokenCount 0 is skipped.
    const result = costTokenParts({ tokens: NaN });
    expect(result).toEqual([]);
  });

  it('handles non-finite costUsd (Infinity) — skips cost fragment', () => {
    const result = costTokenParts({ costUsd: Infinity, includeZeroCost: true });
    expect(result).toEqual([]);
  });

  it('returns exactly two elements for typical session-end stats', () => {
    const result = costTokenParts({ costUsd: 0.1234, tokens: 50_000 });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/^\$/);
    expect(result[1]).toMatch(/tokens$/);
  });
});
