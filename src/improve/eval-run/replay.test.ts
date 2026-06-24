/**
 * Tests for `improve/eval-run/replay.ts` — the fixture-replay validation layer.
 *
 * The load-bearing property under test: eval-run FAILS when the recorded
 * failure still reproduces (the live guardrail does not neutralise it) and
 * PASSES only when it is neutralised. Demonstrated three ways:
 *
 *   - against the REAL `SessionToolDispatcher` circuit breaker (→ neutralised);
 *   - against an injected no-breaker driver simulating the pre-fix world
 *     (→ still reproduces → fail);
 *   - against a fixture that no longer encodes the pattern (→ fail-closed).
 *
 * Also guards the committed fixture against trace-schema drift, and exercises
 * the real driver end-to-end so a regression in the production breaker is
 * caught here too.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  liveCircuitBreakerDriver,
  REPLAY_CHECK_CLOSURE_GUIDED,
  REPLAY_CHECK_CLOSURE_REPRODUCES,
  REPLAY_CHECK_NEUTRALIZED,
  REPLAY_CHECK_PREFIX,
  REPLAY_CHECK_REPRODUCES,
  replaySupportedPatterns,
  resolveReplayHandler,
  type LoopDriver,
} from './replay.js';
import { detectRepeatedToolUse } from '../scan/detectors/repeated-tool-use.js';
import { detectClosureAnomaly } from '../scan/detectors/closure-anomaly.js';
import { parseTraceContent } from '../scan/reader.js';
import type { EvalCase, EvalCheck } from '../schemas.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMMITTED_FIXTURE = resolve(
  __dirname,
  '__fixtures__/repeated-tool-use-loop.fixture.jsonl',
);

function committedBytes(): Buffer {
  return readFileSync(COMMITTED_FIXTURE);
}

/** Generate a byte-identical repeated-tool-use loop of `n` (started, completed) pairs. */
function loopContent(n: number, toolName = 'get_runtime_state'): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `tu-${i + 1}`;
    lines.push(
      JSON.stringify({
        ts: '2026-06-20T10:00:00.000Z',
        seq: i * 2,
        kind: 'tool_call',
        payload: { phase: 'started', toolUseId: id, name: toolName, inputBytes: 120 },
      }),
    );
    lines.push(
      JSON.stringify({
        ts: '2026-06-20T10:00:00.050Z',
        seq: i * 2 + 1,
        kind: 'tool_call',
        payload: {
          phase: 'completed',
          toolUseId: id,
          name: toolName,
          resultBytes: 512,
          isError: false,
          truncated: false,
          durationMs: 50,
        },
      }),
    );
  }
  return lines.join('\n') + '\n';
}

function makeReplayEvalCase(fingerprint: string | null = null): EvalCase {
  return {
    schemaVersion: 1,
    evalCaseId: 'repeated-tool-get-runtime-state-abc123-eval-20260620-0a1b2c',
    cardSlug: 'repeated-tool-get-runtime-state-abc123',
    proposalId: null,
    title: 'Replay [pattern-absent]: get_runtime_state repeated',
    createdAt: '2026-06-20T11:00:00.000Z',
    kind: 'replay',
    replay: {
      sourceSessionId: 'sess-loop',
      sourceTracePath: 'state/witness/sess-loop/trace.jsonl',
      fixturePath: 'agent-framework/improve/eval-cases/x.fixture.jsonl',
      evidenceRowIndex: 0,
      evidenceEventIndices: [15],
      sliceLineRange: { startLine: 1, endLine: 16 },
      sliceLineCount: 16,
      sliceSha256: 'a'.repeat(64),
    },
    assertion: {
      kind: 'pattern-absent',
      patternId: 'repeated-tool-use',
      detectorVersion: 'repeated-tool-use@v1',
      rationale: 'test',
    },
    provenance: {
      detectorAtGeneration: 'repeated-tool-use@v1',
      fingerprintAtGeneration: fingerprint,
      cardOccurrenceCountAtGeneration: 1,
      cardLastSeenAtGeneration: '2026-06-20T11:00:00.000Z',
      generatedBy: 'replay-fixture',
    },
    status: 'draft',
    notes: [],
  };
}

function check(checks: EvalCheck[], name: string): EvalCheck | undefined {
  return checks.find((c) => c.name === name);
}

const handler = resolveReplayHandler('repeated-tool-use');

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('replay registry', () => {
  it('registers a handler for repeated-tool-use', () => {
    expect(handler).toBeDefined();
    expect(replaySupportedPatterns()).toContain('repeated-tool-use');
  });

  it('registers a handler for closure-anomaly', () => {
    expect(resolveReplayHandler('closure-anomaly')).toBeDefined();
    expect(replaySupportedPatterns()).toContain('closure-anomaly');
  });
});

// ---------------------------------------------------------------------------
// Committed fixture integrity (schema-drift guard)
// ---------------------------------------------------------------------------

describe('committed fixture', () => {
  it('parses cleanly under the live trace schema and reproduces an 8× loop', () => {
    const session = parseTraceContent({
      sessionId: 'sess-loop',
      tracePath: 'state/witness/sess-loop/trace.jsonl',
      relativeTracePath: 'state/witness/sess-loop/trace.jsonl',
      content: committedBytes().toString('utf8'),
      sessionMtimeMs: 0,
    });
    // No invalid lines → the committed JSONL still matches TraceEventSchema.
    expect(session.invalidLineCount).toBe(0);

    const findings = detectRepeatedToolUse([session], { minRepeats: 4 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail['toolName']).toBe('get_runtime_state');
    expect(findings[0]!.detail['runLength']).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// The core regression behaviour
// ---------------------------------------------------------------------------

describe('replayRepeatedToolUse', () => {
  it('PASSES against the real guardrail (recorded loop neutralised)', async () => {
    const probe = await handler!.run(makeReplayEvalCase(), committedBytes(), {});

    const reproduces = check(probe.checks, REPLAY_CHECK_REPRODUCES);
    const neutralized = check(probe.checks, REPLAY_CHECK_NEUTRALIZED);
    expect(reproduces?.status).toBe('pass');
    expect(neutralized?.status).toBe('pass');
    // Real breaker (threshold 8) trips at call 8 of the recorded ×8 loop.
    expect(neutralized?.actual).toContain('tripped at call 8');
  });

  it('FAILS when the guardrail is absent (fixture still reproduces)', async () => {
    // Simulate the pre-fix world: a driver whose breaker never trips.
    const noBreaker: LoopDriver = async (_tool, count) => ({
      trippedAtCall: null,
      callsDriven: count,
    });
    const probe = await handler!.run(makeReplayEvalCase(), committedBytes(), {
      driveLoop: noBreaker,
    });

    // The fixture still encodes the pattern — that check passes …
    expect(check(probe.checks, REPLAY_CHECK_REPRODUCES)?.status).toBe('pass');
    // … but the loop is NOT neutralised, so the gate flips to fail.
    const neutralized = check(probe.checks, REPLAY_CHECK_NEUTRALIZED);
    expect(neutralized?.status).toBe('fail');
    expect(neutralized?.actual).toContain('no trip');
  });

  it('skips (does not fail) when the fixture no longer reproduces the pattern', async () => {
    // 3 repeats < detector threshold (4) → no finding. The bytes are intact
    // (integrity is checked upstream), so this is an eval-case quality gap,
    // not a code regression: skip rather than fail.
    const bytes = Buffer.from(loopContent(3), 'utf8');
    const probe = await handler!.run(makeReplayEvalCase(), bytes, {});

    const reproduces = check(probe.checks, REPLAY_CHECK_REPRODUCES);
    expect(reproduces?.status).toBe('skipped');
    // No neutralisation check is emitted — there is no loop to drive.
    expect(check(probe.checks, REPLAY_CHECK_NEUTRALIZED)).toBeUndefined();
    expect(probe.checks).toHaveLength(1);
  });

  it('bounds the drive to the breaker threshold even for a long recorded loop', async () => {
    const seen: Array<{ tool: string; count: number }> = [];
    const capturing: LoopDriver = async (tool, count) => {
      seen.push({ tool, count });
      return { trippedAtCall: count, callsDriven: count };
    };
    // Recorded loop of 12 — drive must be capped at the threshold (8).
    const bytes = Buffer.from(loopContent(12), 'utf8');
    await handler!.run(makeReplayEvalCase(), bytes, { driveLoop: capturing });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ tool: 'get_runtime_state', count: 8 });
  });

  it('every replay check carries the replay: prefix', async () => {
    const probe = await handler!.run(makeReplayEvalCase(), committedBytes(), {});
    expect(probe.checks.length).toBeGreaterThan(0);
    for (const c of probe.checks) {
      expect(c.name.startsWith(REPLAY_CHECK_PREFIX)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The real driver, end-to-end (production circuit breaker)
// ---------------------------------------------------------------------------

describe('liveCircuitBreakerDriver', () => {
  it('trips the real breaker at the threshold for a normal tool', async () => {
    const result = await liveCircuitBreakerDriver('get_runtime_state', 8);
    expect(result.trippedAtCall).toBe(8);
  });

  it('does not trip below the threshold', async () => {
    const result = await liveCircuitBreakerDriver('get_runtime_state', 5);
    expect(result.trippedAtCall).toBeNull();
    expect(result.callsDriven).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// closure-anomaly fixture-replay
// ---------------------------------------------------------------------------

const COMMITTED_CLOSURE_FIXTURE = resolve(
  __dirname,
  '__fixtures__/closure-anomaly-abort.fixture.jsonl',
);

function committedClosureBytes(): Buffer {
  return readFileSync(COMMITTED_CLOSURE_FIXTURE);
}

/** Build a minimal valid trace prefix ending in a `closure` event with `reason`. */
function closureContent(reason: string, seq = 2): string {
  const lines = [
    JSON.stringify({
      ts: '2026-06-20T10:00:00.000Z',
      seq: 0,
      kind: 'tool_call',
      payload: { phase: 'started', toolUseId: 'tu-1', name: 'bash', inputBytes: 80 },
    }),
    JSON.stringify({
      ts: '2026-06-20T10:00:00.050Z',
      seq: 1,
      kind: 'tool_call',
      payload: {
        phase: 'completed',
        toolUseId: 'tu-1',
        name: 'bash',
        resultBytes: 256,
        isError: false,
        truncated: false,
        durationMs: 50,
      },
    }),
    JSON.stringify({
      ts: '2026-06-20T10:00:01.000Z',
      seq,
      kind: 'closure',
      payload: { reason, finalTurnCount: 3, finalCostUsd: 0.0123, finalTokens: { input: 1200, output: 340 } },
    }),
  ];
  return lines.join('\n') + '\n';
}

function makeClosureEvalCase(evidenceSeq = 2): EvalCase {
  return {
    schemaVersion: 1,
    evalCaseId: 'closure-anomaly-abort-eval-20260620-0a1b2c',
    cardSlug: 'closure-anomaly-abort',
    proposalId: null,
    title: 'Replay [pattern-absent]: abort closure',
    createdAt: '2026-06-20T11:00:00.000Z',
    kind: 'replay',
    replay: {
      sourceSessionId: 'sess-abort',
      sourceTracePath: 'state/witness/sess-abort/trace.jsonl',
      fixturePath: 'agent-framework/improve/eval-cases/x.fixture.jsonl',
      evidenceRowIndex: 0,
      evidenceEventIndices: [evidenceSeq],
      sliceLineRange: { startLine: 1, endLine: evidenceSeq + 1 },
      sliceLineCount: evidenceSeq + 1,
      sliceSha256: 'a'.repeat(64),
    },
    assertion: {
      kind: 'pattern-absent',
      patternId: 'closure-anomaly',
      detectorVersion: 'closure-anomaly@v1',
      rationale: 'test',
    },
    provenance: {
      detectorAtGeneration: 'closure-anomaly@v1',
      // closure-anomaly has no fingerprint — the handler must select by seq.
      fingerprintAtGeneration: null,
      cardOccurrenceCountAtGeneration: 1,
      cardLastSeenAtGeneration: '2026-06-20T11:00:00.000Z',
      generatedBy: 'replay-fixture',
    },
    status: 'draft',
    notes: [],
  };
}

const closureHandler = resolveReplayHandler('closure-anomaly');

describe('committed closure fixture', () => {
  it('parses cleanly under the live trace schema and reproduces an abort closure', () => {
    const session = parseTraceContent({
      sessionId: 'sess-abort',
      tracePath: 'state/witness/sess-abort/trace.jsonl',
      relativeTracePath: 'state/witness/sess-abort/trace.jsonl',
      content: committedClosureBytes().toString('utf8'),
      sessionMtimeMs: 0,
    });
    // No invalid lines → the committed JSONL still matches TraceEventSchema.
    expect(session.invalidLineCount).toBe(0);

    const findings = detectClosureAnomaly([session], { minOccurrences: 1 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail['closureReason']).toBe('abort');
    expect(findings[0]!.detail['seqs']).toEqual([2]);
  });
});

describe('replayClosureAnomaly', () => {
  it('PASSES against the real guardrail (abort closure now carries recovery guidance)', async () => {
    const probe = await closureHandler!.run(makeClosureEvalCase(), committedClosureBytes(), {});

    const reproduces = check(probe.checks, REPLAY_CHECK_CLOSURE_REPRODUCES);
    const guided = check(probe.checks, REPLAY_CHECK_CLOSURE_GUIDED);
    expect(reproduces?.status).toBe('pass');
    expect(guided?.status).toBe('pass');
    expect(reproduces?.actual).toContain("closure.reason='abort'");
  });

  it('FAILS when the guidance is stripped (pre-fix world — hint dropped)', async () => {
    // Simulate the pre-fix world: a builder that returns no guidance for abort.
    const probe = await closureHandler!.run(makeClosureEvalCase(), committedClosureBytes(), {
      buildGuidance: () => null,
    });

    // The fixture still encodes the anomalous closure — that check passes …
    expect(check(probe.checks, REPLAY_CHECK_CLOSURE_REPRODUCES)?.status).toBe('pass');
    // … but no guidance is produced, so the gate flips to fail.
    const guided = check(probe.checks, REPLAY_CHECK_CLOSURE_GUIDED);
    expect(guided?.status).toBe('fail');
    expect(guided?.actual).toContain('no guidance');
  });

  it('FAILS closed for an anomalous reason the guardrail does not cover yet', async () => {
    // `timeout` is anomalous (reproduces) but buildClosureGuidance returns null
    // for it today → not neutralised → fail-closed (real guardrail, no inject).
    const bytes = Buffer.from(closureContent('timeout'), 'utf8');
    const probe = await closureHandler!.run(makeClosureEvalCase(), bytes, {});

    expect(check(probe.checks, REPLAY_CHECK_CLOSURE_REPRODUCES)?.status).toBe('pass');
    expect(check(probe.checks, REPLAY_CHECK_CLOSURE_GUIDED)?.status).toBe('fail');
  });

  it('skips (does not fail) when the fixture no longer reproduces an anomalous closure', async () => {
    // A benign `model_end_turn` close is not anomalous → no finding. The bytes
    // are intact (integrity is checked upstream), so this is an eval-case
    // quality gap, not a code regression: skip rather than fail.
    const bytes = Buffer.from(closureContent('model_end_turn'), 'utf8');
    const probe = await closureHandler!.run(makeClosureEvalCase(), bytes, {});

    const reproduces = check(probe.checks, REPLAY_CHECK_CLOSURE_REPRODUCES);
    expect(reproduces?.status).toBe('skipped');
    // No guided check is emitted — there is no closure to re-drive.
    expect(check(probe.checks, REPLAY_CHECK_CLOSURE_GUIDED)).toBeUndefined();
    expect(probe.checks).toHaveLength(1);
  });

  it('every replay check carries the replay: prefix', async () => {
    const probe = await closureHandler!.run(makeClosureEvalCase(), committedClosureBytes(), {});
    expect(probe.checks.length).toBeGreaterThan(0);
    for (const c of probe.checks) {
      expect(c.name.startsWith(REPLAY_CHECK_PREFIX)).toBe(true);
    }
  });
});
