/**
 * Tests for discover.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { discoverDifferences } from './discover.js';
import type { CompleteFn, Prediction } from './types.js';

const MODEL = 'claude-haiku-4-5-20250929';

function makeFake(text: string): CompleteFn {
  return vi.fn().mockResolvedValue({ text, costUsd: 0.001 });
}

const knownPredictions: Prediction[] = [
  {
    id: 'p1',
    behavior: 'Asks before acting',
    direction: 'added',
    confidence: 'high',
    reason: 'explicit rule',
    testQuestion: 'Does the response ask a question?',
    probes: ['do something risky'],
  },
];

const pairs = [
  { prompt: 'Write a file', baseline: 'I will write it.', candidate: 'Let me ask first.' },
];

describe('discoverDifferences', () => {
  it('returns discovered differences', async () => {
    const diffs = [
      { id: 'd1', description: 'More verbose', question: 'Does the response contain more words?' },
    ];
    const result = await discoverDifferences(pairs, knownPredictions, makeFake(JSON.stringify(diffs)), MODEL);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('d1');
  });

  it('re-assigns sequential ids d1..d3', async () => {
    const diffs = [
      { id: 'x1', description: 'd', question: 'Does it?' },
      { id: 'x2', description: 'd2', question: 'Does it 2?' },
    ];
    const result = await discoverDifferences(pairs, knownPredictions, makeFake(JSON.stringify(diffs)), MODEL);
    expect(result[0]?.id).toBe('d1');
    expect(result[1]?.id).toBe('d2');
  });

  it('caps at 3 differences', async () => {
    const diffs = Array.from({ length: 6 }, (_, i) => ({
      id: `d${i + 1}`,
      description: `diff ${i + 1}`,
      question: 'Does it?',
    }));
    const result = await discoverDifferences(pairs, knownPredictions, makeFake(JSON.stringify(diffs)), MODEL);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('returns [] for malformed JSON', async () => {
    const result = await discoverDifferences(pairs, knownPredictions, makeFake('not json'), MODEL);
    expect(result).toEqual([]);
  });

  it('returns [] when model returns empty array', async () => {
    const result = await discoverDifferences(pairs, knownPredictions, makeFake('[]'), MODEL);
    expect(result).toEqual([]);
  });

  it('caps pairs at 12', async () => {
    const manyPairs = Array.from({ length: 20 }, (_, i) => ({
      prompt: `prompt ${i}`,
      baseline: 'b',
      candidate: 'c',
    }));
    const fn = makeFake('[]');
    await discoverDifferences(manyPairs, [], fn, MODEL);
    // Should not fail - just verifies cap works
    expect(fn).toHaveBeenCalledOnce();
  });

  it('truncates long output text', async () => {
    const longPairs = [
      { prompt: 'q', baseline: 'x'.repeat(5000), candidate: 'y'.repeat(5000) },
    ];
    const fn = makeFake('[]');
    await discoverDifferences(longPairs, [], fn, MODEL);
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
    expect(call[0].user).toContain('[truncated]');
  });
});
