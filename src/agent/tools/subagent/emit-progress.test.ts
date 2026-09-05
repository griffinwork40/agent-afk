/**
 * Unit tests for emit-progress.ts: ring buffer, message truncation,
 * formatProgressEvent, handler behavior, and cancel/abort guards.
 *
 * Tests cover the pure functions (formatProgressEvent, truncateToBytes via
 * handler) and the createEmitProgressHandler factory in isolation, using
 * a minimal SubagentHandleImpl double.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatProgressEvent,
  createEmitProgressHandler,
  PROGRESS_RING_CAPACITY,
  PROGRESS_MAX_MESSAGE_BYTES,
  type ProgressEventPayload,
} from './emit-progress.js';
import type { SubagentHandleImpl } from '../../subagent/handle.js';

// ---------------------------------------------------------------------------
// Minimal handle double that implements only the fields emit-progress uses.
// ---------------------------------------------------------------------------

function makeHandleDouble(status: 'running' | 'succeeded' | 'failed' | 'cancelled' = 'running') {
  const _progressEvents: ProgressEventPayload[] = [];
  const handle = {
    id: 'test-handle-001',
    _currentStatus: status,
    _progressEvents,
    emitProgress(payload: ProgressEventPayload): void {
      if (
        this._currentStatus === 'succeeded' ||
        this._currentStatus === 'failed' ||
        this._currentStatus === 'cancelled'
      ) {
        return;
      }
      const CAPACITY = PROGRESS_RING_CAPACITY;
      if (this._progressEvents.length >= CAPACITY) {
        this._progressEvents.shift();
      }
      this._progressEvents.push(payload);
    },
  } as unknown as SubagentHandleImpl<unknown>;
  return handle;
}

// ---------------------------------------------------------------------------
// formatProgressEvent
// ---------------------------------------------------------------------------

describe('formatProgressEvent', () => {
  it('produces the expected XML envelope shape', () => {
    const payload: ProgressEventPayload = { message: 'hello world' };
    const result = formatProgressEvent(payload, 'agent-123');
    expect(result).toMatch(/^<child-progress subagentId="agent-123" timestamp="\d{4}/);
    expect(result).toContain('hello world');
    expect(result).toMatch(/<\/child-progress>$/);
  });

  it('includes the phase attribute when provided', () => {
    const payload: ProgressEventPayload = { message: 'step done', phase: 'research' };
    const result = formatProgressEvent(payload, 'ag-x');
    expect(result).toContain('phase="research"');
  });

  it('omits the phase attribute when not provided', () => {
    const payload: ProgressEventPayload = { message: 'step done' };
    const result = formatProgressEvent(payload, 'ag-x');
    expect(result).not.toContain('phase=');
  });

  it('escapes double-quotes in the subagentId attribute', () => {
    const result = formatProgressEvent({ message: 'x' }, 'id"with"quotes');
    expect(result).toContain('subagentId="id&quot;with&quot;quotes"');
  });

  it('escapes ampersands in the phase attribute', () => {
    const payload: ProgressEventPayload = { message: 'x', phase: 'a&b' };
    const result = formatProgressEvent(payload, 'id');
    expect(result).toContain('phase="a&amp;b"');
  });

  it('includes an ISO timestamp', () => {
    const result = formatProgressEvent({ message: 'x' }, 'id');
    const match = result.match(/timestamp="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(() => new Date(match![1])).not.toThrow();
    expect(isNaN(new Date(match![1]).getTime())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ring buffer eviction (via emitProgress on the handle double)
// ---------------------------------------------------------------------------

describe('ring buffer', () => {
  it('holds up to PROGRESS_RING_CAPACITY events', () => {
    const handle = makeHandleDouble();
    for (let i = 0; i < PROGRESS_RING_CAPACITY; i++) {
      handle.emitProgress({ message: `event-${i}` });
    }
    expect((handle as unknown as { _progressEvents: ProgressEventPayload[] })._progressEvents).toHaveLength(
      PROGRESS_RING_CAPACITY,
    );
  });

  it('evicts the oldest entry when capacity is exceeded', () => {
    const handle = makeHandleDouble();
    const OVER = PROGRESS_RING_CAPACITY + 5;
    for (let i = 0; i < OVER; i++) {
      handle.emitProgress({ message: `event-${i}` });
    }
    const buf = (handle as unknown as { _progressEvents: ProgressEventPayload[] })._progressEvents;
    expect(buf).toHaveLength(PROGRESS_RING_CAPACITY);
    // Oldest entry should now be event-5 (0-4 were evicted).
    expect(buf[0].message).toBe(`event-${OVER - PROGRESS_RING_CAPACITY}`);
    // Latest entry should be the last one pushed.
    expect(buf[buf.length - 1].message).toBe(`event-${OVER - 1}`);
  });

  it('does not push to the buffer when the handle is in a terminal state', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      const handle = makeHandleDouble(status);
      handle.emitProgress({ message: 'ignored' });
      const buf = (handle as unknown as { _progressEvents: ProgressEventPayload[] })._progressEvents;
      expect(buf).toHaveLength(0);
    }
  });

  it('clears correctly when length is set to 0', () => {
    const handle = makeHandleDouble();
    handle.emitProgress({ message: 'a' });
    handle.emitProgress({ message: 'b' });
    const buf = (handle as unknown as { _progressEvents: ProgressEventPayload[] })._progressEvents;
    expect(buf).toHaveLength(2);
    buf.length = 0;
    expect(buf).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createEmitProgressHandler
// ---------------------------------------------------------------------------

describe('createEmitProgressHandler', () => {
  let handle: ReturnType<typeof makeHandleDouble>;
  let queueCalls: string[];
  let queueFn: (text: string) => void;
  let abortController: AbortController;

  beforeEach(() => {
    handle = makeHandleDouble();
    queueCalls = [];
    queueFn = (text) => queueCalls.push(text);
    abortController = new AbortController();
  });

  it('returns { delivered: true } on success', async () => {
    const handler = createEmitProgressHandler(handle, queueFn, abortController.signal);
    const result = await handler({ message: 'hello' }, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content as string)).toEqual({ delivered: true });
  });

  it('calls the queue function once with the formatted envelope', async () => {
    const handler = createEmitProgressHandler(handle, queueFn, abortController.signal);
    await handler({ message: 'progress update', phase: 'planning' }, new AbortController().signal);
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]).toContain('<child-progress');
    expect(queueCalls[0]).toContain('progress update');
    expect(queueCalls[0]).toContain('phase="planning"');
    expect(queueCalls[0]).toContain('</child-progress>');
  });

  it('pushes the payload to the ring buffer', async () => {
    const handler = createEmitProgressHandler(handle, queueFn, abortController.signal);
    await handler({ message: 'hello' }, new AbortController().signal);
    const buf = (handle as unknown as { _progressEvents: ProgressEventPayload[] })._progressEvents;
    expect(buf).toHaveLength(1);
    expect(buf[0].message).toBe('hello');
  });

  it('returns { delivered: false } when parent abort signal is already fired', async () => {
    abortController.abort();
    const handler = createEmitProgressHandler(handle, queueFn, abortController.signal);
    const result = await handler({ message: 'too late' }, new AbortController().signal);
    expect(JSON.parse(result.content as string)).toMatchObject({ delivered: false });
    expect(queueCalls).toHaveLength(0);
  });

  it('returns an error for missing message', async () => {
    const handler = createEmitProgressHandler(handle, queueFn, undefined);
    const result = await handler({ phase: 'research' }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('"message"');
  });

  it('returns an error for empty message', async () => {
    const handler = createEmitProgressHandler(handle, queueFn, undefined);
    const result = await handler({ message: '   ' }, new AbortController().signal);
    expect(result.isError).toBe(true);
  });

  it('returns an error for non-object input', async () => {
    const handler = createEmitProgressHandler(handle, queueFn, undefined);
    const result = await handler('not an object', new AbortController().signal);
    expect(result.isError).toBe(true);
  });

  it('truncates message at PROGRESS_MAX_MESSAGE_BYTES bytes', async () => {
    // Build a message that is slightly over the cap.
    const longMessage = 'x'.repeat(PROGRESS_MAX_MESSAGE_BYTES + 100);
    const handler = createEmitProgressHandler(handle, queueFn, undefined);
    await handler({ message: longMessage }, new AbortController().signal);
    const buf = (handle as unknown as { _progressEvents: ProgressEventPayload[] })._progressEvents;
    expect(buf).toHaveLength(1);
    const storedBytes = Buffer.byteLength(buf[0].message, 'utf8');
    expect(storedBytes).toBeLessThanOrEqual(PROGRESS_MAX_MESSAGE_BYTES);
  });

  it('does not truncate a message within the byte cap', async () => {
    const exact = 'a'.repeat(PROGRESS_MAX_MESSAGE_BYTES);
    const handler = createEmitProgressHandler(handle, queueFn, undefined);
    await handler({ message: exact }, new AbortController().signal);
    const buf = (handle as unknown as { _progressEvents: ProgressEventPayload[] })._progressEvents;
    expect(buf[0].message).toBe(exact);
  });

  it('passes metadata through to the ring buffer payload', async () => {
    const handler = createEmitProgressHandler(handle, queueFn, undefined);
    await handler({ message: 'x', metadata: { count: 42, done: true } }, new AbortController().signal);
    const buf = (handle as unknown as { _progressEvents: ProgressEventPayload[] })._progressEvents;
    expect(buf[0].metadata).toEqual({ count: 42, done: true });
  });

  it('does not call the queue function when parent abort fires between calls', async () => {
    const handler = createEmitProgressHandler(handle, queueFn, abortController.signal);
    // First call succeeds.
    await handler({ message: 'first' }, new AbortController().signal);
    expect(queueCalls).toHaveLength(1);
    // Now abort the parent.
    abortController.abort();
    // Second call should be suppressed.
    await handler({ message: 'second' }, new AbortController().signal);
    expect(queueCalls).toHaveLength(1);
  });
});
