/**
 * Tests for predict.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { predictChanges } from './predict.js';
import type { CompleteFn, StructuralImpact } from './types.js';

const MODEL = 'claude-haiku-4-5-20250929';

function emptyStructural(): StructuralImpact {
  return {
    baseline: { model: 'haiku', system: 'sys', tools: [], firstUserMessage: 'hi' },
    candidate: { model: 'haiku', system: 'sys', tools: [], firstUserMessage: 'hi' },
    systemDiff: '',
    toolsAdded: [],
    toolsRemoved: [],
    toolsChanged: [],
    userMessageDiff: '',
    tokens: { baseline: 100, candidate: 110 },
    modelChanged: false,
  };
}

function makeFake(text: string): CompleteFn {
  return vi.fn().mockResolvedValue({ text, costUsd: 0.001 });
}

describe('predictChanges', () => {
  it('returns up to 8 predictions', async () => {
    const preds = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i + 1}`,
      behavior: `behavior ${i + 1}`,
      direction: 'added',
      confidence: 'medium',
      reason: 'reason',
      testQuestion: 'Does the response do something?',
      probes: ['probe'],
    }));
    const fn = makeFake(JSON.stringify(preds));
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('re-assigns sequential ids', async () => {
    const preds = [
      { id: 'x99', behavior: 'b', direction: 'added', confidence: 'low', reason: 'r', testQuestion: 'Does the response x?', probes: ['a'] },
    ];
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      makeFake(JSON.stringify(preds)),
      MODEL,
    );
    expect(result[0]?.id).toBe('p1');
  });

  it('returns [] for empty model response', async () => {
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      makeFake('[]'),
      MODEL,
    );
    expect(result).toEqual([]);
  });

  it('returns [] for malformed JSON', async () => {
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      makeFake('not valid json at all'),
      MODEL,
    );
    expect(result).toEqual([]);
  });

  it('drops invalid prediction entries', async () => {
    const preds = [
      { id: 'p1', behavior: 'b', direction: 'INVALID', confidence: 'high', reason: 'r', testQuestion: 'Does it?', probes: ['x'] },
      { id: 'p2', behavior: 'b2', direction: 'added', confidence: 'low', reason: 'r', testQuestion: 'Does it?', probes: ['x'] },
    ];
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      makeFake(JSON.stringify(preds)),
      MODEL,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.behavior).toBe('b2');
  });

  it('includes trackRecord in user prompt', async () => {
    const fn = makeFake('[]');
    await predictChanges(
      {
        spec: { title: 't', changes: [] },
        changeDescriptions: [],
        structural: emptyStructural(),
        trackRecord: 'calibration data here',
      },
      fn,
      MODEL,
    );
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
    expect(call[0].user).toContain('calibration data here');
  });

  it('truncates long systemDiff', async () => {
    const longDiff = 'x'.repeat(20000);
    const structural = { ...emptyStructural(), systemDiff: longDiff };
    const fn = makeFake('[]');
    await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural },
      fn,
      MODEL,
    );
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
    expect(call[0].user).toContain('[truncated]');
  });
});
