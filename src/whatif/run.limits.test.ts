import { describe, expect, it } from 'vitest';
import { verifyShortfallLimits, hookIsolationLimits, specTargetsHooksOrPlugins, mdeLimits } from './run.limits.js';
import type { VerifyResult, VerifiedPrediction } from './types.js';

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

// ---------------------------------------------------------------------------
// mdeLimits
// ---------------------------------------------------------------------------

function makeVP(id: string, n: number): VerifiedPrediction {
  return {
    prediction: {
      id,
      behavior: 'test',
      direction: 'added',
      confidence: 'medium',
      reason: 'r',
      testQuestion: 'q?',
      probes: [],
    },
    rates: {
      baseline: 0.5,
      candidate: 0.6,
      delta: 0.1,
      ci: [-0.2, 0.4],
      n: { baseline: n, candidate: n },
    },
    verdict: 'unclear',
  };
}

describe('mdeLimits', () => {
  it('returns empty for no predictions', () => {
    expect(mdeLimits([])).toEqual([]);
  });

  it('emits a bullet when MDE > 10pp (n=20 → ~31pp)', () => {
    const out = mdeLimits([makeVP('p1', 20)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('20 episode(s)');
    expect(out[0]).toContain('31pp');
    expect(out[0]).toContain('10pp');
    expect(out[0]).toContain('193');
  });

  it('emits nothing when MDE ≤ 10pp (n=200 → ~9.8pp ≤ 10pp)', () => {
    // mde(200) ≈ 0.098 which is ≤ 0.10, so no bullet
    const out = mdeLimits([makeVP('p1', 200)]);
    expect(out).toHaveLength(0);
  });

  it('groups multiple predictions with same n into one bullet', () => {
    const out = mdeLimits([makeVP('p1', 20), makeVP('p2', 20)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('2 predictions');
    expect(out[0]).toContain('p1');
    expect(out[0]).toContain('p2');
  });

  it('emits separate bullets for predictions with different n', () => {
    const out = mdeLimits([makeVP('p1', 10), makeVP('p2', 20)]);
    expect(out).toHaveLength(2);
  });

  it('uses min(n.baseline, n.candidate) when arms differ', () => {
    const vp: VerifiedPrediction = {
      ...makeVP('p1', 0),
      rates: {
        baseline: 0.5, candidate: 0.6, delta: 0.1, ci: [-0.2, 0.4],
        n: { baseline: 200, candidate: 10 }, // min is 10 → MDE > 10pp
      },
    };
    const out = mdeLimits([vp]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('10 episode(s)');
  });

  it('counts episodes (scope), not samples, when a scope is present', () => {
    const ids = (k: number): string[] => Array.from({ length: k }, (_, i) => `e${i}`);
    const vp: VerifiedPrediction = {
      ...makeVP('p1', 200), // 200 samples…
      scope: { episodes: { baseline: ids(20), candidate: ids(25) }, targetedEpisodes: 25 },
    };
    const out = mdeLimits([vp]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('20 episode(s)'); // …but only 20 episodes/arm
  });

  it('skips predictions with an empty arm or an unobservable verdict', () => {
    expect(mdeLimits([makeVP('p1', 0)])).toEqual([]);
    expect(mdeLimits([{ ...makeVP('p2', 20), verdict: 'unobservable' }])).toEqual([]);
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
