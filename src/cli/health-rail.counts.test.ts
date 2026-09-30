import { describe, it, expect } from 'vitest';
import { deriveSubCounts } from './health-rail.js';

describe('deriveSubCounts (#2687)', () => {
  it('sums background running jobs and in-flight foreground dispatches', () => {
    expect(deriveSubCounts(1, 4, 2, 4)).toEqual({ activeSubs: 3, totalSubs: 6 });
  });

  it('makes foreground-only sessions visible (total > 0 so the formatter shows N/M)', () => {
    expect(deriveSubCounts(0, 0, 2, 0)).toEqual({ activeSubs: 2, totalSubs: 2 });
  });

  it('never lets active exceed total', () => {
    const { activeSubs, totalSubs } = deriveSubCounts(3, 3, 5, 0);
    expect(activeSubs).toBeLessThanOrEqual(totalSubs);
  });

  it('ratchets total upward and never decreases it after registry eviction', () => {
    expect(deriveSubCounts(0, 1, 0, 7)).toEqual({ activeSubs: 0, totalSubs: 7 });
  });

  it('is byte-identical to the pre-#2687 background-only math when foreground is 0', () => {
    expect(deriveSubCounts(2, 5, 0, 3)).toEqual({ activeSubs: 2, totalSubs: 5 });
  });
});
