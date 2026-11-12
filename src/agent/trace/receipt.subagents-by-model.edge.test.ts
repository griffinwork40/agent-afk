/**
 * Edge-case tests for `buildSubagentsByModel` — gaps not covered by the
 * existing test files (`receipt.subagents-by-model.test.ts` and
 * `receipt.subagents-by-model.fallback.test.ts`).
 *
 * Covers (per issue #4786):
 *   1. Rejected `finalCostUsd` values: NaN, negative, non-numeric string.
 *      The `finitePos` guard (receipt.subagents-by-model.ts) must silently
 *      discard these without throwing; costUsd stays at 0 for the bucket.
 *   2. Two closure events for the same `subagentId` — the pattern produced by
 *      a model-fallback run where the runtime emits one closure per attempt.
 *      Behaviour on HEAD (80a005919): both costs are summed into the bucket
 *      (`costs.set(id, (costs.get(id) ?? 0) + cost)`).  This test asserts
 *      that existing behaviour so any future change is a deliberate break.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildSubagentsByModel } from './receipt.subagents-by-model.js';
import type { TraceEvent } from './types.js';

// ---------------------------------------------------------------------------
// Event builders (mirrors conventions in receipt.subagents-by-model.test.ts)
// ---------------------------------------------------------------------------

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0 };

let seq = 0;
function ts(): string {
  return `2026-01-01T00:00:${String(seq++).padStart(2, '0')}.000Z`;
}

function started(subagentId: string, model: string): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'subagent_lifecycle',
    payload: { transition: 'started', subagentId, parentId: 'root', model },
  };
}

function succeeded(subagentId: string): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'subagent_lifecycle',
    payload: { transition: 'succeeded', subagentId, durationMs: 10, turnCount: 1, outputBytes: 100 },
  };
}

function closureEv(subagentId: string, finalCostUsd: unknown): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'closure',
    payload: {
      reason: 'model_end_turn',
      finalCostUsd,
      subagentId,
      finalTurnCount: 1,
      finalTokens: ZERO_TOKENS,
    },
  } as unknown as TraceEvent;
}

// ---------------------------------------------------------------------------
// 1. Rejected finalCostUsd values (finitePos guard)
// ---------------------------------------------------------------------------

describe('buildSubagentsByModel: rejected finalCostUsd values', () => {
  beforeEach(() => { seq = 0; });

  const badValues: Array<{ label: string; value: unknown }> = [
    { label: 'NaN',             value: NaN },
    { label: 'negative number', value: -0.5 },
    { label: 'non-numeric string', value: 'free' },
    { label: 'null',            value: null },
    { label: 'undefined',       value: undefined },
    { label: 'Infinity',        value: Infinity },
    { label: '-Infinity',       value: -Infinity },
  ];

  for (const { label, value } of badValues) {
    it(`silently ignores ${label} and keeps costUsd at 0`, () => {
      const events: TraceEvent[] = [
        started('sa1', 'sonnet'),
        succeeded('sa1'),
        closureEv('sa1', value),
      ];

      expect(() => buildSubagentsByModel(events)).not.toThrow();
      const rollup = buildSubagentsByModel(events);
      expect(rollup).toBeDefined();
      // The subagent is counted in the bucket (started/succeeded) …
      expect(rollup!['sonnet']).toMatchObject({ started: 1, succeeded: 1 });
      // … but the bad cost contributes nothing to costUsd.
      expect(rollup!['sonnet']!.costUsd).toBe(0);
    });
  }

  it('still accumulates valid cost when a good closure follows a bad one', () => {
    // First closure has NaN, second has a valid cost — only the valid one counts.
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      succeeded('sa1'),
      closureEv('sa1', NaN),
      closureEv('sa1', 0.03),
    ];

    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    expect(rollup!['sonnet']!.costUsd).toBeCloseTo(0.03, 10);
  });
});

// ---------------------------------------------------------------------------
// 2. Two closures for the same subagentId
//
// On HEAD (80a005919) the costs map accumulates:
//   costs.set(id, (costs.get(id) ?? 0) + cost)
// So two valid closures for the same id sum into the bucket's costUsd.
// This test pins that behaviour so any future change is a deliberate break.
// ---------------------------------------------------------------------------

describe('buildSubagentsByModel: two closures for one subagentId', () => {
  beforeEach(() => { seq = 0; });

  it('sums both closure costs into the bucket (HEAD behaviour)', () => {
    // Model-fallback scenario: runtime emits a closure for each attempt.
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      succeeded('sa1'),
      closureEv('sa1', 0.04),  // first attempt cost
      closureEv('sa1', 0.02),  // second attempt cost (after fallback)
    ];

    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    // started is counted once (one started event).
    expect(rollup!['sonnet']).toMatchObject({ started: 1, succeeded: 1 });
    // Both closure costs are summed: 0.04 + 0.02 = 0.06.
    expect(rollup!['sonnet']!.costUsd).toBeCloseTo(0.06, 10);
  });

  it('sums costs across two subagents each with a double closure', () => {
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      started('sa2', 'sonnet'),
      succeeded('sa1'),
      succeeded('sa2'),
      closureEv('sa1', 0.01),
      closureEv('sa1', 0.01),
      closureEv('sa2', 0.02),
      closureEv('sa2', 0.02),
    ];

    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    expect(rollup!['sonnet']).toMatchObject({ started: 2, succeeded: 2 });
    // sa1: 0.02, sa2: 0.04 → total 0.06.
    expect(rollup!['sonnet']!.costUsd).toBeCloseTo(0.06, 10);
  });

  it('ignores bad cost on second closure but counts valid first closure', () => {
    const events: TraceEvent[] = [
      started('sa1', 'haiku'),
      succeeded('sa1'),
      closureEv('sa1', 0.05),
      closureEv('sa1', NaN),   // second closure is bad — discarded
    ];

    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    expect(rollup!['haiku']!.costUsd).toBeCloseTo(0.05, 10);
  });
});
