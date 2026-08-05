import { describe, expect, it } from 'vitest';
import type { EvalCase } from '../../improve/schemas.js';
import { findEvalCaseForEvidenceRow } from './improve/eval-gen.js';

function evalCase(evalCaseId: string, evidenceRowIndex: number): EvalCase {
  return {
    evalCaseId,
    replay: { evidenceRowIndex },
  } as EvalCase;
}

describe('findEvalCaseForEvidenceRow', () => {
  const existing = [evalCase('row-zero', 0), evalCase('row-two', 2)];

  it('finds an existing case for an explicitly selected duplicate row', () => {
    expect(findEvalCaseForEvidenceRow(existing, 0)?.evalCaseId).toBe('row-zero');
  });

  it('allows a genuinely different evidence row', () => {
    expect(findEvalCaseForEvidenceRow(existing, 1)).toBeUndefined();
  });
});
