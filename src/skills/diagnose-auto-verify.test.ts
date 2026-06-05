import { describe, it, expect, vi } from 'vitest';
import {
  autoVerifyHypotheses,
  parseShadowVerifyOutput,
  type Hypothesis,
  type Verification,
  type VerifyBatchFn,
} from './diagnose/index.js';

function h(id: string, overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id,
    claim: `claim for ${id}`,
    confidence: 0.9,
    evidence_sources: [`evidence-${id}`],
    ...overrides,
  };
}

function verification(claim: string, verdict: Verification['verdict']): Verification {
  return { claim, verdict, evidence: `evidence for ${claim}` };
}

describe('autoVerifyHypotheses', () => {
  it('skips shadow-verify and keeps all hypotheses when none trip the gate', async () => {
    const hypotheses = [h('h1'), h('h2')];
    const verify: VerifyBatchFn = vi.fn();

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(verify).not.toHaveBeenCalled();
    expect(result.premise_verifications).toEqual([]);
    expect(result.hypotheses_to_test).toEqual(hypotheses);
  });

  it('dispatches shadow-verify for low-confidence hypotheses only', async () => {
    const hypotheses = [h('h1', { confidence: 0.3 }), h('h2', { confidence: 0.9 })];
    const verify: VerifyBatchFn = vi
      .fn()
      .mockResolvedValue([verification('claim for h1', 'VERIFIED')]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(verify).toHaveBeenCalledWith(['claim for h1']);
    expect(result.premise_verifications).toHaveLength(1);
    expect(result.premise_verifications[0]).toMatchObject({
      hypothesis_id: 'h1',
      verdict: 'VERIFIED',
    });
    expect(result.premise_verifications[0]!.gate_reason).toContain('low confidence');
    expect(result.hypotheses_to_test).toEqual(hypotheses);
  });

  it('drops REFUTED hypotheses from hypotheses_to_test', async () => {
    const hypotheses = [
      h('h1', { confidence: 0.3 }),
      h('h2', { confidence: 0.3 }),
      h('h3', { confidence: 0.9 }),
    ];
    const verify: VerifyBatchFn = vi.fn().mockResolvedValue([
      verification('claim for h1', 'REFUTED'),
      verification('claim for h2', 'VERIFIED'),
    ]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    const ids = result.hypotheses_to_test.map((hx) => hx.id);
    expect(ids).toEqual(['h2', 'h3']);
    expect(result.premise_verifications.map((pv) => pv.verdict)).toEqual([
      'REFUTED',
      'VERIFIED',
    ]);
  });

  it('keeps INCONCLUSIVE hypotheses in hypotheses_to_test', async () => {
    const hypotheses = [h('h1', { confidence: 0.3 })];
    const verify: VerifyBatchFn = vi
      .fn()
      .mockResolvedValue([verification('claim for h1', 'INCONCLUSIVE')]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(result.hypotheses_to_test.map((hx) => hx.id)).toEqual(['h1']);
    expect(result.premise_verifications[0]!.verdict).toBe('INCONCLUSIVE');
  });

  it('gates on coverage_gaps even when confidence is high', async () => {
    const hypotheses = [
      h('h1', { confidence: 0.95, coverage_gaps: ['could not read src/foo.ts'] }),
    ];
    const verify: VerifyBatchFn = vi
      .fn()
      .mockResolvedValue([verification('claim for h1', 'VERIFIED')]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(verify).toHaveBeenCalledWith(['claim for h1']);
    expect(result.premise_verifications[0]!.gate_reason).toContain('coverage gap');
  });

  it('gates on boundary_flag even when confidence is high', async () => {
    const hypotheses = [
      h('h1', { confidence: 0.95, boundary_flag: 'Grep timed out' }),
    ];
    const verify: VerifyBatchFn = vi
      .fn()
      .mockResolvedValue([verification('claim for h1', 'VERIFIED')]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(verify).toHaveBeenCalledWith(['claim for h1']);
    expect(result.premise_verifications[0]!.gate_reason).toContain('boundary');
  });

  it('marks all gated hypotheses INCONCLUSIVE when verify throws', async () => {
    const hypotheses = [
      h('h1', { confidence: 0.3 }),
      h('h2', { confidence: 0.4 }),
    ];
    const verify: VerifyBatchFn = vi
      .fn()
      .mockRejectedValue(new Error('shadow-verify network error'));

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(result.premise_verifications).toHaveLength(2);
    for (const pv of result.premise_verifications) {
      expect(pv.verdict).toBe('INCONCLUSIVE');
      expect(pv.evidence).toContain('shadow-verify network error');
    }
    // Nothing is dropped on dispatch failure — all hypotheses stay in play
    expect(result.hypotheses_to_test).toEqual(hypotheses);
  });

  it('handles missing per-claim verifier results as INCONCLUSIVE', async () => {
    const hypotheses = [
      h('h1', { confidence: 0.3 }),
      h('h2', { confidence: 0.3 }),
    ];
    // Verifier returns only one result for two gated claims
    const verify: VerifyBatchFn = vi
      .fn()
      .mockResolvedValue([verification('claim for h1', 'VERIFIED')]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(result.premise_verifications[0]!.verdict).toBe('VERIFIED');
    expect(result.premise_verifications[1]!.verdict).toBe('INCONCLUSIVE');
    expect(result.premise_verifications[1]!.evidence).toContain('no verifier result');
  });

  it('preserves hypothesis order in premise_verifications', async () => {
    const hypotheses = [
      h('h1', { confidence: 0.9 }),
      h('h2', { confidence: 0.3 }),
      h('h3', { confidence: 0.9 }),
      h('h4', { confidence: 0.3 }),
    ];
    const verify: VerifyBatchFn = vi.fn().mockResolvedValue([
      verification('claim for h2', 'REFUTED'),
      verification('claim for h4', 'VERIFIED'),
    ]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(result.premise_verifications.map((pv) => pv.hypothesis_id)).toEqual([
      'h2',
      'h4',
    ]);
    expect(result.hypotheses_to_test.map((hx) => hx.id)).toEqual(['h1', 'h3', 'h4']);
  });

  it('returns empty hypotheses_to_test when every hypothesis is REFUTED', async () => {
    const hypotheses = [
      h('h1', { confidence: 0.3 }),
      h('h2', { confidence: 0.3 }),
    ];
    const verify: VerifyBatchFn = vi.fn().mockResolvedValue([
      verification('claim for h1', 'REFUTED'),
      verification('claim for h2', 'REFUTED'),
    ]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(result.hypotheses_to_test).toEqual([]);
    expect(result.premise_verifications).toHaveLength(2);
  });

  // Regression: the real dispatcher used to do `JSON.parse(rawOutput) as
  // { verifications: Verification[] }`. When shadow-verify returned valid JSON
  // WITHOUT a `verifications` array, the cast yielded `undefined`, the callback
  // resolved `undefined` (no throw), and `verifications[i]` then threw a
  // TypeError OUTSIDE this function's try/catch — crashing /diagnose and
  // violating the documented "Never throws" contract.
  it('does not throw and marks gated INCONCLUSIVE when verify resolves undefined', async () => {
    const hypotheses = [h('h1', { confidence: 0.3 }), h('h2', { confidence: 0.3 })];
    const verify: VerifyBatchFn = vi
      .fn()
      .mockResolvedValue(undefined as unknown as Verification[]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(result.premise_verifications).toHaveLength(2);
    for (const pv of result.premise_verifications) {
      expect(pv.verdict).toBe('INCONCLUSIVE');
      expect(pv.evidence).toContain('no verifier result');
    }
    // Nothing REFUTED → no hypothesis is dropped.
    expect(result.hypotheses_to_test).toEqual(hypotheses);
  });

  it('does not throw when verify resolves a non-array value', async () => {
    const hypotheses = [h('h1', { confidence: 0.3 })];
    const verify: VerifyBatchFn = vi
      .fn()
      .mockResolvedValue({ not: 'an array' } as unknown as Verification[]);

    const result = await autoVerifyHypotheses(hypotheses, verify);

    expect(result.premise_verifications[0]!.verdict).toBe('INCONCLUSIVE');
    expect(result.premise_verifications[0]!.evidence).toContain('no verifier result');
  });
});

describe('parseShadowVerifyOutput', () => {
  it('parses a bare JSON envelope', () => {
    const raw =
      '{"verifications":[{"claim":"c1","verdict":"VERIFIED","evidence":"src/a.ts:1 ok"}]}';
    expect(parseShadowVerifyOutput(raw)).toEqual([
      { claim: 'c1', verdict: 'VERIFIED', evidence: 'src/a.ts:1 ok' },
    ]);
  });

  it('recovers the envelope from a fenced ```json block surrounded by prose', () => {
    const raw = [
      'I independently re-derived each claim. Findings below.',
      '',
      '```json',
      '{"verifications":[{"claim":"c1","verdict":"REFUTED","evidence":"src/b.ts:10 shows otherwise"}]}',
      '```',
      '',
      'Recommendation: do not act on claim 1.',
    ].join('\n');
    expect(parseShadowVerifyOutput(raw)).toEqual([
      { claim: 'c1', verdict: 'REFUTED', evidence: 'src/b.ts:10 shows otherwise' },
    ]);
  });

  it('skips a stray brace span and finds the real envelope', () => {
    const raw =
      'I think {this} is unrelated, then: {"verifications":[{"verdict":"VERIFIED","evidence":"ok"}]}';
    expect(parseShadowVerifyOutput(raw)).toEqual([
      { claim: '', verdict: 'VERIFIED', evidence: 'ok' },
    ]);
  });

  it('is unbothered by braces inside JSON string values', () => {
    const raw =
      '{"verifications":[{"claim":"matches /\\\\{.*\\\\}/","verdict":"INCONCLUSIVE","evidence":"regex {a} {b}"}]}';
    expect(parseShadowVerifyOutput(raw)).toEqual([
      { claim: 'matches /\\{.*\\}/', verdict: 'INCONCLUSIVE', evidence: 'regex {a} {b}' },
    ]);
  });

  it('normalizes verdict synonyms case-insensitively', () => {
    const raw =
      '{"verifications":[{"verdict":"confirmed","evidence":"a"},{"verdict":"Disagree","evidence":"b"},{"verdict":"maybe?","evidence":"c"}]}';
    expect(parseShadowVerifyOutput(raw).map((v) => v.verdict)).toEqual([
      'VERIFIED',
      'REFUTED',
      'INCONCLUSIVE',
    ]);
  });

  it('backfills optional claim/evidence with empty strings', () => {
    expect(parseShadowVerifyOutput('{"verifications":[{"verdict":"VERIFIED"}]}')).toEqual([
      { claim: '', verdict: 'VERIFIED', evidence: '' },
    ]);
  });

  it('throws on pure prose with no JSON', () => {
    expect(() =>
      parseShadowVerifyOutput('No JSON here — just a narrative about the claims.'),
    ).toThrow(/verifications/i);
  });

  it('throws on JSON missing the verifications key', () => {
    expect(() => parseShadowVerifyOutput('{"foo":"bar"}')).toThrow(/verifications/i);
  });
});
