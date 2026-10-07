/**
 * Unit tests for ResizeGhostRow — the shared pre-resize ghost-row tracker.
 *
 * Tests cover the subscribe/snapshot/consume/unsubscribe lifecycle and the
 * invariants documented in resize-ghost-row.ts:
 *
 *   RGR-1  subscribe() registers a ResizeBus.subscribeImmediate handler.
 *   RGR-2  The handler snapshots getLastPaintedRow() into preResizePaintedRow.
 *   RGR-3  consumeGhostRow() returns and clears the snapshot (idempotent).
 *   RGR-4  unsubscribe() calls the returned unsub function and nulls snapshot.
 *   RGR-5  subscribe() is idempotent (second call is a no-op).
 *   RGR-6  consumeGhostRow() returns null when no snapshot is pending.
 *   RGR-7  consumeGhostRow() after unsubscribe() returns null.
 *   RGR-8  Snapshot reflects lastPaintedRow at SIGWINCH time, not at
 *          subscribe time (getter is called when the event fires).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResizeGhostRow } from './resize-ghost-row.js';
import { ResizeBus } from './terminal-size.js';

describe('ResizeGhostRow', () => {
  let immCb: (() => void) | null;
  let immUnsub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    immCb = null;
    immUnsub = vi.fn();
    vi.spyOn(ResizeBus, 'subscribeImmediate').mockImplementation((fn: () => void) => {
      immCb = fn;
      return immUnsub;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('RGR-1: subscribe() registers a ResizeBus.subscribeImmediate handler', () => {
    let row: number | null = null;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    expect(ResizeBus.subscribeImmediate).toHaveBeenCalledOnce();
    expect(immCb).toBeTypeOf('function');
  });

  it('RGR-2: the immediate handler snapshots the current lastPaintedRow', () => {
    let row: number | null = 20;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    expect(immCb).not.toBeNull();
    // Simulate SIGWINCH immediate channel firing with row = 20.
    immCb!();
    expect(tracker.consumeGhostRow()).toBe(20);
  });

  it('RGR-3: consumeGhostRow() clears the snapshot — second call returns null', () => {
    let row: number | null = 15;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    immCb!();
    // First call returns the snapshot.
    expect(tracker.consumeGhostRow()).toBe(15);
    // Second call returns null (snapshot was cleared).
    expect(tracker.consumeGhostRow()).toBeNull();
  });

  it('RGR-4: unsubscribe() calls the ResizeBus unsub function', () => {
    let row: number | null = 10;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    tracker.unsubscribe();
    expect(immUnsub).toHaveBeenCalledOnce();
  });

  it('RGR-4: unsubscribe() nulls any pending snapshot', () => {
    let row: number | null = 18;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    immCb!(); // snapshot row 18
    tracker.unsubscribe();
    // Snapshot must be cleared so a stale ghost erase cannot fire post-stop.
    expect(tracker.consumeGhostRow()).toBeNull();
  });

  it('RGR-5: subscribe() is idempotent — second call does not register a second handler', () => {
    let row: number | null = 5;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    tracker.subscribe();
    expect(ResizeBus.subscribeImmediate).toHaveBeenCalledOnce();
  });

  it('RGR-6: consumeGhostRow() returns null when no snapshot is pending', () => {
    let row: number | null = null;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    // No immediate event fired yet → no snapshot.
    expect(tracker.consumeGhostRow()).toBeNull();
  });

  it('RGR-7: consumeGhostRow() returns null after unsubscribe clears the snapshot', () => {
    let row: number | null = 22;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    immCb!(); // snapshot row 22
    tracker.unsubscribe();
    expect(tracker.consumeGhostRow()).toBeNull();
  });

  it('RGR-8: snapshot reflects lastPaintedRow at SIGWINCH time, not subscribe time', () => {
    let row: number | null = null;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    // Simulate painting row 10 AFTER subscribe (common: bar paints on start).
    row = 10;
    // Now simulate SIGWINCH: immediate handler fires with current row = 10.
    immCb!();
    expect(tracker.consumeGhostRow()).toBe(10);
  });

  it('RGR-8: snapshot reflects the row at the LAST immediate-event time (not an earlier paint)', () => {
    let row: number | null = null;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();

    // First resize: paint at 20, then SIGWINCH.
    row = 20;
    immCb!();
    // Consume to clear it.
    expect(tracker.consumeGhostRow()).toBe(20);

    // Paint at 30 (new geometry after first resize).
    row = 30;
    // Second resize: immediate fires.
    immCb!();
    expect(tracker.consumeGhostRow()).toBe(30);
  });

  it('returns null when lastPaintedRow is null at snapshot time (no prior paint)', () => {
    let row: number | null = null;
    const tracker = new ResizeGhostRow(() => row);
    tracker.subscribe();
    // SIGWINCH before any paint: getter returns null → snapshot is null.
    immCb!();
    expect(tracker.consumeGhostRow()).toBeNull();
  });
});
