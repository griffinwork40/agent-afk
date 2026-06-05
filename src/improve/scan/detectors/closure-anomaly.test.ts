/**
 * Tests for `improve/scan/detectors/closure-anomaly.ts`.
 *
 * Coverage:
 *   - `model_end_turn` is never detected.
 *   - Each anomalous reason produces a card (budget_exceeded, timeout,
 *     hook_blocked, abort, iteration_cap, max_turns_exceeded).
 *   - Multiple sessions sharing a reason merge into ONE detection with
 *     multiple evidence rows.
 *   - `minOccurrences` threshold honored.
 *   - Severity ladder per reason.
 *   - Slug is deterministic and matches the FailureCardSchema regex.
 *   - Evidence count is capped at MAX_EVIDENCE_PER_CARD (8).
 *   - Detail fields include affectedSessions, totalCostUsd, avgTurnCount.
 *   - DetectorResult is parseable by DetectorResultSchema.
 */

import { describe, it, expect } from 'vitest';
import { parseTraceContent, type SessionRead } from '../reader.js';
import {
  detectClosureAnomaly,
  makeSlug,
  DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES,
} from './closure-anomaly.js';
import { DetectorResultSchema, FailureCardSchema } from '../../schemas.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let seqCounter = 0;
function resetSeq(): void {
  seqCounter = 0;
}

function closureLine(reason: string, finalCostUsd = 0, finalTurnCount = 5): string {
  return JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'closure',
    payload: {
      reason,
      finalTurnCount,
      finalCostUsd,
      finalTokens: { input: 100, output: 200 },
    },
  });
}

function makeSession(sessionId: string, lines: string[]): SessionRead {
  return parseTraceContent({
    sessionId,
    tracePath: `/abs/witness/${sessionId}/trace.jsonl`,
    relativeTracePath: `state/witness/${sessionId}/trace.jsonl`,
    content: lines.join('\n'),
    sessionMtimeMs: 1_700_000_000_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectClosureAnomaly — happy paths', () => {
  it('returns no results for sessions with only model_end_turn', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [closureLine('model_end_turn')]),
      makeSession('s2', [closureLine('model_end_turn')]),
    ];
    expect(detectClosureAnomaly(sessions)).toEqual([]);
  });

  it('returns no results for sessions with no closure events', () => {
    resetSeq();
    const sessions = [makeSession('s1', [])];
    expect(detectClosureAnomaly(sessions)).toEqual([]);
  });

  it('detects each of the six anomalous reasons', () => {
    const reasons = [
      'budget_exceeded',
      'timeout',
      'hook_blocked',
      'abort',
      'iteration_cap',
      'max_turns_exceeded',
    ] as const;
    for (const reason of reasons) {
      resetSeq();
      const sessions = [makeSession(`s-${reason}`, [closureLine(reason)])];
      const results = detectClosureAnomaly(sessions);
      expect(results).toHaveLength(1);
      expect(results[0]?.pattern).toBe('closure-anomaly');
      expect(results[0]?.detail['closureReason']).toBe(reason);
    }
  });

  it('merges sessions sharing a reason into one detection', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [closureLine('budget_exceeded', 1.5, 10)]),
      makeSession('s2', [closureLine('budget_exceeded', 2.0, 12)]),
      makeSession('s3', [closureLine('budget_exceeded', 0.5, 8)]),
    ];
    const results = detectClosureAnomaly(sessions);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.detail['affectedSessions']).toBe(3);
    expect(r.evidence).toHaveLength(3);
    expect(r.detail['totalCostUsd']).toBe(4); // 1.5 + 2.0 + 0.5
    expect(r.detail['avgTurnCount']).toBe(10); // (10+12+8)/3
  });

  it('produces a separate detection per distinct reason', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [closureLine('budget_exceeded')]),
      makeSession('s2', [closureLine('timeout')]),
      makeSession('s3', [closureLine('hook_blocked')]),
    ];
    const results = detectClosureAnomaly(sessions);
    expect(results).toHaveLength(3);
    const reasons = new Set(results.map((r) => r.detail['closureReason']));
    expect(reasons).toEqual(new Set(['budget_exceeded', 'timeout', 'hook_blocked']));
  });
});

describe('detectClosureAnomaly — threshold + severity', () => {
  it('honors minOccurrences', () => {
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('abort')])];
    expect(detectClosureAnomaly(sessions, { minOccurrences: 1 })).toHaveLength(1);
    expect(detectClosureAnomaly(sessions, { minOccurrences: 2 })).toHaveLength(0);
  });

  it('rejects minOccurrences < 1', () => {
    expect(() => detectClosureAnomaly([], { minOccurrences: 0 })).toThrow(
      /minOccurrences must be >= 1/,
    );
  });

  it('budget_exceeded is high severity even with one occurrence', () => {
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('budget_exceeded')])];
    expect(detectClosureAnomaly(sessions)[0]?.severity).toBe('high');
  });

  it('timeout is high severity even with one occurrence', () => {
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('timeout')])];
    expect(detectClosureAnomaly(sessions)[0]?.severity).toBe('high');
  });

  it('hook_blocked starts medium, escalates to high at >=3', () => {
    resetSeq();
    const s1 = [makeSession('s1', [closureLine('hook_blocked')])];
    expect(detectClosureAnomaly(s1)[0]?.severity).toBe('medium');

    resetSeq();
    const s3 = [
      makeSession('a', [closureLine('hook_blocked')]),
      makeSession('b', [closureLine('hook_blocked')]),
      makeSession('c', [closureLine('hook_blocked')]),
    ];
    expect(detectClosureAnomaly(s3)[0]?.severity).toBe('high');
  });

  it('abort starts low, escalates to medium at >=3', () => {
    resetSeq();
    const s1 = [makeSession('s1', [closureLine('abort')])];
    expect(detectClosureAnomaly(s1)[0]?.severity).toBe('low');

    resetSeq();
    const s3 = [
      makeSession('a', [closureLine('abort')]),
      makeSession('b', [closureLine('abort')]),
      makeSession('c', [closureLine('abort')]),
    ];
    expect(detectClosureAnomaly(s3)[0]?.severity).toBe('medium');
  });
});

describe('detectClosureAnomaly — slug + schema conformance', () => {
  it('makeSlug is deterministic', () => {
    expect(makeSlug('budget_exceeded')).toBe('closure-anomaly-budget-exceeded');
    expect(makeSlug('budget_exceeded')).toBe(makeSlug('budget_exceeded'));
  });

  it('makeSlug satisfies the FailureCardSchema slug regex', () => {
    for (const r of ['budget_exceeded', 'timeout', 'hook_blocked', 'abort', 'iteration_cap', 'max_turns_exceeded']) {
      expect(makeSlug(r)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('produces a DetectorResult that parses against the schema', () => {
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('budget_exceeded', 1.5, 10)])];
    const results = detectClosureAnomaly(sessions);
    expect(results).toHaveLength(1);
    const parsed = DetectorResultSchema.safeParse(results[0]);
    expect(parsed.success).toBe(true);
  });

  it('produces evidence that can be merged into a FailureCardSchema', () => {
    // Make sure the detection's evidence fits into a card without rejection.
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('timeout', 0, 3)])];
    const r = detectClosureAnomaly(sessions)[0]!;
    // Construct what the writer would build for a first-sighting card.
    const card = {
      schemaVersion: 1 as const,
      slug: r.slug,
      title: r.title,
      pattern: r.pattern,
      severity: r.severity,
      status: 'open' as const,
      firstSeen: r.observedAt,
      lastSeen: r.observedAt,
      occurrenceCount: r.evidence.length,
      evidence: r.evidence,
      detail: r.detail,
      notes: [],
    };
    expect(FailureCardSchema.safeParse(card).success).toBe(true);
  });
});

describe('detectClosureAnomaly — evidence cap', () => {
  it('caps evidence at 8 rows even with 20 affected sessions', () => {
    resetSeq();
    const sessions = Array.from({ length: 20 }, (_, i) =>
      makeSession(`s-${i}`, [closureLine('budget_exceeded')]),
    );
    const r = detectClosureAnomaly(sessions)[0]!;
    expect(r.evidence).toHaveLength(8);
    // detail still records all 20.
    expect(r.detail['affectedSessions']).toBe(20);
    expect((r.detail['sessionIds'] as string[]).length).toBe(20);
  });
});

describe('default min occurrences', () => {
  it('is 1 (every anomalous closure is flagged by default)', () => {
    expect(DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES).toBe(1);
  });
});
