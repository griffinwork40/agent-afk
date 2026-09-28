import { describe, expect, it } from 'vitest';
import { verifyShortfallLimits, hookIsolationLimits } from './run.limits.js';
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

describe('hookIsolationLimits', () => {
  it('includes hook-isolation note when keepContextHooks=false', () => {
    const out = hookIsolationLimits({ keepContextHooks: false, structural: { userMessageDiff: '' } });
    expect(out.some((l) => l.includes('SessionStart') && l.includes('UserPromptSubmit'))).toBe(true);
    expect(out.some((l) => l.includes('AFK_WHATIF_KEEP_CONTEXT_HOOKS'))).toBe(true);
  });

  it('does NOT include hook-isolation note when keepContextHooks=true', () => {
    const out = hookIsolationLimits({ keepContextHooks: true, structural: { userMessageDiff: '' } });
    expect(out.some((l) => l.includes('SessionStart'))).toBe(false);
  });

  it('includes userMessageDiff warning when arms diverged', () => {
    const out = hookIsolationLimits({
      keepContextHooks: false,
      structural: { userMessageDiff: '- old line\n+ new line' },
    });
    expect(out.some((l) => l.includes('still differed between arms'))).toBe(true);
  });

  it('does NOT include userMessageDiff warning when diff is empty', () => {
    const out = hookIsolationLimits({ keepContextHooks: false, structural: { userMessageDiff: '' } });
    expect(out.some((l) => l.includes('still differed'))).toBe(false);
  });

  it('does NOT include userMessageDiff warning when diff is whitespace-only', () => {
    const out = hookIsolationLimits({ keepContextHooks: false, structural: { userMessageDiff: '   ' } });
    expect(out.some((l) => l.includes('still differed'))).toBe(false);
  });
});
