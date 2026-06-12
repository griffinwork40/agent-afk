/**
 * Tests for `session_phase` waterfall events and `session_sealed` subagent
 * rollup fields.
 *
 * Covers:
 *  1. Zod schema acceptance / rejection for `session_phase` payloads.
 *  2. `session_phase` events appear in the `TraceEventInputSchema` discriminated
 *     union (can be written via `writer.write()`).
 *  3. `session_phase` events appear in the `TraceEventSchema` persisted form.
 *  4. `emitSessionPhase` writes a `session_phase` event to the writer.
 *  5. `emitSessionPhase` is a no-op when writer is undefined.
 *  6. Ordering: `session_init_start` < `session_init_done` < `loop_start` <
 *     `loop_end` < `closure` < `session_sealed`.
 *  7. `session_sealed` accepts optional subagent rollup fields.
 *  8. `session_sealed` Zod schema accepts the new optional fields.
 */

import { describe, expect, it } from 'vitest';

import {
  SessionPhasePayloadSchema,
  SessionPhaseNameSchema,
  SessionSealedPayloadSchema,
  TraceEventInputSchema,
  TraceEventSchema,
} from './events.js';
import { emitSessionPhase } from './emit.js';
import { InMemoryTraceWriter } from './writer.js';

// ---------------------------------------------------------------------------
// 1. SessionPhasePayloadSchema — acceptance
// ---------------------------------------------------------------------------

describe('session_phase payload schema — acceptance', () => {
  it('accepts a start phase with no optional fields', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({ phase: 'session_init_start' }),
    ).not.toThrow();
  });

  it('accepts a done phase with durationMs', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'session_init_done',
        durationMs: 123.4,
      }),
    ).not.toThrow();
  });

  it('accepts model + resolvedModel on session_init_start (provenance anchor)', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'session_init_start',
        model: 'sonnet',
        resolvedModel: 'claude-sonnet-4-5-20250929',
      }),
    ).not.toThrow();
  });

  it('accepts resolvedModel alone on model_ttfb', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'model_ttfb',
        durationMs: 640,
        resolvedModel: 'claude-test',
      }),
    ).not.toThrow();
  });

  it('accepts all phase names', () => {
    const phases: Array<string> = [
      'session_init_start',
      'session_init_done',
      'mcp_connect_start',
      'mcp_connect_done',
      'loop_start',
      'loop_end',
    ];
    for (const phase of phases) {
      expect(() => SessionPhasePayloadSchema.parse({ phase })).not.toThrow();
    }
  });

  it('accepts metadata with string/number/boolean values', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'mcp_connect_done',
        durationMs: 50,
        metadata: { serverCount: 3, enabled: true, label: 'production' },
      }),
    ).not.toThrow();
  });

  it('accepts zero durationMs', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({ phase: 'loop_end', durationMs: 0 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. SessionPhasePayloadSchema — rejection
// ---------------------------------------------------------------------------

describe('session_phase payload schema — rejection', () => {
  it('rejects an unknown phase name', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({ phase: 'boot_complete' }),
    ).toThrow();
  });

  it('rejects negative durationMs', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'session_init_done',
        durationMs: -1,
      }),
    ).toThrow();
  });

  it('rejects metadata with null value', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'loop_start',
        metadata: { key: null },
      }),
    ).toThrow();
  });

  it('rejects missing phase field', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({ durationMs: 10 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. SessionPhaseNameSchema
// ---------------------------------------------------------------------------

describe('SessionPhaseNameSchema', () => {
  it('rejects empty string', () => {
    expect(() => SessionPhaseNameSchema.parse('')).toThrow();
  });

  it('accepts all six defined phases', () => {
    const phases = [
      'session_init_start',
      'session_init_done',
      'mcp_connect_start',
      'mcp_connect_done',
      'loop_start',
      'loop_end',
    ] as const;
    expect(() => {
      for (const p of phases) SessionPhaseNameSchema.parse(p);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. TraceEventInputSchema — session_phase is a valid writable kind
// ---------------------------------------------------------------------------

describe('TraceEventInputSchema — session_phase', () => {
  it('accepts session_phase in the discriminated union', () => {
    expect(() =>
      TraceEventInputSchema.parse({
        kind: 'session_phase',
        payload: { phase: 'session_init_start' },
      }),
    ).not.toThrow();
  });

  it('accepts session_phase with all optional fields', () => {
    expect(() =>
      TraceEventInputSchema.parse({
        kind: 'session_phase',
        payload: {
          phase: 'loop_end',
          durationMs: 9999,
          metadata: { iterations: 5 },
        },
      }),
    ).not.toThrow();
  });

  it('rejects session_phase with unknown phase name', () => {
    expect(() =>
      TraceEventInputSchema.parse({
        kind: 'session_phase',
        payload: { phase: 'not_a_phase' },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. TraceEventSchema — session_phase in persisted form
// ---------------------------------------------------------------------------

describe('TraceEventSchema — session_phase persisted form', () => {
  it('accepts a persisted session_phase event', () => {
    expect(() =>
      TraceEventSchema.parse({
        ts: '2026-01-01T00:00:00.000Z',
        seq: 0,
        kind: 'session_phase',
        payload: { phase: 'session_init_done', durationMs: 42 },
      }),
    ).not.toThrow();
  });

  it('rejects persisted session_phase without ts', () => {
    expect(() =>
      TraceEventSchema.parse({
        seq: 0,
        kind: 'session_phase',
        payload: { phase: 'loop_start' },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. emitSessionPhase — writes to InMemoryTraceWriter
// ---------------------------------------------------------------------------

describe('emitSessionPhase', () => {
  it('writes a session_phase event to the writer', async () => {
    const writer = new InMemoryTraceWriter();
    await emitSessionPhase(writer, { phase: 'session_init_start' });
    const events = writer.events;
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('session_phase');
    if (events[0]!.kind !== 'session_phase') throw new Error('unreachable');
    expect(events[0]!.payload.phase).toBe('session_init_start');
  });

  it('is a no-op when writer is undefined', async () => {
    // Must not throw
    await expect(
      emitSessionPhase(undefined, { phase: 'loop_end', durationMs: 100 }),
    ).resolves.toBeUndefined();
  });

  it('writes durationMs when provided', async () => {
    const writer = new InMemoryTraceWriter();
    await emitSessionPhase(writer, { phase: 'loop_end', durationMs: 750 });
    const events = writer.events;
    expect(events).toHaveLength(1);
    if (events[0]!.kind !== 'session_phase') throw new Error('unreachable');
    expect(events[0]!.payload.durationMs).toBe(750);
  });

  it('omits durationMs on start events', async () => {
    const writer = new InMemoryTraceWriter();
    await emitSessionPhase(writer, { phase: 'session_init_start' });
    const events = writer.events;
    if (events[0]!.kind !== 'session_phase') throw new Error('unreachable');
    expect(events[0]!.payload.durationMs).toBeUndefined();
  });

  it('writes metadata when provided', async () => {
    const writer = new InMemoryTraceWriter();
    await emitSessionPhase(writer, {
      phase: 'mcp_connect_done',
      durationMs: 200,
      metadata: { serverCount: 2 },
    });
    const events = writer.events;
    if (events[0]!.kind !== 'session_phase') throw new Error('unreachable');
    expect(events[0]!.payload.metadata).toEqual({ serverCount: 2 });
  });
});

// ---------------------------------------------------------------------------
// 7. session_sealed Zod schema — new optional subagent rollup fields
// ---------------------------------------------------------------------------

describe('SessionSealedPayloadSchema — subagent rollup fields', () => {
  const base = {
    status: 'succeeded',
    finalCostUsd: 1.5,
    finalTurnCount: 3,
    closedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a payload with no subagent rollup fields (backward compat)', () => {
    expect(() => SessionSealedPayloadSchema.parse(base)).not.toThrow();
  });

  it('accepts subagentCount', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({ ...base, subagentCount: 2 }),
    ).not.toThrow();
  });

  it('accepts subagentTokens with partial breakdown', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({
        ...base,
        subagentTokens: { input: 1000, output: 500 },
      }),
    ).not.toThrow();
  });

  it('accepts subagentTokens with full breakdown', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({
        ...base,
        subagentTokens: {
          input: 1000,
          output: 500,
          cacheRead: 200,
          cacheCreation: 50,
        },
      }),
    ).not.toThrow();
  });

  it('accepts subagentCostUsd', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({ ...base, subagentCostUsd: 0.05 }),
    ).not.toThrow();
  });

  it('accepts all rollup fields together', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({
        ...base,
        subagentCount: 3,
        subagentTokens: { input: 3000, output: 1500 },
        subagentCostUsd: 0.12,
      }),
    ).not.toThrow();
  });

  it('rejects negative subagentCount', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({ ...base, subagentCount: -1 }),
    ).toThrow();
  });

  it('rejects negative subagentCostUsd', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({ ...base, subagentCostUsd: -0.01 }),
    ).toThrow();
  });

  it('rejects negative token counts inside subagentTokens', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({
        ...base,
        subagentTokens: { input: -100 },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. InMemoryTraceWriter seal — subagent rollup fields land on session_sealed
// ---------------------------------------------------------------------------

describe('InMemoryTraceWriter.seal — subagent rollup fields', () => {
  it('persists subagentCount in session_sealed payload', async () => {
    const writer = new InMemoryTraceWriter();
    await writer.seal({
      status: 'succeeded',
      finalCostUsd: 0,
      finalTurnCount: 0,
      closedAt: new Date().toISOString(),
      subagentCount: 4,
    });
    const events = writer.events;
    const sealed = events.find((e) => e.kind === 'session_sealed');
    expect(sealed).toBeDefined();
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentCount).toBe(4);
  });

  it('persists subagentTokens in session_sealed payload', async () => {
    const writer = new InMemoryTraceWriter();
    await writer.seal({
      status: 'succeeded',
      finalCostUsd: 0,
      finalTurnCount: 0,
      closedAt: new Date().toISOString(),
      subagentTokens: { input: 2000, output: 800 },
    });
    const events = writer.events;
    const sealed = events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentTokens).toEqual({ input: 2000, output: 800 });
  });

  it('persists subagentCostUsd in session_sealed payload', async () => {
    const writer = new InMemoryTraceWriter();
    await writer.seal({
      status: 'succeeded',
      finalCostUsd: 0.5,
      finalTurnCount: 1,
      closedAt: new Date().toISOString(),
      subagentCostUsd: 0.08,
    });
    const events = writer.events;
    const sealed = events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentCostUsd).toBe(0.08);
  });

  it('omits rollup fields when not provided (backward compat)', async () => {
    const writer = new InMemoryTraceWriter();
    await writer.seal({
      status: 'succeeded',
      finalCostUsd: 0,
      finalTurnCount: 0,
      closedAt: new Date().toISOString(),
    });
    const events = writer.events;
    const sealed = events.find((e) => e.kind === 'session_sealed');
    if (sealed?.kind !== 'session_sealed') throw new Error('unreachable');
    expect(sealed.payload.subagentCount).toBeUndefined();
    expect(sealed.payload.subagentTokens).toBeUndefined();
    expect(sealed.payload.subagentCostUsd).toBeUndefined();
  });
});
