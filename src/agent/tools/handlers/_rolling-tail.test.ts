import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RollingTailBuffer,
  TAIL_MAX_LINES,
  TAIL_THROTTLE_MS,
} from './_rolling-tail.js';

describe('RollingTailBuffer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires immediately on first push', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb);
    buf.push('hello');
    // First push fires immediately (no throttle).
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('hello');
  });

  it('bounds the buffer to maxLines', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, 3, 0);
    buf.push('a\nb\nc\nd\ne\n');
    // With 0 throttle, every push fires immediately.
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1]![0] as string;
    const lines = lastCall.split('\n');
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('throttles rapid pushes', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, TAIL_MAX_LINES, TAIL_THROTTLE_MS);
    buf.push('line1\n');
    expect(cb).toHaveBeenCalledTimes(1); // immediate first fire

    buf.push('line2\n');
    buf.push('line3\n');
    // Still throttled -- no additional fires yet.
    expect(cb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TAIL_THROTTLE_MS + 10);
    // Deferred fire should have happened.
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('handles CR overwrite (progress bar pattern)', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, 5, 0);
    buf.push('Downloading\r50%\r100%');
    // CR overwrites: last CR-segment is '100%'.
    expect(buf.peek()).toBe('100%');
  });

  it('handles mixed newlines and CR', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, 5, 0);
    buf.push('first line\nsecond\roverwritten\nthird');
    const tail = buf.peek();
    expect(tail).toContain('first line');
    expect(tail).toContain('overwritten');
    expect(tail).toContain('third');
    expect(tail).not.toContain('second');
  });

  it('preserves line boundaries across chunks ending in LF', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, 5, 0);
    buf.push('one\n');
    buf.push('two\n');
    buf.push('three\n');
    expect(buf.peek()).toBe('one\ntwo\nthree');
  });

  it('does not report undefined for whitespace-only in-flight output', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, 5, 0);
    buf.push('\r');
    buf.push('   ');
    expect(cb).not.toHaveBeenCalled();

    buf.clear();
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(undefined);
  });

  it('ignores empty pushes', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb);
    buf.push('');
    expect(cb).not.toHaveBeenCalled();
  });

  it('clear() fires undefined and suppresses future pushes', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, 5, 0);
    buf.push('hello');
    cb.mockClear();

    buf.clear();
    expect(cb).toHaveBeenCalledWith(undefined);

    buf.push('ignored');
    // No additional calls after clear.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(buf.peek()).toBeUndefined();
  });

  it('peek() returns undefined for empty buffer', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb);
    expect(buf.peek()).toBeUndefined();
  });

  it('drops empty/whitespace-only lines', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, 5, 0);
    buf.push('a\n\n\nb\n   \nc');
    const tail = buf.peek()!;
    expect(tail).not.toMatch(/^\s*$/m);
    expect(tail).toContain('a');
    expect(tail).toContain('b');
    expect(tail).toContain('c');
  });

  it('cancels pending flush on clear', () => {
    const cb = vi.fn();
    const buf = new RollingTailBuffer(cb, 5, TAIL_THROTTLE_MS);
    buf.push('first');   // immediate fire
    buf.push('second');  // scheduled (throttled)
    cb.mockClear();

    buf.clear();
    vi.advanceTimersByTime(TAIL_THROTTLE_MS + 100);

    // Only the clear's undefined call, not the scheduled fire.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(undefined);
  });
});
