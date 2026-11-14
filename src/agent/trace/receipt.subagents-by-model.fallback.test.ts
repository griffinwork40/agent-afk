/**
 * Tests for `buildSubagentsByModel` model-fallback attribution (Item 2).
 *
 * Placed in a separate file because the existing test file is 402 lines and
 * adding here would exceed the 350-code-line source ceiling if merged.
 *
 * Covers (per brief):
 *   1. Fallback with init event for toModel: outcome lands in toModel bucket.
 *   2. Second non-fallback subagent stays in its own bucket.
 *   3. Fallback with no init event for toModel: key is toModel as-is.
 *   4. started payload resolvedModel does NOT win when fallback is present.
 *   5. Malformed fallback events do not throw; subagent stays in original bucket.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildSubagentsByModel } from './receipt.subagents-by-model.js';
import type { TraceEvent } from './types.js';

// ---------------------------------------------------------------------------
// Event builders (mirrors receipt.subagents-by-model.test.ts conventions)
// ---------------------------------------------------------------------------

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0 };

let seq = 0;
function ts(): string {
  return `2026-01-01T00:00:${String(seq++).padStart(2, '0')}.000Z`;
}

function started(subagentId: string, model: string, resolvedModel?: string): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'subagent_lifecycle',
    payload: {
      transition: 'started',
      subagentId,
      parentId: 'root',
      model,
      ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    },
  };
}

function terminal(
  transition: 'succeeded' | 'failed' | 'cancelled',
  subagentId: string,
): TraceEvent {
  const base = { ts: ts(), seq: seq - 1, kind: 'subagent_lifecycle' as const };
  if (transition === 'succeeded') {
    return { ...base, payload: { transition, subagentId, durationMs: 10, turnCount: 1, outputBytes: 100 } };
  }
  if (transition === 'failed') {
    return { ...base, payload: { transition, subagentId, errorClass: 'Error', errorMessage: 'boom', partialOutputBytes: 0 } };
  }
  return { ...base, payload: { transition, subagentId, source: 'cascade' as const } };
}

function initPhase(model: string, resolvedModel: string, actor: 'main' | 'subagent' = 'subagent'): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'session_phase',
    payload: { phase: 'session_init_start', model, resolvedModel, actor },
  };
}

function fallbackPhase(subagentId: string, fromModel: string, toModel: string): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'session_phase',
    payload: {
      phase: 'subagent_model_fallback',
      metadata: { subagentId, fromModel, toModel, reason: 'model rejected' },
    },
  };
}

function closureEv(subagentId: string, finalCostUsd: number): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'closure',
    payload: { reason: 'model_end_turn', finalCostUsd, subagentId, finalTurnCount: 1, finalTokens: ZERO_TOKENS },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSubagentsByModel: model-fallback attribution', () => {
  beforeEach(() => { seq = 0; });

  // Test 1: basic fallback -- outcome and cost land in toModel bucket.
  it('attributes succeeded subagent to toModel bucket when fallback occurred', () => {
    // started X on A; init A->a-id; fallback X from A to B; init B->b-id; succeeded X; closure X cost 2
    const events: TraceEvent[] = [
      started('X', 'A'),
      initPhase('A', 'a-id'),
      fallbackPhase('X', 'A', 'B'),
      initPhase('B', 'b-id'),
      terminal('succeeded', 'X'),
      closureEv('X', 2),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    // b-id bucket must exist with correct counts.
    expect(rollup!['b-id']).toMatchObject({
      started: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      costUsd: 2,
      requested: ['A'],
    });
    // a-id bucket must NOT exist (X did not run on A).
    expect(rollup!['a-id']).toBeUndefined();
  });

  // Test 2: second non-fallback subagent Y stays in its own bucket.
  it('keeps non-fallback subagent in its own bucket alongside fallback subagent', () => {
    const events: TraceEvent[] = [
      started('X', 'A'),
      started('Y', 'A'),
      initPhase('A', 'a-id'),
      fallbackPhase('X', 'A', 'B'),
      initPhase('B', 'b-id'),
      terminal('succeeded', 'X'),
      terminal('succeeded', 'Y'),
      closureEv('X', 2),
      closureEv('Y', 1),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    // a-id holds Y only.
    expect(rollup!['a-id']).toMatchObject({
      started: 1,
      succeeded: 1,
      costUsd: 1,
      requested: ['A'],
    });
    // b-id holds X only.
    expect(rollup!['b-id']).toMatchObject({
      started: 1,
      succeeded: 1,
      costUsd: 2,
      requested: ['A'],
    });
  });

  // Test 3: fallback with no init event for toModel -- key is toModel as-is.
  it('uses toModel as-is when no init event exists for toModel', () => {
    const events: TraceEvent[] = [
      started('X', 'A'),
      fallbackPhase('X', 'A', 'B'),
      // No initPhase for B.
      terminal('succeeded', 'X'),
      closureEv('X', 1.5),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    expect(rollup!['B']).toMatchObject({
      started: 1,
      succeeded: 1,
      costUsd: 1.5,
      requested: ['A'],
    });
    expect(rollup!['A']).toBeUndefined();
  });

  // Test 4: started payload resolvedModel does NOT win when fallback present.
  it('ignores resolvedModel on started payload when fallback overrides attribution', () => {
    const events: TraceEvent[] = [
      // started carries resolvedModel: 'a-id', but fallback to B must win.
      started('X', 'A', 'a-id'),
      fallbackPhase('X', 'A', 'B'),
      initPhase('B', 'b-id'),
      terminal('succeeded', 'X'),
      closureEv('X', 3),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    // 'a-id' must NOT appear -- the fallback wins.
    expect(rollup!['a-id']).toBeUndefined();
    expect(rollup!['b-id']).toMatchObject({ started: 1, succeeded: 1, costUsd: 3 });
  });

  // Test 5: malformed fallback events -- no throw, subagent stays in original bucket.
  it('tolerates malformed fallback events without throwing', () => {
    const malformed: TraceEvent[] = [
      // No metadata field at all.
      {
        ts: ts(), seq: seq - 1, kind: 'session_phase',
        payload: { phase: 'subagent_model_fallback' },
      } as unknown as TraceEvent,
      // metadata is not an object.
      {
        ts: ts(), seq: seq - 1, kind: 'session_phase',
        payload: { phase: 'subagent_model_fallback', metadata: 'bad' },
      } as unknown as TraceEvent,
      // metadata missing toModel.
      {
        ts: ts(), seq: seq - 1, kind: 'session_phase',
        payload: { phase: 'subagent_model_fallback', metadata: { subagentId: 'X' } },
      } as unknown as TraceEvent,
      // metadata missing subagentId.
      {
        ts: ts(), seq: seq - 1, kind: 'session_phase',
        payload: { phase: 'subagent_model_fallback', metadata: { toModel: 'B' } },
      } as unknown as TraceEvent,
    ];

    const events: TraceEvent[] = [
      ...malformed,
      started('X', 'A'),
      initPhase('A', 'a-id'),
      terminal('succeeded', 'X'),
      closureEv('X', 0.5),
    ];

    expect(() => buildSubagentsByModel(events)).not.toThrow();
    const rollup = buildSubagentsByModel(events);
    // X was not matched by any valid fallback event, so it stays in a-id.
    expect(rollup!['a-id']).toMatchObject({ started: 1, succeeded: 1, costUsd: 0.5 });
    expect(rollup!['B']).toBeUndefined();
  });
});
