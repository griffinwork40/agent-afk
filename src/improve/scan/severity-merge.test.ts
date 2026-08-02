/**
 * Tests for severity reconciliation across a detector version change.
 *
 * The rule under test: severity ratchets UP by default, but a detector version
 * change makes the fresh detection authoritative in BOTH directions — otherwise
 * a card whose `high` came from superseded arithmetic could never come back
 * down, and correcting the numbers would leave the headline verdict wrong.
 */

import { describe, it, expect } from 'vitest';
import { maxSeverity, detectorTag, reconcileSeverity } from './severity-merge.js';
import type { FailureCard, DetectorResult } from '../schemas.js';

function card(severity: FailureCard['severity'], detector?: string): FailureCard {
  return {
    schemaVersion: 1,
    slug: 'closure-anomaly-abort',
    title: 'existing',
    pattern: 'closure-anomaly',
    severity,
    status: 'open',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z',
    occurrenceCount: 1,
    evidence: [],
    detail: detector === undefined ? {} : { detector },
    notes: [],
  };
}

function detection(severity: DetectorResult['severity'], detector?: string): DetectorResult {
  return {
    slug: 'closure-anomaly-abort',
    title: 'fresh',
    pattern: 'closure-anomaly',
    severity,
    observedAt: '2026-02-01T00:00:00.000Z',
    evidence: [],
    detail: detector === undefined ? {} : { detector },
  };
}

describe('maxSeverity', () => {
  it('returns the higher rank', () => {
    expect(maxSeverity('low', 'high')).toBe('high');
    expect(maxSeverity('high', 'low')).toBe('high');
    expect(maxSeverity('medium', 'medium')).toBe('medium');
  });
});

describe('detectorTag', () => {
  it('reads a non-empty string tag', () => {
    expect(detectorTag({ detector: 'closure-anomaly@v2' })).toBe('closure-anomaly@v2');
  });

  it('treats missing, empty, and non-string tags as undefined', () => {
    expect(detectorTag(undefined)).toBeUndefined();
    expect(detectorTag({})).toBeUndefined();
    expect(detectorTag({ detector: '' })).toBeUndefined();
    expect(detectorTag({ detector: 42 })).toBeUndefined();
  });
});

describe('reconcileSeverity', () => {
  it('escalates when the detector version is unchanged', () => {
    const s = reconcileSeverity(card('low', 'closure-anomaly@v2'), detection('high', 'closure-anomaly@v2'));
    expect(s).toBe('high');
  });

  it('does NOT de-escalate when the detector version is unchanged', () => {
    // The deliberate default: a quiet window must not downgrade a real incident.
    const s = reconcileSeverity(card('high', 'closure-anomaly@v2'), detection('low', 'closure-anomaly@v2'));
    expect(s).toBe('high');
  });

  it('DE-ESCALATES across a detector version change', () => {
    // The regression this fix exists for: a v1 `high` computed from
    // event-as-session counting must yield to v2's corrected verdict.
    const s = reconcileSeverity(card('high', 'closure-anomaly@v1'), detection('low', 'closure-anomaly@v2'));
    expect(s).toBe('low');
  });

  it('also escalates across a version change (fresh detection is authoritative both ways)', () => {
    const s = reconcileSeverity(card('low', 'closure-anomaly@v1'), detection('high', 'closure-anomaly@v2'));
    expect(s).toBe('high');
  });

  it('stays escalate-only when the existing card is untagged', () => {
    // An untagged legacy card is not evidence of a version CHANGE, so the safe
    // default applies and its severity is preserved.
    expect(reconcileSeverity(card('high'), detection('low', 'closure-anomaly@v2'))).toBe('high');
  });

  it('stays escalate-only when the detection is untagged', () => {
    expect(reconcileSeverity(card('high', 'closure-anomaly@v1'), detection('low'))).toBe('high');
  });

  it('leaves every other detector on escalate-only semantics', () => {
    // A detector that never versions itself keeps identical behaviour.
    expect(
      reconcileSeverity(card('high', 'repeated-tool-use@v1'), detection('low', 'repeated-tool-use@v1')),
    ).toBe('high');
  });
});
