import { describe, expect, it } from 'vitest';
import {
  episodesForMde,
  mdeLimits,
  minDetectableEffect,
  preflightMdeLine,
  toPp,
} from './mde.js';
import type { VerifiedPrediction } from './types.js';

describe('minDetectableEffect', () => {
  it('n=20 episodes per arm detects only ~44pp shifts', () => {
    expect(toPp(minDetectableEffect(20))).toBe(44);
  });

  it('n=200 episodes per arm detects ~14pp shifts', () => {
    expect(toPp(minDetectableEffect(200))).toBe(14);
  });

  it('shrinks as episodes grow', () => {
    expect(minDetectableEffect(200)).toBeLessThan(minDetectableEffect(20));
  });

  it('is 1 (nothing detectable) for zero, negative or non-finite n, and never above 1', () => {
    expect(minDetectableEffect(0)).toBe(1);
    expect(minDetectableEffect(-3)).toBe(1);
    expect(minDetectableEffect(Number.NaN)).toBe(1);
    expect(minDetectableEffect(1)).toBe(1);
  });
});

describe('episodesForMde', () => {
  it('needs ~393 episodes per arm for a 10pp shift', () => {
    expect(episodesForMde(0.1)).toBe(393);
  });

  it('round-trips with minDetectableEffect', () => {
    const n = episodesForMde(0.25);
    expect(minDetectableEffect(n)).toBeLessThanOrEqual(0.25);
    expect(minDetectableEffect(n - 1)).toBeGreaterThan(0.25);
  });

  it('is Infinity for a non-positive target', () => {
    expect(episodesForMde(0)).toBe(Infinity);
  });
});

describe('preflightMdeLine', () => {
  it('states cost, the run-level MDE and the per-prediction MDE', () => {
    const line = preflightMdeLine({
      episodes: 20,
      estimateUsd: 3.456,
      predictions: [
        { id: 'p1', probes: ['a', 'b'] },
        { id: 'p2', probes: ['c'] },
      ],
    });
    expect(line).toContain('Estimated cost about $3.46.');
    expect(line).toContain('With 20 episode(s) per arm, only shifts of about 44pp');
    expect(line).toContain('detecting a 10pp shift needs about 393 episodes per arm');
    expect(line).toContain('as few as 1');
  });

  it('omits the per-prediction sentence when there are no probes', () => {
    const line = preflightMdeLine({ episodes: 20, estimateUsd: 1, predictions: [] });
    expect(line).not.toContain('Each prediction');
  });
});

function vp(
  id: string,
  baseline: number,
  candidate: number,
  extra: Partial<VerifiedPrediction> = {},
): VerifiedPrediction {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i}`);
  return {
    prediction: {
      id, behavior: 'b', direction: 'added', confidence: 'medium', reason: 'r',
      testQuestion: 'q?', probes: [],
    },
    rates: { baseline: 0, candidate: 0, delta: 0, ci: [0, 0], n: { baseline: 0, candidate: 0 } },
    verdict: 'unclear',
    scope: { episodes: { baseline: ids(baseline), candidate: ids(candidate) }, targetedEpisodes: baseline },
    ...extra,
  };
}

describe('mdeLimits', () => {
  it('flags a prediction whose achieved MDE exceeds 10pp, using the smaller arm', () => {
    const out = mdeLimits([vp('p1', 20, 18)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Prediction p1 was measured on 18 episode(s) per arm');
    expect(out[0]).toContain(`about ${toPp(minDetectableEffect(18))}pp`);
  });

  it('is silent when the MDE is 10pp or less', () => {
    expect(mdeLimits([vp('p1', 800, 800)])).toEqual([]);
  });

  it('skips unobservable, unscoped and empty-arm predictions', () => {
    const noScope = vp('p2', 5, 5);
    delete noScope.scope;
    expect(mdeLimits([
      vp('p1', 5, 5, { verdict: 'unobservable' }),
      noScope,
      vp('p3', 0, 5),
    ])).toEqual([]);
  });
});
