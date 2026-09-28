import { describe, it, expect } from 'vitest';
import { preflightEstimate, preflightMdeMessage } from './run.preflight.js';
import type { Episode, StructuralImpact, WhatifOptions, WhatifProgress } from './types.js';

const options = {
  agentModel: 'claude-sonnet-4-5',
  analystModel: 'claude-sonnet-4-5',
  samples: 2,
} as unknown as WhatifOptions;

const structural = { tokens: { baseline: 1000, candidate: 1000 } } as unknown as StructuralImpact;

const episodes = (k: number): Episode[] =>
  Array.from({ length: k }, (_, i) => ({ id: `e${i}`, source: 'real', prompt: 'p' }));

describe('preflightMdeMessage', () => {
  it('names the episode count, the MDE and the episodes needed for 10pp', () => {
    expect(preflightMdeMessage(20, { mdePercent: 0.31, nFor10pp: 193 })).toBe(
      '20 episodes/arm can detect ~31pp shifts; to detect 10pp you need ~193 episodes/arm',
    );
  });
});

describe('preflightEstimate', () => {
  it('emits a persistent MDE line based on episode count, not samples', () => {
    const events: WhatifProgress[] = [];
    const total = preflightEstimate(episodes(20), options, structural, true, 0.5, (p) => events.push(p));
    expect(events).toHaveLength(1);
    expect(events[0]!.persistent).toBe(true);
    expect(events[0]!.message).toContain('20 episodes/arm');
    expect(events[0]!.message).toContain('~31pp');
    expect(events[0]!.message).toContain('~193 episodes/arm');
    expect(total).toBeGreaterThan(0.5); // analyst spend is added to the estimate
  });

  it('does not throw without an onProgress sink', () => {
    expect(() => preflightEstimate(episodes(5), options, structural, false, 0, undefined)).not.toThrow();
  });
});
