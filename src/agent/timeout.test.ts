/**
 * Tests for withTimeout helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout } from './timeout.js';
import { TimeoutError } from '../utils/errors.js';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the underlying promise value when it completes in time', async () => {
    const p = Promise.resolve(42);
    await expect(withTimeout(p, 1000)).resolves.toBe(42);
  });

  it('rejects with TimeoutError when the underlying promise is too slow', async () => {
    const slow = new Promise<number>((resolve) => {
      setTimeout(() => resolve(1), 5000);
    });
    const guarded = withTimeout(slow, 100);
    vi.advanceTimersByTime(150);
    await expect(guarded).rejects.toBeInstanceOf(TimeoutError);
  });

  it('aborts the attached controller when the timeout fires', async () => {
    const controller = new AbortController();
    const slow = new Promise<number>((resolve) => {
      setTimeout(() => resolve(1), 5000);
    });
    const guarded = withTimeout(slow, 50, { controller, label: 'test-session' });
    vi.advanceTimersByTime(100);
    await expect(guarded).rejects.toThrow(TimeoutError);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(TimeoutError);
  });

  it('does not abort the controller when the promise completes first', async () => {
    const controller = new AbortController();
    const fast = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 10);
    });
    const guarded = withTimeout(fast, 1000, { controller });
    vi.advanceTimersByTime(20);
    await expect(guarded).resolves.toBe('done');
    expect(controller.signal.aborted).toBe(false);
  });

  it('passes through errors from the underlying promise', async () => {
    const failing = Promise.reject(new Error('boom'));
    await expect(withTimeout(failing, 1000)).rejects.toThrow('boom');
  });

  it('treats timeout <= 0 as "no timeout"', async () => {
    const p = Promise.resolve(7);
    await expect(withTimeout(p, 0)).resolves.toBe(7);
    await expect(withTimeout(p, -1)).resolves.toBe(7);
  });

  it('surfaces the label in the error message', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 5000));
    const guarded = withTimeout(slow, 50, { label: 'agent-xyz' });
    vi.advanceTimersByTime(100);
    await expect(guarded).rejects.toThrow(/agent-xyz/);
  });
});
