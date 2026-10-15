import { describe, expect, it } from 'vitest';
import { verifyShortfallLimits, hookIsolationLimits, specTargetsHooksOrPlugins } from './run.limits.js';
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
  it('includes arm-imbalance summary when armImbalance is set', () => {
    const imbalance = {
      baselineFailRate: 0,
      candidateFailRate: 0.375,
      rateDiff: 0.375,
      allInOneArm: true,
      concentrationArm: 'candidate' as const,
      summary: 'Arm-imbalance warning: failures are concentrated in one arm (all 6 failures in the candidate arm). This may bias the verdict toward "no change". Consider raising --timeout.',
    };
    const out = verifyShortfallLimits({ ...base, failedEpisodes: 6, armImbalance: imbalance });
    expect(out.some((l) => l.includes('Arm-imbalance warning'))).toBe(true);
    expect(out.some((l) => l.includes('--timeout'))).toBe(true);
  });
  it('does NOT include arm-imbalance line when armImbalance is absent', () => {
    const out = verifyShortfallLimits({ ...base, failedEpisodes: 1 });
    expect(out.every((l) => !l.includes('Arm-imbalance'))).toBe(true);
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

describe('specTargetsHooksOrPlugins', () => {
  it('returns false for a non-hook change (memory-add)', () => {
    const spec = {
      title: 'Add a memory fact',
      changes: [{ kind: 'memory-add' as const, content: 'prefer pnpm', category: 'preference' as const }],
    };
    expect(specTargetsHooksOrPlugins(spec)).toBe(false);
  });

  it('returns true for disable-plugin (hooks.json hooks would be suppressed)', () => {
    const spec = {
      title: 'Disable plugin',
      changes: [{ kind: 'disable-plugin' as const, name: 'my-plugin' }],
    };
    expect(specTargetsHooksOrPlugins(spec)).toBe(true);
  });

  it('returns true for file targeting home:config/afk.config.json', () => {
    const spec = {
      title: 'Edit hook config',
      changes: [{ kind: 'file' as const, path: 'home:config/afk.config.json', content: '{}' }],
    };
    expect(specTargetsHooksOrPlugins(spec)).toBe(true);
  });

  it('returns true for file whose basename is hooks.json (plugin hook manifest)', () => {
    const spec = {
      title: 'Edit plugin hooks',
      changes: [{ kind: 'file' as const, path: 'home:plugins/my-plugin/hooks/hooks.json', content: '{}' }],
    };
    expect(specTargetsHooksOrPlugins(spec)).toBe(true);
  });

  it('returns false for a file change to an unrelated path', () => {
    const spec = {
      title: 'Edit AFK.md',
      changes: [{ kind: 'file' as const, path: 'home:AFK.md', content: 'hello' }],
    };
    expect(specTargetsHooksOrPlugins(spec)).toBe(false);
  });
});
