/**
 * Tests for the startup-latency `session_phase` markers added on top of the
 * base session_phase scaffold: `bootstrap_*`, `mcp_server_*`, and the
 * singleton `model_ttfb`.
 *
 * Covers:
 *  1. The new `SessionPhaseName` values validate via Zod (enum + payload).
 *  2. `metadata` carrying diagnostic context (server name, status, counts)
 *     validates, and non-(string|number|boolean) metadata is rejected.
 *  3. The new phases round-trip through `TraceEventInputSchema` and
 *     `TraceEventSchema`.
 *  4. `emitSessionPhase` writes each new phase to a writer, and is a no-op
 *     when the writer is undefined.
 *  5. `model_ttfb` is a valid singleton (a `*_done`-style event with
 *     `durationMs` and no paired `*_start`).
 */

import { describe, expect, it } from 'vitest';

import {
  SessionPhaseNameSchema,
  SessionPhasePayloadSchema,
  TraceEventInputSchema,
  TraceEventSchema,
} from './events.js';
import { emitSessionPhase } from './emit.js';
import { InMemoryTraceWriter } from './writer.js';

// The phases this follow-up PR introduces (i.e. NOT in the base scaffold).
const NEW_PHASES = [
  'bootstrap_start',
  'bootstrap_done',
  'mcp_server_start',
  'mcp_server_done',
  'model_ttfb',
] as const;

// ---------------------------------------------------------------------------
// 1. Enum + payload acceptance for the new phases
// ---------------------------------------------------------------------------

describe('startup phases — enum acceptance', () => {
  for (const phase of NEW_PHASES) {
    it(`SessionPhaseNameSchema accepts "${phase}"`, () => {
      expect(() => SessionPhaseNameSchema.parse(phase)).not.toThrow();
    });

    it(`SessionPhasePayloadSchema accepts a "${phase}" payload`, () => {
      expect(() => SessionPhasePayloadSchema.parse({ phase })).not.toThrow();
    });
  }

  it('still rejects an unknown phase name', () => {
    expect(() => SessionPhaseNameSchema.parse('worktree_setup_start')).toThrow();
    expect(() =>
      SessionPhasePayloadSchema.parse({ phase: 'not_a_phase' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. metadata validation
// ---------------------------------------------------------------------------

describe('startup phases — metadata', () => {
  it('accepts mcp_server_done with server/status/toolCount metadata', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'mcp_server_done',
        durationMs: 2870,
        metadata: { server: 'github', status: 'connected', toolCount: 12 },
      }),
    ).not.toThrow();
  });

  it('accepts mcp_connect_done with a numeric serverCount', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'mcp_connect_done',
        durationMs: 31000,
        metadata: { serverCount: 3 },
      }),
    ).not.toThrow();
  });

  it('accepts boolean metadata values', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'mcp_server_done',
        metadata: { server: 'jira', degraded: true },
      }),
    ).not.toThrow();
  });

  it('rejects metadata values that are not string|number|boolean', () => {
    expect(() =>
      SessionPhasePayloadSchema.parse({
        phase: 'mcp_server_done',
        metadata: { server: { nested: 'object' } },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Whole-event union round-trip
// ---------------------------------------------------------------------------

describe('startup phases — event union round-trip', () => {
  it('TraceEventInputSchema accepts a session_phase input for each new phase', () => {
    for (const phase of NEW_PHASES) {
      expect(() =>
        TraceEventInputSchema.parse({ kind: 'session_phase', payload: { phase } }),
      ).not.toThrow();
    }
  });

  it('TraceEventSchema accepts a persisted session_phase for each new phase', () => {
    for (const phase of NEW_PHASES) {
      expect(() =>
        TraceEventSchema.parse({
          ts: new Date().toISOString(),
          seq: 0,
          kind: 'session_phase',
          payload: { phase, durationMs: 5 },
        }),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. emitSessionPhase writes the new phases
// ---------------------------------------------------------------------------

describe('startup phases — emitSessionPhase', () => {
  it('writes a bootstrap_done event with durationMs and metadata', async () => {
    const writer = new InMemoryTraceWriter();
    await emitSessionPhase(writer, {
      phase: 'bootstrap_done',
      durationMs: 1234,
    });
    expect(writer.events).toHaveLength(1);
    const ev = writer.events[0]!;
    expect(ev.kind).toBe('session_phase');
    expect(ev.payload).toMatchObject({ phase: 'bootstrap_done', durationMs: 1234 });
  });

  it('writes mcp_server start/done as an ordered pair', async () => {
    const writer = new InMemoryTraceWriter();
    await emitSessionPhase(writer, {
      phase: 'mcp_server_start',
      metadata: { server: 'github' },
    });
    await emitSessionPhase(writer, {
      phase: 'mcp_server_done',
      durationMs: 42,
      metadata: { server: 'github', status: 'connected', toolCount: 7 },
    });
    expect(writer.events.map((e) => (e.payload as { phase: string }).phase)).toEqual([
      'mcp_server_start',
      'mcp_server_done',
    ]);
    // seq is monotonic and writer-owned.
    expect(writer.events[0]!.seq).toBe(0);
    expect(writer.events[1]!.seq).toBe(1);
  });

  it('writes model_ttfb as a singleton with durationMs', async () => {
    const writer = new InMemoryTraceWriter();
    await emitSessionPhase(writer, { phase: 'model_ttfb', durationMs: 640 });
    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]!.payload).toMatchObject({
      phase: 'model_ttfb',
      durationMs: 640,
    });
  });

  it('is a no-op when the writer is undefined (no throw)', async () => {
    await expect(
      emitSessionPhase(undefined, { phase: 'bootstrap_start' }),
    ).resolves.toBeUndefined();
  });
});
