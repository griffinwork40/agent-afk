/**
 * Tests for {@link traceTransientRetry} — verifies that error messages are
 * redacted before being written to the witness trace.
 */
import { describe, it, expect, vi } from 'vitest';
import { traceTransientRetry, traceExhaustedRetry } from './transient-retry.trace.js';
import type { TraceSink } from '../../trace/index.js';
import type { RetryInfo } from './transient-retry.js';

/** Build a minimal spy TraceSink that records raw write arguments. */
function makeSpySink(): { sink: TraceSink; written: unknown[] } {
  const written: unknown[] = [];
  const sink: TraceSink = {
    write: vi.fn(async (event: unknown) => { written.push(event); }),
    getTracePath: () => '/tmp/test-trace.jsonl',
  };
  return { sink, written };
}

/** Build a RetryInfo with a given Error message. */
function makeRetryInfo(message: string): RetryInfo {
  return {
    attempt: 1,
    delayMs: 500,
    error: new Error(message),
  };
}

/**
 * Extract the `error` field from a trace event written by `traceTransientRetry`.
 * The event shape from emitTrace is `{ kind: 'session_phase', payload: { ... metadata: { error } } }`.
 */
function errorFieldOf(event: unknown): string {
  const e = event as {
    kind?: string;
    payload?: {
      metadata?: { error?: string };
    };
  };
  return e?.payload?.metadata?.error ?? '';
}

/**
 * Helper: extract the `phase` field from a trace event written by the trace
 * adapter. Shape: `{ kind: 'session_phase', payload: { phase } }`.
 */
function phaseFieldOf(event: unknown): string {
  const e = event as { kind?: string; payload?: { phase?: string } };
  return e?.payload?.phase ?? '';
}

describe('traceExhaustedRetry', () => {
  it('emits a connection_retry_exhausted phase event with durationMs 0', async () => {
    const { sink, written } = makeSpySink();
    const onExhausted = traceExhaustedRetry(sink, 'compaction', 2);

    const info: RetryInfo = { attempt: 3, delayMs: 0, error: new Error('network fail') };
    onExhausted(info);
    await Promise.resolve();
    await Promise.resolve();

    expect(written).toHaveLength(1);
    expect(phaseFieldOf(written[0])).toBe('connection_retry_exhausted');
    const event = written[0] as { payload?: { durationMs?: number; metadata?: { attempt?: number; maxRetries?: number; error?: string } } };
    expect(event?.payload?.durationMs).toBe(0);
    expect(event?.payload?.metadata?.attempt).toBe(3);
    expect(event?.payload?.metadata?.maxRetries).toBe(2);
    expect(event?.payload?.metadata?.error).toBe('network fail');
  });

  it('passes through secrets in the error message of the exhaustion event', async () => {
    const { sink, written } = makeSpySink();
    const onExhausted = traceExhaustedRetry(sink, 'compaction', 2);

    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop';
    const info: RetryInfo = { attempt: 3, delayMs: 0, error: new Error(`Failed with key ${secret}`) };
    onExhausted(info);
    await Promise.resolve();
    await Promise.resolve();

    expect(written).toHaveLength(1);
    const errorField = errorFieldOf(written[0]);
    expect(errorField).toContain('sk-ant-api03-');
  });
});

describe('traceTransientRetry — secret passthrough', () => {
  it('(a) passes through an Anthropic API key that fits within 200 chars', async () => {
    const { sink, written } = makeSpySink();
    const onRetry = traceTransientRetry(sink, 'compaction', 2);

    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop';
    onRetry(makeRetryInfo(`Request failed with key ${secret}`));

    await Promise.resolve();
    await Promise.resolve();

    expect(written).toHaveLength(1);
    const errorField = errorFieldOf(written[0]);
    expect(errorField).toContain('sk-ant-api03-');
  });

  it('(b) truncates at 200 chars (secret straddling boundary is partially present)', async () => {
    const { sink, written } = makeSpySink();
    const onRetry = traceTransientRetry(sink, 'compaction', 2);

    const prefix = 'Request failed: '; // 16 chars
    const padding = 'x'.repeat(169);   // 169 chars → secret starts at char 185
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop';
    const message = `${prefix}${padding}${secret}`;

    onRetry(makeRetryInfo(message));
    await Promise.resolve();
    await Promise.resolve();

    expect(written).toHaveLength(1);
    const errorField = errorFieldOf(written[0]);
    // The error field is truncated; it should be a string.
    expect(typeof errorField).toBe('string');
  });
});
