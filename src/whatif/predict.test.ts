/**
 * Tests for predict.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { predictChanges, DEFAULT_PROBES, MAX_PROBES, resolveMaxPredictions } from './predict.js';
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

  describe('observable tag (#2409)', () => {
    const base = { behavior: 'b', direction: 'added', confidence: 'low', reason: 'r', testQuestion: 'Does the response x?', probes: ['a'] };
    async function parse(entries: unknown[]) {
      return predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
        makeFake(JSON.stringify(entries)),
        MODEL,
      );
    }

    it('defaults a missing tag to decision', async () => {
      const [p] = await parse([{ id: 'p1', ...base }]);
      expect(p?.observable).toBe('decision');
      expect(p?.observabilityReason).toBeUndefined();
    });

    it('keeps a downstream tag and its reason', async () => {
      const [p] = await parse([{ id: 'p1', ...base, observable: 'downstream', observabilityReason: ' tests must run ' }]);
      expect(p?.observable).toBe('downstream');
      expect(p?.observabilityReason).toBe('tests must run');
    });

    it('turns an invalid tag into decision instead of dropping the prediction', async () => {
      const result = await parse([{ id: 'p1', ...base, observable: 'later', observabilityReason: 42 }]);
      expect(result).toHaveLength(1);
      expect(result[0]?.observable).toBe('decision');
      expect(result[0]?.observabilityReason).toBeUndefined();
    });

    it('drops a reason attached to a decision prediction', async () => {
      const [p] = await parse([{ id: 'p1', ...base, observable: 'decision', observabilityReason: 'stray' }]);
      expect(p?.observabilityReason).toBeUndefined();
    });

    it('asks the model for the tag, with criteria and examples', async () => {
      const fn = makeFake('[]');
      await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
        fn,
        MODEL,
      );
      const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
      expect(call[0].system).toContain('"observable":"decision"|"downstream"');
      expect(call[0].system).toContain('observabilityReason');
      expect(call[0].system).toMatch(/FIRST side-effecting request/);
      expect(call[0].system).toMatch(/the tests pass after the fix/);
    });
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

  it('includes repo context section when repoManifest is provided', async () => {
    const fn = makeFake('[]');
    const repoManifest = {
      languages: ['TypeScript', 'Markdown'],
      paths: ['src/index.ts', 'README.md'],
      allPaths: new Set(['src/index.ts', 'README.md']),
    };
    await predictChanges(
      {
        spec: { title: 't', changes: [] },
        changeDescriptions: [],
        structural: emptyStructural(),
        repoManifest,
      },
      fn,
      MODEL,
    );
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
    expect(call[0].user).toContain('## Repo context');
    expect(call[0].user).toContain('TypeScript');
    expect(call[0].user).toContain('src/index.ts');
    expect(call[0].user).toContain('README.md');
    expect(call[0].user).toContain('probes MUST reference only paths');
  });

  it('omits repo context section when repoManifest is absent', async () => {
    const fn = makeFake('[]');
    await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
    expect(call[0].user).not.toContain('## Repo context');
  });

  // finding #5 (advisory review #2455): the grounding clause ("Never invent
  // file names") is now emitted by formatRepoManifest into the USER message
  // alongside the manifest — not in the system prompt — so it is structurally
  // absent when no manifest is present.
  it('SYSTEM prompt does not include repo-context grounding clause when no manifest', async () => {
    const fn = makeFake('[]');
    await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
    // The system prompt must NOT contain the "## Repo context" header or
    // "Never invent file names" when no manifest is injected — the clause
    // lives in formatRepoManifest (user message) now.
    expect(call[0].system).not.toContain('Never invent file names');
    expect(call[0].system).not.toContain('When a ## Repo context section is present');
  });

  it('USER message includes grounding clause when manifest is provided', async () => {
    const fn = makeFake('[]');
    const repoManifest = {
      languages: ['TypeScript'],
      paths: ['src/index.ts'],
      allPaths: new Set(['src/index.ts']),
    };
    await predictChanges(
      {
        spec: { title: 't', changes: [] },
        changeDescriptions: [],
        structural: emptyStructural(),
        repoManifest,
      },
      fn,
      MODEL,
    );
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
    // The grounding clause is now in the USER message (via formatRepoManifest).
    expect(call[0].user).toContain('Never invent file names');
  });

  // -------------------------------------------------------------------------
  // New tests for --probes / --max-predictions / dedupe (#2477 step 1)
  // -------------------------------------------------------------------------

  describe('schema accepts up to MAX_PROBES probes', () => {
    it('accepts a prediction with MAX_PROBES probes', async () => {
      const manyProbes = Array.from({ length: MAX_PROBES }, (_, i) => `probe ${i + 1} is unique task ${i}`);
      const preds = [
        { id: 'p1', behavior: 'b', direction: 'added', confidence: 'low', reason: 'r',
          testQuestion: 'Does the response x?', probes: manyProbes },
      ];
      const result = await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
        makeFake(JSON.stringify(preds)),
        MODEL,
      );
      expect(result).toHaveLength(1);
    });

    it('drops a prediction with more than MAX_PROBES probes (schema rejects)', async () => {
      const tooMany = Array.from({ length: MAX_PROBES + 1 }, (_, i) => `probe ${i}`);
      const preds = [
        { id: 'p1', behavior: 'b', direction: 'added', confidence: 'low', reason: 'r',
          testQuestion: 'Does the response x?', probes: tooMany },
      ];
      const result = await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
        makeFake(JSON.stringify(preds)),
        MODEL,
      );
      expect(result).toHaveLength(0);
    });
  });

  describe('probesPerPrediction in system prompt', () => {
    it('system prompt contains probesPerPrediction when specified', async () => {
      const fn = makeFake('[]');
      await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural(),
          probesPerPrediction: 4 },
        fn,
        MODEL,
      );
      const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
      expect(call[0].system).toContain('exactly 4 realistic user requests');
    });

    it('system prompt uses DEFAULT_PROBES when probesPerPrediction is not specified', async () => {
      const fn = makeFake('[]');
      await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
        fn,
        MODEL,
      );
      const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
      expect(call[0].system).toContain(`exactly ${DEFAULT_PROBES} realistic user requests`);
    });

    it('system prompt mentions DIVERSE probes', async () => {
      const fn = makeFake('[]');
      await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
        fn,
        MODEL,
      );
      const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
      expect(call[0].system).toContain('DIVERSE');
    });
  });

  describe('probes truncated to probesPerPrediction', () => {
    it('truncates probes to the requested count after dedupe', async () => {
      // 5 distinct probes but probesPerPrediction=3 → only 3 kept
      const manyProbes = [
        'unique task alpha files', 'unique task beta modules', 'unique task gamma tests',
        'unique task delta build', 'unique task epsilon deploy',
      ];
      const preds = [
        { id: 'p1', behavior: 'b', direction: 'added', confidence: 'low', reason: 'r',
          testQuestion: 'Does the response x?', probes: manyProbes },
      ];
      const result = await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural(),
          probesPerPrediction: 3 },
        makeFake(JSON.stringify(preds)),
        MODEL,
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.probes).toHaveLength(3);
    });
  });

  describe('maxPredictions cap', () => {
    it('caps predictions at maxPredictions', async () => {
      const preds = Array.from({ length: 8 }, (_, i) => ({
        id: `p${i + 1}`, behavior: `b${i}`, direction: 'added', confidence: 'low',
        reason: 'r', testQuestion: 'Does the response x?', probes: [`probe ${i} unique task`],
      }));
      const result = await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural(),
          maxPredictions: 2 },
        makeFake(JSON.stringify(preds)),
        MODEL,
      );
      expect(result.length).toBeLessThanOrEqual(2);
    });
  });

  describe('dedupe applied within each prediction', () => {
    it('drops near-duplicate probes from a prediction', async () => {
      const preds = [
        {
          id: 'p1', behavior: 'b', direction: 'added', confidence: 'low', reason: 'r',
          testQuestion: 'Does the response x?',
          // First two probes are near-duplicates; third is distinct
          probes: [
            'Please refactor the authentication module',
            'Please refactor the authentication module now',
            'Write unit tests for the payment service handler',
          ],
        },
      ];
      const result = await predictChanges(
        { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural(),
          probesPerPrediction: 3 },
        makeFake(JSON.stringify(preds)),
        MODEL,
      );
      expect(result).toHaveLength(1);
      // The near-dup is dropped; only 2 distinct probes remain
      expect(result[0]!.probes.length).toBeLessThan(3);
    });
  });

  describe('resolveMaxPredictions', () => {
    it('returns explicit value when provided', () => {
      expect(resolveMaxPredictions(6, 5)).toBe(5);
    });
    it('returns 3 when probes > 2 and no explicit', () => {
      expect(resolveMaxPredictions(3)).toBe(3);
      expect(resolveMaxPredictions(6)).toBe(3);
    });
    it('returns 8 when probes <= 2 and no explicit (legacy)', () => {
      expect(resolveMaxPredictions(1)).toBe(8);
      expect(resolveMaxPredictions(2)).toBe(8);
    });
  });
});
