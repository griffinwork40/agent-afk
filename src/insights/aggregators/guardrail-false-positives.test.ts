/**
 * Unit tests for the guardrail false-positive rate aggregator (#3849).
 *
 * Strategy: synthetic temp-dir fixtures with controlled trace JSONL + session
 * sidecars. No real AFK_HOME reads.
 *
 * @module insights/aggregators/guardrail-false-positives.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateGuardrailFalsePositives,
  zeroGuardrailFalsePositiveAggregates,
  FP_LOOKAHEAD_TOOL_CALLS,
} from './guardrail-false-positives.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-gfp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, 'state', 'witness'), { recursive: true });
  mkdirSync(join(tmpRoot, 'state', 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const NOW_ISO = new Date().toISOString();

/** Write a trace JSONL file for a given sessionId. */
function writeTrace(sessionId: string, lines: string[]): void {
  const dir = join(tmpRoot, 'state', 'witness', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trace.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

/** Write a minimal session sidecar so listSessionIds + getOrDeriveFacet can find it. */
function writeSession(sessionId: string, overrides: Record<string, unknown> = {}): void {
  const dir = join(tmpRoot, 'state', 'sessions');
  writeFileSync(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      model: 'claude-3-5-sonnet',
      startedAt: Date.now() - 1000,
      savedAt: Date.now(),
      totalTurns: 1,
      turns: [],
      ...overrides,
    }),
    'utf-8',
  );
}

function opts(days = 30) {
  return { days, afkHome: tmpRoot };
}

// ---------------------------------------------------------------------------
// JSONL line builders
// ---------------------------------------------------------------------------

function tripEvent(seq: number, subagentId?: string): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'session_phase',
    payload: {
      phase: 'hook_block_repeat_tripped',
      metadata: subagentId ? { tool: 'bash', count: 3, fork: true, subagentId } : { tool: 'bash', count: 3, fork: false },
    },
  });
}

function toolCallCompleted(
  seq: number,
  name: string,
  isError: boolean,
  subagentId?: string,
): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'tool_call',
    payload: {
      phase: 'completed',
      toolUseId: `tu-${seq}`,
      name,
      inputBytes: 10,
      resultBytes: 20,
      durationMs: 50,
      isError,
      truncated: false,
      ...(subagentId ? { subagentId } : {}),
    },
  });
}

function hookSummaryLine(
  seq: number,
  preToolUseBlocks: number,
): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'hook_summary',
    payload: {
      scope: 'root-session-including-subagents',
      counts: {
        PreToolUse: { block: preToolUseBlocks, allow: 5 },
      },
      written: preToolUseBlocks,
      suppressed: 5,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests: zero-aggregate factory
// ---------------------------------------------------------------------------

describe('zeroGuardrailFalsePositiveAggregates', () => {
  it('returns expected zero shape', () => {
    const z = zeroGuardrailFalsePositiveAggregates();
    expect(z.totalTrips).toBe(0);
    expect(z.falsePositiveTrips).toBe(0);
    expect(z.falsePositiveRate).toBeNull();
    expect(z.totalPreToolUseBlocks).toBe(0);
    expect(z.sessionsWithTrips).toBe(0);
    expect(z.sessionsScanned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: FP_LOOKAHEAD_TOOL_CALLS constant
// ---------------------------------------------------------------------------

describe('FP_LOOKAHEAD_TOOL_CALLS', () => {
  it('is a positive integer', () => {
    expect(FP_LOOKAHEAD_TOOL_CALLS).toBeGreaterThan(0);
    expect(Number.isInteger(FP_LOOKAHEAD_TOOL_CALLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: no sessions
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — no sessions', () => {
  it('returns zero-aggregate when sessions dir is empty', () => {
    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalTrips).toBe(0);
    expect(result.falsePositiveRate).toBeNull();
    expect(result.sessionsScanned).toBe(0);
  });

  it('returns zero-aggregate when session has no trace file', () => {
    writeSession('sess-no-trace');
    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.sessionsScanned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: false positive detection
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — false positive (trip + success follows)', () => {
  it('classifies trip as FP when a successful tool call follows within window', () => {
    writeSession('sess-fp');
    writeTrace('sess-fp', [
      tripEvent(1),
      toolCallCompleted(2, 'read_file', false), // success → FP
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalTrips).toBe(1);
    expect(result.falsePositiveTrips).toBe(1);
    expect(result.falsePositiveRate).toBe(1);
    expect(result.sessionsWithTrips).toBe(1);
    expect(result.sessionsScanned).toBe(1);
  });

  it('classifies trip as FP when success appears after some errors within window', () => {
    writeSession('sess-fp-delayed');
    writeTrace('sess-fp-delayed', [
      tripEvent(1),
      toolCallCompleted(2, 'bash', true),  // error — doesn't count as FP signal
      toolCallCompleted(3, 'bash', true),  // error
      toolCallCompleted(4, 'read_file', false), // success → FP
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.falsePositiveTrips).toBe(1);
    expect(result.falsePositiveRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: true positive detection
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — true positive (no success after trip)', () => {
  it('classifies trip as true positive when no successful tool call follows', () => {
    writeSession('sess-tp');
    writeTrace('sess-tp', [
      tripEvent(1),
      toolCallCompleted(2, 'bash', true), // error
      toolCallCompleted(3, 'bash', true), // error
      // session ends here without success
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalTrips).toBe(1);
    expect(result.falsePositiveTrips).toBe(0);
    expect(result.falsePositiveRate).toBe(0);
  });

  it('classifies trip as true positive when success only appears beyond lookahead window', () => {
    writeSession('sess-tp-beyond');
    const lines = [tripEvent(1)];
    // Fill up exactly FP_LOOKAHEAD_TOOL_CALLS completed calls, all errors
    for (let i = 0; i < FP_LOOKAHEAD_TOOL_CALLS; i++) {
      lines.push(toolCallCompleted(i + 2, 'bash', true));
    }
    // This success is beyond the window
    lines.push(toolCallCompleted(FP_LOOKAHEAD_TOOL_CALLS + 2, 'read_file', false));

    writeTrace('sess-tp-beyond', lines);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.falsePositiveTrips).toBe(0);
    expect(result.falsePositiveRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: multiple trips in one session
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — multiple trips', () => {
  it('counts each trip independently (mixed FP and TP)', () => {
    writeSession('sess-mixed');
    writeTrace('sess-mixed', [
      tripEvent(1),
      toolCallCompleted(2, 'read_file', false), // FP
      tripEvent(3),
      toolCallCompleted(4, 'bash', true),  // error only — TP
      // no further success within window
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalTrips).toBe(2);
    expect(result.falsePositiveTrips).toBe(1);
    expect(result.falsePositiveRate).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// Tests: actor scoping (subagentId)
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — actor scoping', () => {
  it('does not count root-session success as FP for a forked trip', () => {
    writeSession('sess-actor-scope');
    writeTrace('sess-actor-scope', [
      tripEvent(1, 'child-abc'), // trip from forked child
      toolCallCompleted(2, 'read_file', false), // root-session success — different actor
      // no child-abc success
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalTrips).toBe(1);
    expect(result.falsePositiveTrips).toBe(0); // root success doesn't count for child trip
  });

  it('counts forked-child success as FP for matching forked trip', () => {
    writeSession('sess-actor-match');
    writeTrace('sess-actor-match', [
      tripEvent(1, 'child-abc'),
      toolCallCompleted(2, 'read_file', false, 'child-abc'), // same actor → FP
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.falsePositiveTrips).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: emitter metadata shape (item 2 — end-to-end wiring)
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — emitter metadata shape', () => {
  it('trip event with subagentId in metadata is attributed to the correct actor', () => {
    writeSession('sess-emitter-shape');
    // Simulate what the REAL emitter writes: metadata includes subagentId when
    // deps.subagentId is defined (dispatcher.hook-block-repeat-gate.ts:82).
    writeTrace('sess-emitter-shape', [
      tripEvent(1, 'child-xyz'),
      toolCallCompleted(2, 'read_file', false, 'child-xyz'), // same actor → FP
      toolCallCompleted(3, 'bash', false), // root actor — different
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalTrips).toBe(1);
    expect(result.falsePositiveTrips).toBe(1); // child-xyz success counts
  });

  it('trip event WITHOUT subagentId in metadata is attributed to root actor', () => {
    writeSession('sess-emitter-root');
    // When deps.subagentId is undefined the emitter omits the field entirely —
    // the aggregator must treat this as the root actor.
    writeTrace('sess-emitter-root', [
      tripEvent(1), // no subagentId → root
      toolCallCompleted(2, 'read_file', false, 'child-abc'), // child success — wrong actor
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalTrips).toBe(1);
    expect(result.falsePositiveTrips).toBe(0); // child success doesn't count for root trip
  });
});

// ---------------------------------------------------------------------------
// Tests: hook_summary block counts
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — hook_summary', () => {
  it('accumulates PreToolUse block counts from hook_summary', () => {
    writeSession('sess-hs');
    writeTrace('sess-hs', [
      hookSummaryLine(1, 7),
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalPreToolUseBlocks).toBe(7);
  });

  it('sums block counts across multiple sessions', () => {
    writeSession('sess-hs-a');
    writeTrace('sess-hs-a', [hookSummaryLine(1, 3)]);
    writeSession('sess-hs-b');
    writeTrace('sess-hs-b', [hookSummaryLine(1, 4)]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalPreToolUseBlocks).toBe(7);
  });

  it('handles missing hook_summary gracefully (count stays at 0)', () => {
    writeSession('sess-no-hs');
    writeTrace('sess-no-hs', [tripEvent(1)]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalPreToolUseBlocks).toBe(0);
    expect(result.totalTrips).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: time window filtering
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — time window', () => {
  it('excludes sessions older than the window', () => {
    const OLD_TS = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    writeSession('sess-old', { startedAt: new Date(OLD_TS).getTime() });
    writeTrace('sess-old', [tripEvent(1)]);

    const result = aggregateGuardrailFalsePositives({ days: 30, afkHome: tmpRoot });
    expect(result.sessionsScanned).toBe(0);
    expect(result.totalTrips).toBe(0);
  });

  it('includes sessions within the window', () => {
    writeSession('sess-recent');
    writeTrace('sess-recent', [tripEvent(1)]);

    const result = aggregateGuardrailFalsePositives({ days: 30, afkHome: tmpRoot });
    expect(result.sessionsScanned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: resilience
// ---------------------------------------------------------------------------

describe('aggregateGuardrailFalsePositives — resilience', () => {
  it('skips malformed JSONL lines without throwing', () => {
    writeSession('sess-bad-json');
    writeTrace('sess-bad-json', [
      'not-json-at-all',
      tripEvent(1),
      toolCallCompleted(2, 'read_file', false),
    ]);

    expect(() => aggregateGuardrailFalsePositives(opts())).not.toThrow();
    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.totalTrips).toBe(1);
    expect(result.falsePositiveTrips).toBe(1);
  });

  it('handles a trace with no trips (sessionsScanned increments, no trip counts)', () => {
    writeSession('sess-no-trips');
    writeTrace('sess-no-trips', [
      toolCallCompleted(1, 'bash', false),
    ]);

    const result = aggregateGuardrailFalsePositives(opts());
    expect(result.sessionsScanned).toBe(1);
    expect(result.sessionsWithTrips).toBe(0);
    expect(result.totalTrips).toBe(0);
    expect(result.falsePositiveRate).toBeNull();
  });
});
