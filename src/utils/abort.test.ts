/**
 * Unit tests for abort utilities — forwardAbortSignal and
 * createRequestAbortScope.
 *
 * Uses fake timers so the timeout behaviour is exercised without real wall-clock
 * delays. All tests are fully synchronous / microtask-level after timer
 * manipulation.
 *
 * @module utils/abort.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  forwardAbortSignal,
  createRequestAbortScope,
  createDeferredRequestAbortScope,
} from './abort.js';

// ---------------------------------------------------------------------------
// forwardAbortSignal
// ---------------------------------------------------------------------------

describe('forwardAbortSignal', () => {
  it('propagates an abort that arrives after wiring', () => {
    const parent = new AbortController();
    const child = new AbortController();
    forwardAbortSignal(parent.signal, child);

    parent.abort(new Error('parent gone'));
    expect(child.signal.aborted).toBe(true);
    expect((child.signal.reason as Error).message).toBe('parent gone');
  });

  it('immediately aborts child when parent is already aborted', () => {
    const parent = new AbortController();
    parent.abort(new Error('pre-aborted'));
    const child = new AbortController();
    forwardAbortSignal(parent.signal, child);

    expect(child.signal.aborted).toBe(true);
    expect((child.signal.reason as Error).message).toBe('pre-aborted');
  });

  it('returned cleanup removes the listener so later parent abort does not propagate', () => {
    const parent = new AbortController();
    const child = new AbortController();
    const cleanup = forwardAbortSignal(parent.signal, child);

    cleanup();
    parent.abort(new Error('too late'));
    expect(child.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createRequestAbortScope
// ---------------------------------------------------------------------------

describe('createRequestAbortScope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts with timeout message when timer fires', async () => {
    const parent = new AbortController();
    const scope = createRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 5_000,
      timeoutMessage: 'web_request timeout after 5000ms',
    });

    expect(scope.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(scope.signal.aborted).toBe(true);
    expect((scope.signal.reason as Error).message).toBe('web_request timeout after 5000ms');
    scope.dispose();
  });

  it('does not abort before timeout elapses', async () => {
    const parent = new AbortController();
    const scope = createRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 5_000,
      timeoutMessage: 'web_request timeout after 5000ms',
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });

  it('propagates parent abort before timeout', async () => {
    const parent = new AbortController();
    const scope = createRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 5_000,
      timeoutMessage: 'web_request timeout after 5000ms',
    });

    parent.abort(new Error('session cancelled'));
    expect(scope.signal.aborted).toBe(true);
    expect((scope.signal.reason as Error).message).toBe('session cancelled');
    scope.dispose();
  });

  it('immediately aborts when parent signal is already aborted', () => {
    const parent = new AbortController();
    parent.abort(new Error('already done'));

    const scope = createRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 5_000,
      timeoutMessage: 'web_request timeout after 5000ms',
    });

    expect(scope.signal.aborted).toBe(true);
    expect((scope.signal.reason as Error).message).toBe('already done');
    scope.dispose();
  });

  it('dispose() clears the timer so it never fires', async () => {
    const parent = new AbortController();
    const scope = createRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 5_000,
      timeoutMessage: 'web_request timeout after 5000ms',
    });

    scope.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    // Timer was cleared — signal must still be clean (parent never aborted)
    expect(scope.signal.aborted).toBe(false);
  });

  it('dispose() removes parent listener so later parent abort does not propagate', async () => {
    const parent = new AbortController();
    const scope = createRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 5_000,
      timeoutMessage: 'web_request timeout after 5000ms',
    });

    scope.dispose();
    parent.abort(new Error('after dispose'));

    expect(scope.signal.aborted).toBe(false);
  });

  it('dispose() is idempotent — calling twice does not throw', () => {
    const parent = new AbortController();
    const scope = createRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 1_000,
      timeoutMessage: 'timeout',
    });

    expect(() => {
      scope.dispose();
      scope.dispose();
    }).not.toThrow();
  });

  it('timeout message is preserved verbatim', async () => {
    const parent = new AbortController();
    const msg = 'web_scrape timeout after 30000ms';
    const scope = createRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 30_000,
      timeoutMessage: msg,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect((scope.signal.reason as Error).message).toBe(msg);
    scope.dispose();
  });
});

// ---------------------------------------------------------------------------
// createDeferredRequestAbortScope
// ---------------------------------------------------------------------------

describe('createDeferredRequestAbortScope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not abort before armTimeout, even past timeoutMs', async () => {
    const scope = createDeferredRequestAbortScope({ timeoutMs: 1_000, timeoutMessage: 't' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });

  it('aborts timeoutMs after arming, then calls onFired with the signal already aborted', async () => {
    const scope = createDeferredRequestAbortScope({ timeoutMs: 1_000, timeoutMessage: 'approval timeout' });
    let abortedAtFire: boolean | undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    scope.armTimeout(() => {
      abortedAtFire = scope.signal.aborted;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(scope.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(scope.signal.aborted).toBe(true);
    expect(abortedAtFire).toBe(true);
    expect((scope.signal.reason as Error).message).toBe('approval timeout');
    scope.dispose();
  });

  it('armTimeout is idempotent: the first arm wins', async () => {
    const scope = createDeferredRequestAbortScope({ timeoutMs: 1_000, timeoutMessage: 't' });
    const first = vi.fn();
    const second = vi.fn();
    scope.armTimeout(first);
    await vi.advanceTimersByTimeAsync(500);
    scope.armTimeout(second);
    await vi.advanceTimersByTimeAsync(500);
    expect(scope.signal.aborted).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    scope.dispose();
  });

  it('forwards a parent abort before arming', () => {
    const parent = new AbortController();
    const scope = createDeferredRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 1_000,
      timeoutMessage: 't',
    });
    parent.abort(new Error('turn aborted'));
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it('is aborted immediately when the parent is already aborted', () => {
    const parent = new AbortController();
    parent.abort();
    const scope = createDeferredRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 1_000,
      timeoutMessage: 't',
    });
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it('dispose clears an armed timer and detaches the parent listener', async () => {
    const parent = new AbortController();
    const scope = createDeferredRequestAbortScope({
      parentSignal: parent.signal,
      timeoutMs: 1_000,
      timeoutMessage: 't',
    });
    const fired = vi.fn();
    scope.armTimeout(fired);
    scope.dispose();
    scope.dispose(); // idempotent
    await vi.advanceTimersByTimeAsync(5_000);
    parent.abort();
    expect(fired).not.toHaveBeenCalled();
    expect(scope.signal.aborted).toBe(false);
  });
});
