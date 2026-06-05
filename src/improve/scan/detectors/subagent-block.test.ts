/**
 * Tests for `improve/scan/detectors/subagent-block.ts`.
 *
 * Coverage:
 *   - SubagentStart block events produce detections; other hookEvents don't.
 *   - `decision: 'approve'` and `decision: undefined` are ignored.
 *   - Blocks sharing the same `reason` merge into ONE detection bucket.
 *   - Blocks with different `reason` produce separate detections.
 *   - `minOccurrences` threshold honored.
 *   - Severity ladder (block count + distinct sessions).
 *   - Slug is deterministic and matches FailureCardSchema regex.
 *   - Fingerprint is stable across calls.
 *   - DetectorResult parses against the schema.
 *   - Evidence capped at 8 rows.
 *   - Empty reason is handled (block with no reason field).
 */

import { describe, it, expect } from 'vitest';
import { parseTraceContent, type SessionRead } from '../reader.js';
import {
  detectSubagentBlock,
  computeFingerprint,
  makeSlug,
  DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES,
} from './subagent-block.js';
import { DetectorResultSchema, FailureCardSchema } from '../../schemas.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let seqCounter = 0;
function resetSeq(): void {
  seqCounter = 0;
}

interface HookSpec {
  hookEvent:
    | 'PreToolUse'
    | 'PostToolUse'
    | 'SessionStart'
    | 'SessionEnd'
    | 'SubagentStart'
    | 'SubagentStop';
  decision?: 'block' | 'approve';
  reason?: string;
  blockedTool?: string;
  injectedContextBytes?: number;
}

function hookLine(spec: HookSpec): string {
  const payload: Record<string, unknown> = { hookEvent: spec.hookEvent };
  if (spec.decision !== undefined) payload['decision'] = spec.decision;
  if (spec.reason !== undefined) payload['reason'] = spec.reason;
  if (spec.blockedTool !== undefined) payload['blockedTool'] = spec.blockedTool;
  if (spec.injectedContextBytes !== undefined) {
    payload['injectedContextBytes'] = spec.injectedContextBytes;
  }
  return JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'hook_decision',
    payload,
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

const REASON_A = 'shadow-verify cannot dispatch verifier on own session';
const REASON_B = 'forge gate is closed';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectSubagentBlock — what triggers a detection', () => {
  it('does NOT detect when hookEvent is not SubagentStart', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'PostToolUse', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SessionStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStop', decision: 'block', reason: REASON_A }),
      ]),
    ];
    expect(detectSubagentBlock(sessions, { minOccurrences: 1 })).toEqual([]);
  });

  it('does NOT detect approve or undefined decisions', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'approve', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', reason: REASON_A }), // decision undefined
      ]),
    ];
    expect(detectSubagentBlock(sessions, { minOccurrences: 1 })).toEqual([]);
  });

  it('detects a single SubagentStart block when minOccurrences=1', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    const results = detectSubagentBlock(sessions, { minOccurrences: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.pattern).toBe('subagent-block');
    expect(results[0]?.detail['reason']).toBe(REASON_A);
  });

  it('default threshold is 2 — single block does not fire', () => {
    expect(DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES).toBe(2);
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    expect(detectSubagentBlock(sessions)).toEqual([]);
  });
});

describe('detectSubagentBlock — grouping by reason', () => {
  it('merges multiple blocks with the same reason in one session', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    const results = detectSubagentBlock(sessions);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['blockCount']).toBe(3);
    expect(results[0]?.detail['distinctSessions']).toBe(1);
    expect(results[0]?.evidence).toHaveLength(3);
  });

  it('merges blocks with the same reason across different sessions', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
      makeSession('s2', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    const results = detectSubagentBlock(sessions);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['blockCount']).toBe(2);
    expect(results[0]?.detail['distinctSessions']).toBe(2);
  });

  it('produces separate detections for distinct reasons', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_B }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_B }),
      ]),
    ];
    const results = detectSubagentBlock(sessions);
    expect(results).toHaveLength(2);
    const reasons = new Set(results.map((r) => r.detail['reason']));
    expect(reasons).toEqual(new Set([REASON_A, REASON_B]));
  });

  it('handles missing reason (block with no reason field) as empty-string reason', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block' }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block' }),
      ]),
    ];
    const results = detectSubagentBlock(sessions);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['reason']).toBe('');
  });
});

describe('detectSubagentBlock — threshold + severity', () => {
  it('honors minOccurrences', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    expect(detectSubagentBlock(sessions, { minOccurrences: 2 })).toHaveLength(1);
    expect(detectSubagentBlock(sessions, { minOccurrences: 3 })).toHaveLength(0);
  });

  it('rejects minOccurrences < 1', () => {
    expect(() => detectSubagentBlock([], { minOccurrences: 0 })).toThrow(
      /minOccurrences must be >= 1/,
    );
  });

  it('2 blocks → low', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    expect(detectSubagentBlock(sessions)[0]?.severity).toBe('low');
  });

  it('3 blocks → medium', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    expect(detectSubagentBlock(sessions)[0]?.severity).toBe('medium');
  });

  it('6+ blocks → high', () => {
    resetSeq();
    const lines = Array.from({ length: 6 }, () =>
      hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
    );
    const sessions = [makeSession('s1', lines)];
    expect(detectSubagentBlock(sessions)[0]?.severity).toBe('high');
  });

  it('3 distinct sessions → high (even with only 3 blocks)', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
      makeSession('s2', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
      makeSession('s3', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    const r = detectSubagentBlock(sessions, { minOccurrences: 1 })[0]!;
    expect(r.severity).toBe('high');
  });
});

describe('detectSubagentBlock — fingerprint + slug', () => {
  it('computeFingerprint is deterministic', () => {
    const a = computeFingerprint({
      hookEvent: 'SubagentStart',
      reason: REASON_A,
      blockedTool: undefined,
    });
    const b = computeFingerprint({
      hookEvent: 'SubagentStart',
      reason: REASON_A,
      blockedTool: undefined,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across reason values', () => {
    const a = computeFingerprint({
      hookEvent: 'SubagentStart',
      reason: REASON_A,
      blockedTool: undefined,
    });
    const b = computeFingerprint({
      hookEvent: 'SubagentStart',
      reason: REASON_B,
      blockedTool: undefined,
    });
    expect(a).not.toBe(b);
  });

  it('makeSlug satisfies the FailureCardSchema slug regex', () => {
    const fp = computeFingerprint({
      hookEvent: 'SubagentStart',
      reason: REASON_A,
      blockedTool: undefined,
    });
    expect(makeSlug(fp)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(makeSlug(fp)).toBe(`subagent-block-${fp.slice(0, 12)}`);
  });

  it('slugs are stable across detector invocations', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    const a = detectSubagentBlock(sessions)[0]?.slug;
    resetSeq();
    const sessions2 = [
      makeSession('other', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    const b = detectSubagentBlock(sessions2)[0]?.slug;
    expect(a).toBe(b);
  });
});

describe('detectSubagentBlock — schema conformance + caps', () => {
  it('produces a DetectorResult that parses against the schema', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    const r = detectSubagentBlock(sessions)[0]!;
    expect(DetectorResultSchema.safeParse(r).success).toBe(true);
  });

  it('caps evidence at 8 rows when block count exceeds it', () => {
    resetSeq();
    const lines = Array.from({ length: 20 }, () =>
      hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
    );
    const sessions = [makeSession('s1', lines)];
    const r = detectSubagentBlock(sessions)[0]!;
    expect(r.evidence).toHaveLength(8);
    expect(r.detail['blockCount']).toBe(20);
  });

  it('detection survives merge into a FailureCard', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: REASON_A }),
      ]),
    ];
    const r = detectSubagentBlock(sessions)[0]!;
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
