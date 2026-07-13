/**
 * Tests for `improve/scan/detectors/subagent-read-denial.ts`.
 *
 * Coverage:
 *   - PreToolUse + read-family blockedTool + block → detection; other
 *     hookEvents / decisions don't.
 *   - WRITE / mutating blockedTools are NOT detected (by-design confinement).
 *   - Path normalization: denials with DIFFERENT paths but the same structural
 *     reason merge into ONE detection.
 *   - Structurally-different reasons produce separate detections.
 *   - `blockedTools` detail records the distinct read tools seen.
 *   - minOccurrences threshold + default (2).
 *   - Severity ladder (denial count + distinct sessions).
 *   - Slug deterministic + FailureCardSchema regex; fingerprint stable + path-
 *     insensitive.
 *   - DetectorResult parses against the schema; evidence capped at 8.
 */

import { describe, it, expect } from 'vitest';
import { parseTraceContent, type SessionRead } from '../reader.js';
import {
  detectSubagentReadDenial,
  computeFingerprint,
  makeSlug,
  normalizeReason,
  DEFAULT_SUBAGENT_READ_DENIAL_MIN_OCCURRENCES,
} from './subagent-read-denial.js';
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
}

function hookLine(spec: HookSpec): string {
  const payload: Record<string, unknown> = { hookEvent: spec.hookEvent };
  if (spec.decision !== undefined) payload['decision'] = spec.decision;
  if (spec.reason !== undefined) payload['reason'] = spec.reason;
  if (spec.blockedTool !== undefined) payload['blockedTool'] = spec.blockedTool;
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

/** A path-access denial reason with the given offending path. */
function denial(path: string): string {
  return `Sub-agent path access denied: ${path} is outside the session's granted read roots`;
}
const PATH_A = '/Users/x/proj/src/a.ts';
const PATH_B = '/Users/x/proj/.afk-worktrees/wt/src/b.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectSubagentReadDenial — what triggers a detection', () => {
  it('detects a PreToolUse read_file block when minOccurrences=1', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
      ]),
    ];
    const results = detectSubagentReadDenial(sessions, { minOccurrences: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.pattern).toBe('subagent-read-denial');
    expect(results[0]?.detail['blockedTools']).toEqual(['read_file']);
  });

  it('does NOT detect non-PreToolUse hook events', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'SubagentStart', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
        hookLine({ hookEvent: 'PostToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
      ]),
    ];
    expect(detectSubagentReadDenial(sessions, { minOccurrences: 1 })).toEqual([]);
  });

  it('does NOT detect WRITE / mutating blockedTools (by-design confinement)', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'write_file' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'edit_file' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'bash' }),
      ]),
    ];
    expect(detectSubagentReadDenial(sessions, { minOccurrences: 1 })).toEqual([]);
  });

  it('does NOT detect approve / undefined decisions or missing blockedTool', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'approve', reason: denial(PATH_A), blockedTool: 'read_file' }),
        hookLine({ hookEvent: 'PreToolUse', reason: denial(PATH_A), blockedTool: 'read_file' }), // decision undefined
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A) }), // no blockedTool
      ]),
    ];
    expect(detectSubagentReadDenial(sessions, { minOccurrences: 1 })).toEqual([]);
  });

  it('default threshold is 2 — single denial does not fire', () => {
    expect(DEFAULT_SUBAGENT_READ_DENIAL_MIN_OCCURRENCES).toBe(2);
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
      ]),
    ];
    expect(detectSubagentReadDenial(sessions)).toEqual([]);
  });
});

describe('detectSubagentReadDenial — path normalization + grouping', () => {
  it('merges denials with DIFFERENT paths + tools but same structural reason', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_B), blockedTool: 'grep' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial('/tmp'), blockedTool: 'glob' }),
      ]),
    ];
    const results = detectSubagentReadDenial(sessions);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['denialCount']).toBe(3);
    expect(results[0]?.detail['blockedTools']).toEqual(['glob', 'grep', 'read_file']);
    expect(results[0]?.evidence).toHaveLength(3);
  });

  it('merges across sessions and counts distinct sessions', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
      ]),
      makeSession('s2', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_B), blockedTool: 'read_file' }),
      ]),
    ];
    const results = detectSubagentReadDenial(sessions);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['denialCount']).toBe(2);
    expect(results[0]?.detail['distinctSessions']).toBe(2);
  });

  it('produces separate detections for structurally-different reasons', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_B), blockedTool: 'read_file' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: 'Blocked by policy: interpreter path guard', blockedTool: 'grep' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: 'Blocked by policy: interpreter path guard', blockedTool: 'grep' }),
      ]),
    ];
    const results = detectSubagentReadDenial(sessions);
    expect(results).toHaveLength(2);
  });
});

describe('detectSubagentReadDenial — threshold + severity', () => {
  function nDenials(n: number, session = 's1'): SessionRead {
    resetSeq();
    const lines = Array.from({ length: n }, (_, i) =>
      hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(`/p/${i}.ts`), blockedTool: 'read_file' }),
    );
    return makeSession(session, lines);
  }

  it('honors minOccurrences', () => {
    const s = nDenials(2);
    expect(detectSubagentReadDenial([s], { minOccurrences: 2 })).toHaveLength(1);
    expect(detectSubagentReadDenial([s], { minOccurrences: 3 })).toHaveLength(0);
  });

  it('rejects minOccurrences < 1', () => {
    expect(() => detectSubagentReadDenial([], { minOccurrences: 0 })).toThrow(
      /minOccurrences must be >= 1/,
    );
  });

  it('2 → low, 3 → medium, 6 → high', () => {
    expect(detectSubagentReadDenial([nDenials(2)])[0]?.severity).toBe('low');
    expect(detectSubagentReadDenial([nDenials(3)])[0]?.severity).toBe('medium');
    expect(detectSubagentReadDenial([nDenials(6)])[0]?.severity).toBe('high');
  });

  it('3 distinct sessions → high', () => {
    resetSeq();
    const mk = (id: string): SessionRead =>
      makeSession(id, [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
      ]);
    const r = detectSubagentReadDenial([mk('s1'), mk('s2'), mk('s3')], { minOccurrences: 1 })[0]!;
    expect(r.severity).toBe('high');
  });
});

describe('detectSubagentReadDenial — fingerprint, slug, schema', () => {
  it('normalizeReason collapses absolute paths (posix + ~-relative)', () => {
    expect(normalizeReason(denial(PATH_A))).toBe(normalizeReason(denial(PATH_B)));
    expect(normalizeReason('read /Users/me/.afk/state/x.diff please')).toBe('read <path> please');
    expect(normalizeReason('read ~/.afk/state/x.diff')).toBe('read <path>');
  });

  it('fingerprint is deterministic and path-insensitive', () => {
    const a = computeFingerprint({ hookEvent: 'PreToolUse', normalizedReason: normalizeReason(denial(PATH_A)) });
    const b = computeFingerprint({ hookEvent: 'PreToolUse', normalizedReason: normalizeReason(denial(PATH_B)) });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('makeSlug satisfies the FailureCardSchema slug regex', () => {
    const fp = computeFingerprint({ hookEvent: 'PreToolUse', normalizedReason: 'x' });
    expect(makeSlug(fp)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(makeSlug(fp)).toBe(`subagent-read-denial-${fp.slice(0, 12)}`);
  });

  it('produces a DetectorResult that parses against the schema', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_B), blockedTool: 'grep' }),
      ]),
    ];
    const r = detectSubagentReadDenial(sessions)[0]!;
    expect(DetectorResultSchema.safeParse(r).success).toBe(true);
  });

  it('caps evidence at 8 rows when denial count exceeds it', () => {
    resetSeq();
    const lines = Array.from({ length: 20 }, (_, i) =>
      hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(`/p/${i}.ts`), blockedTool: 'read_file' }),
    );
    const r = detectSubagentReadDenial([makeSession('s1', lines)])[0]!;
    expect(r.evidence).toHaveLength(8);
    expect(r.detail['denialCount']).toBe(20);
  });

  it('detection survives merge into a FailureCard', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_A), blockedTool: 'read_file' }),
        hookLine({ hookEvent: 'PreToolUse', decision: 'block', reason: denial(PATH_B), blockedTool: 'read_file' }),
      ]),
    ];
    const r = detectSubagentReadDenial(sessions)[0]!;
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
