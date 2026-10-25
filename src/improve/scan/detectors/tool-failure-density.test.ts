/**
 * Tests for `improve/scan/detectors/tool-failure-density.ts`.
 *
 * Coverage:
 *   - Tools below either threshold do not fire.
 *   - Tools meeting both thresholds fire one card.
 *   - Each tool gets its own card; results are deterministic-ordered.
 *   - Sessions sharing a failing tool merge into one detection with
 *     multiple evidence rows.
 *   - Severity ladder by rate × count.
 *   - Evidence is capped at MAX_EVIDENCE_PER_CARD (8).
 *   - `detail` records totalCalls / failureCount / failureRate /
 *     affectedSessionCount / truncatedFailureCount.
 *   - Slug is deterministic and matches the FailureCardSchema regex.
 *   - DetectorResult is parseable by DetectorResultSchema.
 *   - Threshold validation: minFailures < 1 and rate outside (0, 1] throw.
 */

import { describe, it, expect } from 'vitest';
import { parseTraceContent, type SessionRead } from '../reader.js';
import {
  detectToolFailureDensity,
  makeSlug,
  normalizeErrorHead,
  MAX_ERROR_CLUSTERS,
  DEFAULT_TOOL_FAILURE_MIN_FAILURES,
  DEFAULT_TOOL_FAILURE_MIN_RATE,
} from './tool-failure-density.js';
import { DetectorResultSchema, FailureCardSchema } from '../../schemas.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let seqCounter = 0;
function resetSeq(): void {
  seqCounter = 0;
}

/**
 * Build a `tool_call started` + `tool_call completed` event pair as JSONL
 * lines. The detector only consumes the `completed` half.
 */
function toolPair(
  toolUseId: string,
  name: string,
  opts: {
    isError?: boolean;
    truncated?: boolean;
    durationMs?: number;
    resultBytes?: number;
    circuitBreaker?: boolean;
    failureClass?: string;
    errorHead?: string;
  } = {},
): string[] {
  const started = JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'tool_call',
    payload: { phase: 'started', toolUseId, name, inputBytes: 100, argsFingerprint: 'abcd1234'.repeat(8) },
  });
  const completedPayload: Record<string, unknown> = {
    phase: 'completed',
    toolUseId,
    name,
    resultBytes: opts.resultBytes ?? 200,
    isError: opts.isError ?? false,
    truncated: opts.truncated ?? false,
    durationMs: opts.durationMs ?? 50,
  };
  if (opts.circuitBreaker === true) completedPayload['circuitBreaker'] = true;
  if (opts.failureClass !== undefined) completedPayload['failureClass'] = opts.failureClass;
  if (opts.errorHead !== undefined) completedPayload['errorHead'] = opts.errorHead;
  const completed = JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'tool_call',
    payload: completedPayload,
  });
  return [started, completed];
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

describe('detectToolFailureDensity — threshold gating', () => {
  it('returns no results when no tools call completed', () => {
    resetSeq();
    expect(detectToolFailureDensity([])).toEqual([]);
    expect(detectToolFailureDensity([makeSession('s1', [])])).toEqual([]);
  });

  it('does not fire on a tool with zero failures', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash'),
      ...toolPair('b', 'Bash'),
      ...toolPair('c', 'Bash'),
      ...toolPair('d', 'Bash'),
    ];
    expect(detectToolFailureDensity([makeSession('s1', lines)])).toEqual([]);
  });

  it('does not fire when failure count is below minFailures', () => {
    resetSeq();
    // 2 failures out of 4 = 50% rate, but below default minFailures=3.
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash'),
      ...toolPair('d', 'Bash'),
    ];
    expect(detectToolFailureDensity([makeSession('s1', lines)])).toEqual([]);
  });

  it('does not fire when failure rate is below minFailureRate (high N)', () => {
    resetSeq();
    // 3 failures out of 100 = 3% rate. Above minFailures=3, below rate=0.25.
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push(...toolPair(`f-${i}`, 'Bash', { isError: true }));
    }
    for (let i = 0; i < 97; i++) {
      lines.push(...toolPair(`ok-${i}`, 'Bash'));
    }
    expect(detectToolFailureDensity([makeSession('s1', lines)])).toEqual([]);
  });

  it('fires when both thresholds are met', () => {
    resetSeq();
    // 3 failures out of 6 = 50%. Above both defaults.
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash', { isError: true }),
      ...toolPair('d', 'Bash'),
      ...toolPair('e', 'Bash'),
      ...toolPair('f', 'Bash'),
    ];
    const results = detectToolFailureDensity([makeSession('s1', lines)]);
    expect(results).toHaveLength(1);
    expect(results[0]?.pattern).toBe('tool-failure-density');
    expect(results[0]?.detail['toolName']).toBe('Bash');
    expect(results[0]?.detail['totalCalls']).toBe(6);
    expect(results[0]?.detail['failureCount']).toBe(3);
    expect(results[0]?.detail['failureRate']).toBe(0.5);
  });
});

describe('detectToolFailureDensity — multi-tool aggregation', () => {
  it('produces one card per tool, deterministically ordered by slug', () => {
    resetSeq();
    const lines = [
      // Bash: 3/3 fail.
      ...toolPair('b1', 'Bash', { isError: true }),
      ...toolPair('b2', 'Bash', { isError: true }),
      ...toolPair('b3', 'Bash', { isError: true }),
      // Grep: 4/4 fail.
      ...toolPair('g1', 'Grep', { isError: true }),
      ...toolPair('g2', 'Grep', { isError: true }),
      ...toolPair('g3', 'Grep', { isError: true }),
      ...toolPair('g4', 'Grep', { isError: true }),
      // Read: 0/3 fail → no card.
      ...toolPair('r1', 'Read'),
      ...toolPair('r2', 'Read'),
      ...toolPair('r3', 'Read'),
    ];
    const results = detectToolFailureDensity([makeSession('s1', lines)]);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.detail['toolName'])).toEqual(['Bash', 'Grep']);
  });

  it('merges failures of the same tool across sessions', () => {
    resetSeq();
    // 3 sessions each contribute 1 failure + 1 success on Bash = 3/6 total.
    const sessions = ['s1', 's2', 's3'].map((id) =>
      makeSession(id, [
        ...toolPair(`${id}-f`, 'Bash', { isError: true }),
        ...toolPair(`${id}-ok`, 'Bash'),
      ]),
    );
    const results = detectToolFailureDensity(sessions);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.detail['totalCalls']).toBe(6);
    expect(r.detail['failureCount']).toBe(3);
    expect(r.detail['affectedSessionCount']).toBe(3);
    expect(r.evidence).toHaveLength(3);
    const sessionIds = new Set(r.evidence.map((e) => e.sessionId));
    expect(sessionIds).toEqual(new Set(['s1', 's2', 's3']));
  });

  it('records truncatedFailureCount when failures are also truncated', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', { isError: true, truncated: true }),
      ...toolPair('b', 'Bash', { isError: true, truncated: true }),
      ...toolPair('c', 'Bash', { isError: true, truncated: false }),
      ...toolPair('d', 'Bash'),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.detail['truncatedFailureCount']).toBe(2);
  });

  it('records avg failure duration', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', { isError: true, durationMs: 100 }),
      ...toolPair('b', 'Bash', { isError: true, durationMs: 200 }),
      ...toolPair('c', 'Bash', { isError: true, durationMs: 300 }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.detail['avgFailureDurationMs']).toBe(200);
  });
});

describe('detectToolFailureDensity — severity ladder', () => {
  it('100% failure rate is high regardless of count', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash', { isError: true }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.severity).toBe('high');
  });

  it('≥50% rate is high', () => {
    resetSeq();
    // 3/5 = 60%
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash', { isError: true }),
      ...toolPair('d', 'Bash'),
      ...toolPair('e', 'Bash'),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.severity).toBe('high');
  });

  it('25–49% rate with <10 failures is medium', () => {
    resetSeq();
    // 3/10 = 30%
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) lines.push(...toolPair(`f-${i}`, 'Bash', { isError: true }));
    for (let i = 0; i < 7; i++) lines.push(...toolPair(`ok-${i}`, 'Bash'));
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.severity).toBe('medium');
  });

  it('25–49% rate with ≥10 failures escalates to high', () => {
    resetSeq();
    // 10/30 ≈ 33%
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(...toolPair(`f-${i}`, 'Bash', { isError: true }));
    for (let i = 0; i < 20; i++) lines.push(...toolPair(`ok-${i}`, 'Bash'));
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.severity).toBe('high');
  });
});

describe('detectToolFailureDensity — evidence cap', () => {
  it('caps evidence at 8 rows even with many failures', () => {
    resetSeq();
    // 20 sessions, each with 1 Bash failure + 0 successes → 100% rate.
    const sessions = Array.from({ length: 20 }, (_, i) =>
      makeSession(`s-${i}`, toolPair(`f-${i}`, 'Bash', { isError: true })),
    );
    const r = detectToolFailureDensity(sessions)[0]!;
    expect(r.evidence).toHaveLength(8);
    // detail records all 20 affected sessions.
    expect(r.detail['failureCount']).toBe(20);
    expect(r.detail['affectedSessionCount']).toBe(20);
  });
});

describe('detectToolFailureDensity — threshold options', () => {
  it('honors minFailures', () => {
    resetSeq();
    // 2 failures, 100% rate.
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
    ];
    const sessions = [makeSession('s1', lines)];
    expect(detectToolFailureDensity(sessions, { minFailures: 2 })).toHaveLength(1);
    expect(detectToolFailureDensity(sessions, { minFailures: 3 })).toHaveLength(0);
  });

  it('honors minFailureRate', () => {
    resetSeq();
    // 3 failures out of 20 → 15% rate.
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) lines.push(...toolPair(`f-${i}`, 'Bash', { isError: true }));
    for (let i = 0; i < 17; i++) lines.push(...toolPair(`ok-${i}`, 'Bash'));
    const sessions = [makeSession('s1', lines)];
    expect(detectToolFailureDensity(sessions, { minFailureRate: 0.1 })).toHaveLength(1);
    expect(detectToolFailureDensity(sessions, { minFailureRate: 0.2 })).toHaveLength(0);
  });

  it('rejects minFailures < 1', () => {
    expect(() => detectToolFailureDensity([], { minFailures: 0 })).toThrow(
      /minFailures must be >= 1/,
    );
  });

  it('rejects minFailureRate <= 0', () => {
    expect(() => detectToolFailureDensity([], { minFailureRate: 0 })).toThrow(
      /minFailureRate must be in/,
    );
  });

  it('rejects minFailureRate > 1', () => {
    expect(() => detectToolFailureDensity([], { minFailureRate: 1.5 })).toThrow(
      /minFailureRate must be in/,
    );
  });
});

describe('detectToolFailureDensity — slug + schema conformance', () => {
  it('makeSlug is deterministic', () => {
    expect(makeSlug('Bash')).toBe('tool-failure-bash');
    expect(makeSlug('Bash')).toBe(makeSlug('Bash'));
  });

  it('makeSlug satisfies the FailureCardSchema slug regex', () => {
    for (const t of ['Bash', 'Grep', 'web_scrape', 'mcp__server__tool', 'X']) {
      expect(makeSlug(t)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('produces a DetectorResult that parses against the schema', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash', { isError: true }),
    ];
    const results = detectToolFailureDensity([makeSession('s1', lines)]);
    expect(results).toHaveLength(1);
    const parsed = DetectorResultSchema.safeParse(results[0]);
    expect(parsed.success).toBe(true);
  });

  it('produces evidence that fits into a FailureCardSchema', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash', { isError: true }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
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

describe('detectToolFailureDensity — defaults', () => {
  it('default minFailures is 3', () => {
    expect(DEFAULT_TOOL_FAILURE_MIN_FAILURES).toBe(3);
  });

  it('default minFailureRate is 0.25', () => {
    expect(DEFAULT_TOOL_FAILURE_MIN_RATE).toBe(0.25);
  });
});

describe('detectToolFailureDensity — circuit-breaker exclusion', () => {
  it('does NOT produce a card when all isError events carry circuitBreaker: true', () => {
    resetSeq();
    // 8 circuit-breaker trips on Bash — all have isError: true but circuitBreaker: true.
    // Should produce zero cards because they are not real tool outcomes.
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(...toolPair(`cb-${i}`, 'Bash', { isError: true, circuitBreaker: true }));
    }
    expect(detectToolFailureDensity([makeSession('s1', lines)])).toEqual([]);
  });

  it('DOES produce a card for the same events WITHOUT circuitBreaker flag (control)', () => {
    resetSeq();
    // Same shape — 8 isError events, no circuitBreaker flag — should fire.
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(...toolPair(`real-${i}`, 'Bash', { isError: true }));
    }
    const results = detectToolFailureDensity([makeSession('s1', lines)]);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['toolName']).toBe('Bash');
  });

  it('excludes circuit-breaker events from BOTH failure count and total-call denominator', () => {
    resetSeq();
    // 3 real failures + 5 circuit-breaker trips + 2 successes on Bash.
    // Real denominator: 3 + 2 = 5; real failure rate: 3/5 = 60% → fires.
    // If breaker events bled into denominator it would be 10 total, rate 30% → still fires but count differs.
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) lines.push(...toolPair(`f-${i}`, 'Bash', { isError: true }));
    for (let i = 0; i < 5; i++) {
      lines.push(...toolPair(`cb-${i}`, 'Bash', { isError: true, circuitBreaker: true }));
    }
    for (let i = 0; i < 2; i++) lines.push(...toolPair(`ok-${i}`, 'Bash'));
    const results = detectToolFailureDensity([makeSession('s1', lines)]);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['totalCalls']).toBe(5);
    expect(results[0]?.detail['failureCount']).toBe(3);
  });
});

describe('detectToolFailureDensity — failureClass exclusion', () => {
  for (const cls of [
    'policy-refusal',
    'permission-denied',
    'hook-block',
    'abort',
    'elicitation-declined',
  ]) {
    it(`does NOT produce a card when all failures are class '${cls}'`, () => {
      resetSeq();
      // 8 isError failures, all "system said no" — must produce zero cards.
      const lines: string[] = [];
      for (let i = 0; i < 8; i++) {
        lines.push(...toolPair(`x-${i}`, 'browser_open', { isError: true, failureClass: cls }));
      }
      expect(detectToolFailureDensity([makeSession('s1', lines)])).toEqual([]);
    });
  }

  it('regression: browser_open policy refusals do not manufacture a card (the reported bug)', () => {
    resetSeq();
    // The real-world shape: 10 policy refusals + 4 successes + 0 real faults.
    // Pre-fix this read as 10/14 = 71% "failure" → high-severity card.
    // Post-fix the 10 refusals are excluded from BOTH numerator and denominator,
    // leaving 0 failures / 4 calls → no card.
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(...toolPair(`p-${i}`, 'browser_open', { isError: true, failureClass: 'policy-refusal' }));
    }
    for (let i = 0; i < 4; i++) lines.push(...toolPair(`ok-${i}`, 'browser_open'));
    expect(detectToolFailureDensity([makeSession('s1', lines)])).toEqual([]);
  });

  it('excludes refusals from BOTH numerator and denominator but still fires on real faults', () => {
    resetSeq();
    // 3 real (unclassified) failures + 6 policy refusals + 2 successes.
    // Real denominator = 3 + 2 = 5; rate = 3/5 = 60% → fires with count 3, total 5.
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) lines.push(...toolPair(`f-${i}`, 'browser_open', { isError: true }));
    for (let i = 0; i < 6; i++) {
      lines.push(...toolPair(`p-${i}`, 'browser_open', { isError: true, failureClass: 'policy-refusal' }));
    }
    for (let i = 0; i < 2; i++) lines.push(...toolPair(`ok-${i}`, 'browser_open'));
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.detail['totalCalls']).toBe(5);
    expect(r.detail['failureCount']).toBe(3);
    expect(r.detail['excludedByClass']).toEqual({ 'policy-refusal': 6 });
  });

  it('regression: ask_question AFK declines do not manufacture a card (the reported bug)', () => {
    resetSeq();
    // The real-world shape that produced the false-positive `tool-failure-ask-question`
    // card: 12 elicitation declines/cancels (operator AFK on an interactive surface) out
    // of 36 ask_question calls. Pre-fix this read as 12/36 = 33% "failure" → high card.
    // Post-fix the 12 declines are excluded from BOTH numerator and denominator,
    // leaving 0 real failures / 24 calls → no card.
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(
        ...toolPair(`d-${i}`, 'ask_question', { isError: true, failureClass: 'elicitation-declined' }),
      );
    }
    for (let i = 0; i < 24; i++) lines.push(...toolPair(`ok-${i}`, 'ask_question'));
    expect(detectToolFailureDensity([makeSession('s1', lines)])).toEqual([]);
  });

  it('excludes elicitation declines from BOTH numerator and denominator but still fires on real faults', () => {
    resetSeq();
    // 3 real (unclassified) failures + 5 elicitation declines + 1 success.
    // Real denominator = 3 + 1 = 4; rate = 3/4 = 75% → fires with count 3, total 4.
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) lines.push(...toolPair(`f-${i}`, 'ask_question', { isError: true }));
    for (let i = 0; i < 5; i++) {
      lines.push(
        ...toolPair(`d-${i}`, 'ask_question', { isError: true, failureClass: 'elicitation-declined' }),
      );
    }
    lines.push(...toolPair('ok-0', 'ask_question'));
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.detail['totalCalls']).toBe(4);
    expect(r.detail['failureCount']).toBe(3);
    expect(r.detail['excludedByClass']).toEqual({ 'elicitation-declined': 5 });
  });

  it.each(['timeout', 'budget'] as const)(
    "counts '%s' as a real failure (not excluded) and surfaces it in the breakdown",
    (failureClass) => {
      resetSeq();
      const lines: string[] = [];
      for (let i = 0; i < 4; i++) {
        lines.push(...toolPair(`t-${i}`, 'browser_open', { isError: true, failureClass }));
      }
      const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
      expect(r.detail['failureCount']).toBe(4);
      expect(r.detail['totalCalls']).toBe(4);
      expect(r.detail['failureClassBreakdown']).toEqual({ [failureClass]: 4 });
    },
  );

  it('reports a mixed failureClassBreakdown including unclassified failures', () => {
    resetSeq();
    // 2 timeout + 3 unclassified faults = 5 failures / 5 calls.
    const lines: string[] = [];
    for (let i = 0; i < 2; i++) {
      lines.push(...toolPair(`t-${i}`, 'web_scrape', { isError: true, failureClass: 'timeout' }));
    }
    for (let i = 0; i < 3; i++) lines.push(...toolPair(`u-${i}`, 'web_scrape', { isError: true }));
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.detail['failureClassBreakdown']).toEqual({ timeout: 2, unclassified: 3 });
  });

  it('back-compat: failures with NO failureClass count exactly as before', () => {
    resetSeq();
    // Mirrors the pre-failureClass world: 3 unclassified failures / 6 → fires.
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash', { isError: true }),
      ...toolPair('d', 'Bash'),
      ...toolPair('e', 'Bash'),
      ...toolPair('f', 'Bash'),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.detail['totalCalls']).toBe(6);
    expect(r.detail['failureCount']).toBe(3);
    expect(r.detail['failureClassBreakdown']).toEqual({ unclassified: 3 });
    expect(r.detail['excludedByClass']).toEqual({});
  });

  it('annotates evidence rows with the failure class', () => {
    resetSeq();
    const lines = [
      ...toolPair('t1', 'browser_open', { isError: true, failureClass: 'timeout' }),
      ...toolPair('t2', 'browser_open', { isError: true, failureClass: 'timeout' }),
      ...toolPair('t3', 'browser_open', { isError: true, failureClass: 'timeout' }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.evidence[0]?.annotation).toContain('class=timeout');
  });
});

// ---------------------------------------------------------------------------
// normalizeErrorHead — unit tests
// ---------------------------------------------------------------------------

describe('normalizeErrorHead — ID normalization', () => {
  it('collapses toolu_ IDs', () => {
    expect(normalizeErrorHead('tool use toolu_01AbcDef failed')).toBe(
      'tool use <id> failed',
    );
  });

  it('collapses bg- IDs', () => {
    expect(normalizeErrorHead('background job bg-abc123 timed out')).toBe(
      'background job <id> timed out',
    );
  });

  it('collapses call_ IDs', () => {
    expect(normalizeErrorHead('call_XYZ789 returned error')).toBe('<id> returned error');
  });

  it('collapses sess- IDs', () => {
    expect(normalizeErrorHead('session sess-abc timed out')).toBe('session <id> timed out');
  });

  it('two calls with different toolu_ IDs land in the same cluster', () => {
    const a = normalizeErrorHead('Error in toolu_01Abc: permission denied');
    const b = normalizeErrorHead('Error in toolu_99ZZZ: permission denied');
    expect(a).toBe(b);
  });
});

describe('normalizeErrorHead — path normalization', () => {
  it('collapses absolute Unix paths', () => {
    expect(normalizeErrorHead('File not found: /Users/alice/project/foo.ts')).toBe(
      'File not found: <path>',
    );
  });

  it('collapses /tmp paths', () => {
    expect(normalizeErrorHead('Cannot read /tmp/afk-scratch-1234')).toBe(
      'Cannot read <path>',
    );
  });

  it('two failures with different absolute paths land in the same cluster', () => {
    const a = normalizeErrorHead('ENOENT: /Users/alice/.afk/state/foo');
    const b = normalizeErrorHead('ENOENT: /Users/bob/.afk/state/bar');
    expect(a).toBe(b);
  });
});

describe('normalizeErrorHead — duration normalization', () => {
  it('collapses ms durations', () => {
    expect(normalizeErrorHead('timed out after 5000ms')).toBe('timed out after <dur>');
  });

  it('collapses s durations', () => {
    expect(normalizeErrorHead('elapsed 4.5s exceeded limit')).toBe(
      'elapsed <dur> exceeded limit',
    );
  });

  it('two timeouts with different durations land in the same cluster', () => {
    const a = normalizeErrorHead('Tool timed out after 30000ms');
    const b = normalizeErrorHead('Tool timed out after 60000ms');
    expect(a).toBe(b);
  });
});

describe('normalizeErrorHead — quoted value normalization', () => {
  it('collapses double-quoted values', () => {
    expect(normalizeErrorHead('Unknown key "some-dynamic-value" in schema')).toBe(
      'Unknown key <val> in schema',
    );
  });

  it('collapses single-quoted values', () => {
    expect(normalizeErrorHead("Cannot find module 'some/path/to/module'")).toBe(
      'Cannot find module <val>',
    );
  });

  it('two errors differing only in quoted value land in the same cluster', () => {
    const a = normalizeErrorHead('Field "userId" is required');
    const b = normalizeErrorHead('Field "sessionId" is required');
    expect(a).toBe(b);
  });
});

describe('normalizeErrorHead — digit run normalization', () => {
  it('collapses standalone digit runs ≥2 digits', () => {
    expect(normalizeErrorHead('exit code 127 from process')).toBe(
      'exit code # from process',
    );
  });

  it('single digit is left alone', () => {
    expect(normalizeErrorHead('retry attempt 3 failed')).toBe('retry attempt 3 failed');
  });

  it('two errors with different exit codes land in the same cluster', () => {
    const a = normalizeErrorHead('Process exited with code 127');
    const b = normalizeErrorHead('Process exited with code 137');
    expect(a).toBe(b);
  });
});

describe('normalizeErrorHead — combined / idempotent', () => {
  it('applies all transformations together', () => {
    const raw =
      'toolu_01Abc failed at /Users/alice/repo after 5000ms: "file missing"';
    expect(normalizeErrorHead(raw)).toBe('<id> failed at <path> after <dur>: <val>');
  });

  it('is idempotent — normalizing twice gives the same result', () => {
    const raw = 'Error in toolu_XYZ: /tmp/foo took 300ms';
    const once = normalizeErrorHead(raw);
    expect(normalizeErrorHead(once)).toBe(once);
  });

  it('empty string stays empty', () => {
    expect(normalizeErrorHead('')).toBe('');
  });

  it('whitespace-only input becomes empty string', () => {
    expect(normalizeErrorHead('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// errorClusters in card detail
// ---------------------------------------------------------------------------

describe('detectToolFailureDensity — errorClusters in detail', () => {
  it('emits errorClusters when errorHead is present on failures', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', {
        isError: true,
        errorHead: 'ENOENT: no such file or directory /Users/alice/foo.ts',
      }),
      ...toolPair('b', 'Bash', {
        isError: true,
        errorHead: 'ENOENT: no such file or directory /Users/bob/bar.ts',
      }),
      ...toolPair('c', 'Bash', {
        isError: true,
        errorHead: 'permission denied: /tmp/secret',
      }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    const clusters = r.detail['errorClusters'] as Array<{
      normalized: string;
      count: number;
      sample: string;
    }>;
    expect(Array.isArray(clusters)).toBe(true);
    // The two ENOENT errors should collapse to one cluster.
    const enoent = clusters.find((c) => c.normalized.includes('ENOENT'));
    expect(enoent).toBeDefined();
    expect(enoent!.count).toBe(2);
    // Sample must be a raw (un-normalized) errorHead.
    expect(enoent!.sample).toContain('/Users/');
  });

  it('clusters are sorted by descending count', () => {
    resetSeq();
    // 3 ENOENT failures + 1 permission-denied failure → ENOENT cluster first.
    const lines = [
      ...toolPair('a', 'Bash', { isError: true, errorHead: 'ENOENT at /Users/a/f1.ts' }),
      ...toolPair('b', 'Bash', { isError: true, errorHead: 'ENOENT at /Users/b/f2.ts' }),
      ...toolPair('c', 'Bash', { isError: true, errorHead: 'ENOENT at /Users/c/f3.ts' }),
      ...toolPair('d', 'Bash', { isError: true, errorHead: 'permission denied: /tmp/x' }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    const clusters = r.detail['errorClusters'] as Array<{ count: number }>;
    expect(clusters[0]!.count).toBeGreaterThanOrEqual(clusters[1]!.count);
  });

  it('caps clusters at MAX_ERROR_CLUSTERS', () => {
    resetSeq();
    // Produce 8 distinct cluster keys (each failure has a unique non-collapsible message).
    const lines: string[] = [];
    const distinctMessages = [
      'alpha error occurred',
      'beta error occurred',
      'gamma error occurred',
      'delta error occurred',
      'epsilon error occurred',
      'zeta error occurred',
      'eta error occurred',
      'theta error occurred',
    ];
    for (let i = 0; i < distinctMessages.length; i++) {
      lines.push(...toolPair(`f-${i}`, 'Bash', { isError: true, errorHead: distinctMessages[i] }));
    }
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    const clusters = r.detail['errorClusters'] as unknown[];
    expect(clusters.length).toBeLessThanOrEqual(MAX_ERROR_CLUSTERS);
  });

  it('emits empty errorClusters when no failures carry errorHead', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash', { isError: true }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.detail['errorClusters']).toEqual([]);
  });

  it('errorClusters each carry normalized, count, and sample fields', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', { isError: true, errorHead: 'timeout after 30000ms' }),
      ...toolPair('b', 'Bash', { isError: true, errorHead: 'timeout after 60000ms' }),
      ...toolPair('c', 'Bash', { isError: true, errorHead: 'timeout after 90000ms' }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    const clusters = r.detail['errorClusters'] as Array<{
      normalized: string;
      count: number;
      sample: string;
    }>;
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(typeof c.normalized).toBe('string');
    expect(typeof c.count).toBe('number');
    expect(typeof c.sample).toBe('string');
    // All three collapse to the same cluster.
    expect(c.count).toBe(3);
    // The normalized form should not contain raw ms numbers.
    expect(c.normalized).not.toMatch(/\d{4,}/);
    // The sample is raw — still contains the original ms value.
    expect(c.sample).toMatch(/\d+ms/);
  });

  it('failures without errorHead do not affect cluster counts', () => {
    resetSeq();
    // 2 failures with errorHead (same cluster) + 1 without.
    const lines = [
      ...toolPair('a', 'Bash', { isError: true, errorHead: 'ENOENT: /tmp/foo' }),
      ...toolPair('b', 'Bash', { isError: true, errorHead: 'ENOENT: /tmp/bar' }),
      ...toolPair('c', 'Bash', { isError: true }), // no errorHead
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    const clusters = r.detail['errorClusters'] as Array<{ count: number }>;
    // Only the 2 with errorHead cluster; the headless one is excluded.
    expect(clusters[0]!.count).toBe(2);
  });

  it('detector version is v3', () => {
    resetSeq();
    const lines = [
      ...toolPair('a', 'Bash', { isError: true }),
      ...toolPair('b', 'Bash', { isError: true }),
      ...toolPair('c', 'Bash', { isError: true }),
    ];
    const r = detectToolFailureDensity([makeSession('s1', lines)])[0]!;
    expect(r.detail['detector']).toBe('tool-failure-density@v3');
  });
});
