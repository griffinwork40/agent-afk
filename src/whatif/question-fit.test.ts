/**
 * Tests for `src/whatif/question-fit.ts`.
 *
 * Covers:
 *   - Empty prediction list → supported
 *   - All decision predictions → supported
 *   - All downstream predictions → unsupported
 *   - Mixed predictions → partially-supported
 *   - Missing `observable` field defaults to 'decision'
 *   - Lines include counts and actionable guidance
 *   - Downstream reasons are surfaced in lines
 */

import { describe, it, expect } from 'vitest';
import { classifyQuestionFit } from './question-fit.js';
import type { Prediction } from './types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDecision(id: string, behavior = 'asks a clarifying question'): Prediction {
  return {
    id,
    behavior,
    direction: 'added',
    confidence: 'medium',
    reason: 'rule added',
    testQuestion: 'Does the response ask a clarifying question?',
    probes: ['fix the bug'],
    observable: 'decision',
  };
}

function makeDownstream(id: string, behavior = 'test suite passes', reason?: string): Prediction {
  return {
    id,
    behavior,
    direction: 'strengthened',
    confidence: 'low',
    reason: 'implementation quality',
    testQuestion: 'Does the result make the tests pass?',
    probes: ['implement the feature'],
    observable: 'downstream',
    ...(reason !== undefined ? { observabilityReason: reason } : {}),
  };
}

function makeNoTag(id: string): Prediction {
  // Deliberately omit the `observable` field (backward-compat).
  const p = makeDecision(id);
  const { observable: _ignored, ...rest } = p;
  return rest as Prediction;
}

// ---------------------------------------------------------------------------
// Empty predictions
// ---------------------------------------------------------------------------

describe('classifyQuestionFit — empty', () => {
  it('returns supported when there are no predictions', () => {
    const result = classifyQuestionFit([]);
    expect(result.level).toBe('supported');
    expect(result.decisionCount).toBe(0);
    expect(result.downstreamCount).toBe(0);
  });

  it('lines mention no-prediction and no-confirmation-signal', () => {
    const result = classifyQuestionFit([]);
    const joined = result.lines.join(' ');
    expect(joined).toMatch(/no behavior changes predicted/);
    expect(joined).toMatch(/no confirmation signal/);
  });
});

// ---------------------------------------------------------------------------
// All decision
// ---------------------------------------------------------------------------

describe('classifyQuestionFit — all decision', () => {
  it('returns supported when every prediction is decision', () => {
    const result = classifyQuestionFit([makeDecision('p1'), makeDecision('p2')]);
    expect(result.level).toBe('supported');
    expect(result.decisionCount).toBe(2);
    expect(result.downstreamCount).toBe(0);
  });

  it('lines confirm all predictions are measurable', () => {
    const result = classifyQuestionFit([makeDecision('p1')]);
    expect(result.lines[0]).toMatch(/supported/);
    expect(result.lines[0]).toMatch(/measurable/);
  });
});

// ---------------------------------------------------------------------------
// All downstream
// ---------------------------------------------------------------------------

describe('classifyQuestionFit — all downstream', () => {
  it('returns unsupported when every prediction is downstream', () => {
    const result = classifyQuestionFit([makeDownstream('p1'), makeDownstream('p2')]);
    expect(result.level).toBe('unsupported');
    expect(result.decisionCount).toBe(0);
    expect(result.downstreamCount).toBe(2);
  });

  it('lines mention the action-completion constraint', () => {
    const result = classifyQuestionFit([makeDownstream('p1')]);
    const joined = result.lines.join(' ');
    expect(joined).toMatch(/require an action to complete/);
  });

  it('lines include guidance to rephrase as a decision', () => {
    const result = classifyQuestionFit([makeDownstream('p1')]);
    const joined = result.lines.join(' ');
    expect(joined).toMatch(/rephrasing/i);
  });

  it('includes observabilityReason in lines when present', () => {
    const result = classifyQuestionFit([
      makeDownstream('p1', 'test suite passes', 'needs the tests to run'),
    ]);
    const joined = result.lines.join(' ');
    expect(joined).toMatch(/needs the tests to run/);
  });

  it('falls back to behavior text when observabilityReason is absent', () => {
    const result = classifyQuestionFit([makeDownstream('p1', 'implementation is correct')]);
    const joined = result.lines.join(' ');
    expect(joined).toMatch(/implementation is correct/);
  });
});

// ---------------------------------------------------------------------------
// Mixed
// ---------------------------------------------------------------------------

describe('classifyQuestionFit — mixed', () => {
  it('returns partially-supported when both kinds are present', () => {
    const result = classifyQuestionFit([makeDecision('p1'), makeDownstream('p2')]);
    expect(result.level).toBe('partially-supported');
    expect(result.decisionCount).toBe(1);
    expect(result.downstreamCount).toBe(1);
  });

  it('lines show the decision/total ratio', () => {
    const result = classifyQuestionFit([makeDecision('p1'), makeDownstream('p2')]);
    expect(result.lines[0]).toMatch(/1 of 2/);
  });

  it('lines mention Unobservable marker', () => {
    const result = classifyQuestionFit([makeDecision('p1'), makeDownstream('p2')]);
    const joined = result.lines.join(' ');
    expect(joined).toMatch(/🔭 Unobservable/);
  });

  it('counts correctly for 3 decision + 2 downstream', () => {
    const preds = [
      makeDecision('p1'), makeDecision('p2'), makeDecision('p3'),
      makeDownstream('p4'), makeDownstream('p5'),
    ];
    const result = classifyQuestionFit(preds);
    expect(result.level).toBe('partially-supported');
    expect(result.decisionCount).toBe(3);
    expect(result.downstreamCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Missing `observable` field (backward-compat)
// ---------------------------------------------------------------------------

describe('classifyQuestionFit — missing observable field', () => {
  it('treats absent observable as decision', () => {
    const result = classifyQuestionFit([makeNoTag('p1')]);
    expect(result.level).toBe('supported');
    expect(result.decisionCount).toBe(1);
    expect(result.downstreamCount).toBe(0);
  });

  it('mixes absent-tag with downstream correctly', () => {
    const result = classifyQuestionFit([makeNoTag('p1'), makeDownstream('p2')]);
    expect(result.level).toBe('partially-supported');
    expect(result.decisionCount).toBe(1);
    expect(result.downstreamCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Line count and format
// ---------------------------------------------------------------------------

describe('classifyQuestionFit — lines format', () => {
  it('always returns at least one line', () => {
    for (const preds of [
      [],
      [makeDecision('p1')],
      [makeDownstream('p1')],
      [makeDecision('p1'), makeDownstream('p2')],
    ]) {
      const result = classifyQuestionFit(preds);
      expect(result.lines.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('prefixes all lines with [question-fit]', () => {
    // Only the first line is required to carry the prefix.
    for (const preds of [
      [],
      [makeDecision('p1')],
      [makeDownstream('p1')],
    ]) {
      const result = classifyQuestionFit(preds);
      expect(result.lines[0]).toMatch(/^\[question-fit\]/);
    }
  });
});
