/**
 * Tests for `src/whatif/observability.ts`.
 *
 * Pure function tests: no I/O, no model calls. Observability is a
 * predict-time tag (#2409); nothing here looks at traces.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOWNSTREAM_REASON,
  INTERCEPTED_INTENT_RULE,
  observabilityOf,
  unobservableReason,
} from './observability.js';
import type { Prediction } from './types.js';

// ---------------------------------------------------------------------------
// INTERCEPTED_INTENT_RULE
// ---------------------------------------------------------------------------

describe('INTERCEPTED_INTENT_RULE', () => {
  it('is a non-empty string', () => {
    expect(typeof INTERCEPTED_INTENT_RULE).toBe('string');
    expect(INTERCEPTED_INTENT_RULE.length).toBeGreaterThan(20);
  });

  it('mentions the intercepted format marker', () => {
    expect(INTERCEPTED_INTENT_RULE).toContain('[tool requested:');
  });

  it('mentions "not executed"', () => {
    expect(INTERCEPTED_INTENT_RULE).toContain('not executed');
  });

  it('instructs grading intent not completion', () => {
    expect(INTERCEPTED_INTENT_RULE.toLowerCase()).toContain('intent');
  });
});

// ---------------------------------------------------------------------------
// observabilityOf
// ---------------------------------------------------------------------------

describe('observabilityOf', () => {
  it('defaults a missing tag to decision (results written before #2409)', () => {
    expect(observabilityOf({})).toBe('decision');
  });

  it('keeps an explicit tag', () => {
    expect(observabilityOf({ observable: 'decision' })).toBe('decision');
    expect(observabilityOf({ observable: 'downstream' })).toBe('downstream');
  });

  it('treats an unrecognised value (e.g. from hand-edited JSON) as decision', () => {
    const odd = { observable: 'later' as unknown as Prediction['observable'] };
    expect(observabilityOf(odd)).toBe('decision');
  });
});

// ---------------------------------------------------------------------------
// unobservableReason
// ---------------------------------------------------------------------------

describe('unobservableReason', () => {
  it('is undefined for a decision prediction', () => {
    expect(unobservableReason({ observable: 'decision' })).toBeUndefined();
  });

  it('is undefined when the tag is missing', () => {
    expect(unobservableReason({})).toBeUndefined();
  });

  it('uses the prediction’s own reason for a downstream prediction', () => {
    const reason = unobservableReason({ observable: 'downstream', observabilityReason: 'tests must run' });
    expect(reason).toContain('tests must run');
    expect(reason).toContain('episode boundary');
  });

  it('falls back to a default reason when a downstream prediction gives none', () => {
    expect(unobservableReason({ observable: 'downstream' })).toContain(DEFAULT_DOWNSTREAM_REASON);
    expect(unobservableReason({ observable: 'downstream', observabilityReason: '  ' })).toContain(
      DEFAULT_DOWNSTREAM_REASON,
    );
  });

  it('ignores a reason attached to a decision prediction', () => {
    expect(unobservableReason({ observable: 'decision', observabilityReason: 'stray' })).toBeUndefined();
  });
});
