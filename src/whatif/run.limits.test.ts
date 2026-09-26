import { describe, expect, it } from 'vitest';
import { verifyShortfallLimits } from './run.limits.js';
import type { VerifyResult } from './types.js';

const base: VerifyResult = {
  predictions: [], discovered: [], features: [], episodes: 4, samples: 2,
  judge: { name: 'jev', external: true }, truncatedByBudget: false, failedEpisodes: 0,
};

describe('verifyShortfallLimits', () => {
  it('is empty for a complete run', () => {
    expect(verifyShortfallLimits(base)).toEqual([]);
  });
  it('names failed episodes, ungraded outputs, and a budget stop', () => {
    const out = verifyShortfallLimits({ ...base, failedEpisodes: 2, judgeFailures: 3, truncatedByBudget: true });
    expect(out).toHaveLength(3);
    expect(out[1]).toContain('3 output(s) could not be graded by the jev judge');
  });
});
