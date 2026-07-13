/**
 * Tests for {@link makeTracingFetch} — the observability wrapper that records
 * 429/503/529 throttling into the witness trace without altering retry behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTracingFetch } from './tracing-fetch.js';
import type { TraceWriter } from '../../trace/index.js';

function mockWriter(): {
  writer: TraceWriter;
  events: Array<{ kind: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const writer = {
    write: vi.fn(async (e: { kind: string; payload: Record<string, unknown> }) => {
      events.push(e);
    }),
  } as unknown as TraceWriter;
  return { writer, events };
}

function res(status: number, headers?: Record<string, string>): Response {
  return new Response('{}', headers ? { status, headers } : { status });
}

describe('makeTracingFetch', () => {
  it('returns the base fetch unchanged when no writer is provided', () => {
    const base = vi.fn() as unknown as typeof fetch;
    expect(makeTracingFetch(undefined, base)).toBe(base);
  });

  it('emits a rate_limit trace event on a 429 with retry-after', async () => {
    const { writer, events } = mockWriter();
    const base = vi.fn(async () => res(429, { 'retry-after': '30' })) as unknown as typeof fetch;
    const r = await makeTracingFetch(writer, base)('https://api.anthropic.com/v1/messages');
    await Promise.resolve();
    expect(r.status).toBe(429);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('session_phase');
    expect(events[0]!.payload['phase']).toBe('rate_limit');
    expect(events[0]!.payload['durationMs']).toBe(30_000);
    const md = events[0]!.payload['metadata'] as Record<string, unknown>;
    expect(md['status']).toBe(429);
    expect(md['reason']).toBe('rate-limit');
    expect(md['source']).toBe('sdk-fetch');
    expect(md['retryAfterMs']).toBe(30_000);
  });

  it('classifies 503 and 529 as reason=overloaded', async () => {
    for (const status of [503, 529]) {
      const { writer, events } = mockWriter();
      const base = vi.fn(async () => res(status)) as unknown as typeof fetch;
      await makeTracingFetch(writer, base)('u');
      await Promise.resolve();
      expect(events).toHaveLength(1);
      const md = events[0]!.payload['metadata'] as Record<string, unknown>;
      expect(md['reason']).toBe('overloaded');
      expect(md['status']).toBe(status);
    }
  });

  it('does NOT emit on a 200 response and passes it through', async () => {
    const { writer, events } = mockWriter();
    const base = vi.fn(async () => res(200)) as unknown as typeof fetch;
    const r = await makeTracingFetch(writer, base)('u');
    await Promise.resolve();
    expect(r.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it('omits durationMs when no retry-after header is present', async () => {
    const { writer, events } = mockWriter();
    const base = vi.fn(async () => res(429)) as unknown as typeof fetch;
    await makeTracingFetch(writer, base)('u');
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['durationMs']).toBeUndefined();
  });
});
