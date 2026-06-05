/**
 * Tests for src/cli/terminal-size.ts — terminal dimensions and ResizeBus.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('terminal-size', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('getTerminalWidth returns stdout.columns when positive', async () => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    const { getTerminalWidth } = await import('./terminal-size.js');
    expect(getTerminalWidth()).toBe(100);
    Object.defineProperty(process.stdout, 'columns', {
      value: prev,
      configurable: true,
    });
  });

  it('getTerminalWidth falls back to 80 when columns not positive', async () => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 0, configurable: true });
    const { getTerminalWidth } = await import('./terminal-size.js');
    expect(getTerminalWidth()).toBe(80);
    Object.defineProperty(process.stdout, 'columns', {
      value: prev,
      configurable: true,
    });
  });

  it('getTerminalHeight returns stdout.rows when positive', async () => {
    const prev = process.stdout.rows;
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    const { getTerminalHeight } = await import('./terminal-size.js');
    expect(getTerminalHeight()).toBe(40);
    Object.defineProperty(process.stdout, 'rows', {
      value: prev,
      configurable: true,
    });
  });

  it('getTerminalHeight falls back to 24 when rows not positive', async () => {
    const prev = process.stdout.rows;
    Object.defineProperty(process.stdout, 'rows', { value: 0, configurable: true });
    const { getTerminalHeight } = await import('./terminal-size.js');
    expect(getTerminalHeight()).toBe(24);
    Object.defineProperty(process.stdout, 'rows', {
      value: prev,
      configurable: true,
    });
  });

  it('ResizeBus fires subscribers after debounce on resize', async () => {
    const { ResizeBus } = await import('./terminal-size.js');
    const fn = vi.fn();
    const unsub = ResizeBus.subscribe(fn);
    process.stdout.emit('resize');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('ResizeBus coalesces rapid resize events into one debounced callback', async () => {
    const { ResizeBus } = await import('./terminal-size.js');
    const fn = vi.fn();
    const unsub = ResizeBus.subscribe(fn);
    process.stdout.emit('resize');
    process.stdout.emit('resize');
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('ResizeBus fan-out notifies all subscribers', async () => {
    const { ResizeBus } = await import('./terminal-size.js');
    const a = vi.fn();
    const b = vi.fn();
    const u1 = ResizeBus.subscribe(a);
    const u2 = ResizeBus.subscribe(b);
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it('unsubscribe detaches stdout listener when last client leaves', async () => {
    const spyOn = vi.spyOn(process.stdout, 'on');
    const spyOff = vi.spyOn(process.stdout, 'off');
    const { ResizeBus } = await import('./terminal-size.js');
    const fn = vi.fn();
    const unsub = ResizeBus.subscribe(fn);
    const resizeOnCalls = spyOn.mock.calls.filter((c) => c[0] === 'resize');
    expect(resizeOnCalls.length).toBe(1);
    unsub();
    const resizeOffCalls = spyOff.mock.calls.filter((c) => c[0] === 'resize');
    expect(resizeOffCalls.length).toBeGreaterThanOrEqual(1);
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);
    expect(fn).not.toHaveBeenCalled();
    spyOn.mockRestore();
    spyOff.mockRestore();
  });

  it('second subscribe does not register a second resize listener', async () => {
    const spyOn = vi.spyOn(process.stdout, 'on');
    const { ResizeBus } = await import('./terminal-size.js');
    const u1 = ResizeBus.subscribe(() => {});
    const u2 = ResizeBus.subscribe(() => {});
    const resizeOnCalls = spyOn.mock.calls.filter((c) => c[0] === 'resize');
    expect(resizeOnCalls.length).toBe(1);
    u1();
    u2();
    spyOn.mockRestore();
  });

  // ----------------------------------------------------------------------------
  // Immediate (synchronous, non-debounced) resize subscribers.
  //
  // These exist to invalidate state that MUST be reset before any debounced
  // repaint can observe stale coordinates against new dimensions. See
  // CupFrameRenderer.resetGeometry docs for the motivating ghost-rows bug.
  // ----------------------------------------------------------------------------

  it('subscribeImmediate fires synchronously on resize (no debounce wait)', async () => {
    const { ResizeBus } = await import('./terminal-size.js');
    const fn = vi.fn();
    const unsub = ResizeBus.subscribeImmediate(fn);
    process.stdout.emit('resize');
    // No timer advance — must have already fired inside the resize handler.
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('subscribeImmediate fires BEFORE the debounced subscribe', async () => {
    const { ResizeBus } = await import('./terminal-size.js');
    const order: string[] = [];
    const debouncedUnsub = ResizeBus.subscribe(() => order.push('debounced'));
    const immediateUnsub = ResizeBus.subscribeImmediate(() => order.push('immediate'));

    process.stdout.emit('resize');
    // Immediate fires synchronously, debounced still pending.
    expect(order).toEqual(['immediate']);

    vi.advanceTimersByTime(150);
    // Debounced fires AFTER immediate.
    expect(order).toEqual(['immediate', 'debounced']);

    debouncedUnsub();
    immediateUnsub();
  });

  it('subscribeImmediate fires on every resize event (no coalescing)', async () => {
    const { ResizeBus } = await import('./terminal-size.js');
    const fn = vi.fn();
    const unsub = ResizeBus.subscribeImmediate(fn);
    process.stdout.emit('resize');
    process.stdout.emit('resize');
    process.stdout.emit('resize');
    // Immediate channel is NOT coalesced — each SIGWINCH fires the handler.
    // This contrasts with the debounced channel which collapses bursts.
    expect(fn).toHaveBeenCalledTimes(3);
    unsub();
  });

  it('subscribeImmediate fan-out notifies all immediate subscribers', async () => {
    const { ResizeBus } = await import('./terminal-size.js');
    const a = vi.fn();
    const b = vi.fn();
    const u1 = ResizeBus.subscribeImmediate(a);
    const u2 = ResizeBus.subscribeImmediate(b);
    process.stdout.emit('resize');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it('subscribeImmediate handler error does not break the bus', async () => {
    const { ResizeBus } = await import('./terminal-size.js');
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const u1 = ResizeBus.subscribeImmediate(bad);
    const u2 = ResizeBus.subscribeImmediate(good);
    process.stdout.emit('resize');
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it('subscribeImmediate unsubscribe detaches stdout listener when last client (across both channels) leaves', async () => {
    const spyOn = vi.spyOn(process.stdout, 'on');
    const spyOff = vi.spyOn(process.stdout, 'off');
    const { ResizeBus } = await import('./terminal-size.js');
    const fn = vi.fn();
    const unsub = ResizeBus.subscribeImmediate(fn);
    const onCalls = spyOn.mock.calls.filter((c) => c[0] === 'resize');
    expect(onCalls.length).toBe(1);
    unsub();
    const offCalls = spyOff.mock.calls.filter((c) => c[0] === 'resize');
    expect(offCalls.length).toBeGreaterThanOrEqual(1);
    process.stdout.emit('resize');
    expect(fn).not.toHaveBeenCalled();
    spyOn.mockRestore();
    spyOff.mockRestore();
  });

  it('mixed immediate + debounced subscribers share a single stdout listener', async () => {
    const spyOn = vi.spyOn(process.stdout, 'on');
    const { ResizeBus } = await import('./terminal-size.js');
    const u1 = ResizeBus.subscribe(() => {});
    const u2 = ResizeBus.subscribeImmediate(() => {});
    const onCalls = spyOn.mock.calls.filter((c) => c[0] === 'resize');
    expect(onCalls.length).toBe(1);
    u1();
    u2();
    spyOn.mockRestore();
  });

  it('detach is gated by both channels — debounced alive keeps listener attached when immediate leaves', async () => {
    const spyOff = vi.spyOn(process.stdout, 'off');
    const { ResizeBus } = await import('./terminal-size.js');
    const debouncedUnsub = ResizeBus.subscribe(() => {});
    const immediateUnsub = ResizeBus.subscribeImmediate(() => {});

    immediateUnsub();
    // Debounced still alive → listener must remain attached.
    let offCalls = spyOff.mock.calls.filter((c) => c[0] === 'resize');
    expect(offCalls.length).toBe(0);

    debouncedUnsub();
    // Last subscriber gone → listener detaches.
    offCalls = spyOff.mock.calls.filter((c) => c[0] === 'resize');
    expect(offCalls.length).toBeGreaterThanOrEqual(1);

    spyOff.mockRestore();
  });
});
