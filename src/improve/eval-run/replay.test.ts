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
  REPLAY_CHECK_NEUTRALIZED,
  REPLAY_CHECK_PREFIX,
  REPLAY_CHECK_REPRODUCES,
  replaySupportedPatterns,
  resolveReplayHandler,
  type LoopDriver,
} from './replay.js';
import { detectRepeatedToolUse } from '../scan/detectors/repeated-tool-use.js';
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
