/**
 * Behavioral tests for the Ctrl+X chord in terminal-compositor.input-dispatch.ts.
 *
 * Covers:
 *   1. Ctrl+X D fires onCycleDiffCap in idle mode
 *   2. Ctrl+X then Escape does NOT fire onCycleDiffCap; chord is cleared; Escape
 *      still processes normally (soft-stop / idle-escape path)
 *   3. Ctrl+X then Ctrl+X re-arms cleanly (second Ctrl+X is a new leader)
 *   4. After resetState, pendingChordKey is undefined even if it was set before reset
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchKey } from './terminal-compositor.input-dispatch.js';
import { resetState } from './terminal-compositor.reset.js';
import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';
import type { ResetStateHost } from './terminal-compositor.reset.js';

// ---------------------------------------------------------------------------
// Minimal stub factory
// ---------------------------------------------------------------------------

function makeHost(
  overrides: Partial<KeyDispatchHost> = {},
): KeyDispatchHost {
  return {
    armed: true,
    input: { buffer: '', cursor: 0 } as never,
    queued: false,
    pendingSubmissions: [],
    inputMode: 'idle' as never,
    pickerController: null,
    pasting: false,
    pasteStartBufferLen: 0,
    pasteStartCursor: 0,
    pasteRegistry: new Map(),
    clipboardInFlight: false,
    clipboardFailureMsg: null,
    attachments: [],
    softStopped: false,
    lastIdleEscAt: 0,
    postEscCoalesce: false,
    postEscPayload: null,
    canceled: false,
    backgrounded: false,
    paused: false,
    cprPending: false,
    pendingChordKey: undefined,
    modeNotice: null,
    activeGhost: null,
    repaint: vi.fn(),
    scheduleRepaint: vi.fn(),
    clearScreen: vi.fn(),
    applyEdit: vi.fn(() => true),
    updateAutocomplete: vi.fn(),
    updateGhost: vi.fn(),
    dismissPromptGhost: vi.fn(() => false),
    applyDropdownSelection: vi.fn(() => false),
    applyGhostAccept: vi.fn(() => false),
    applyGhostWordAccept: vi.fn(() => false),
    ...overrides,
  } as unknown as KeyDispatchHost;
}

function ctrlX(): { name: string; ctrl: boolean; sequence: string } {
  return { name: 'x', ctrl: true, sequence: '\x18' };
}

function keyD(): { name: string; ctrl: boolean; meta: boolean; sequence: string } {
  return { name: 'd', ctrl: false, meta: false, sequence: 'd' };
}

function keyEscape(): { name: string; ctrl: boolean; sequence: string } {
  return { name: 'escape', ctrl: false, sequence: '\x1b' };
}

// ---------------------------------------------------------------------------
// 1. Ctrl+X D fires onCycleDiffCap in idle mode
// ---------------------------------------------------------------------------

describe('Chord: Ctrl+X D fires onCycleDiffCap', () => {
  it('calls onCycleDiffCap when Ctrl+X is followed by D in idle mode', () => {
    const onCycleDiffCap = vi.fn();
    const host = makeHost({ onCycleDiffCap });

    // Press Ctrl+X — arms the chord
    dispatchKey(host, '\x18', ctrlX() as never);
    expect(host.pendingChordKey).toBe('x');
    expect(onCycleDiffCap).not.toHaveBeenCalled();

    // Press D — fires the callback
    dispatchKey(host, 'd', keyD() as never);
    expect(onCycleDiffCap).toHaveBeenCalledOnce();
    expect(host.pendingChordKey).toBeUndefined();
  });

  it('does not fire onCycleDiffCap without a prior Ctrl+X', () => {
    const onCycleDiffCap = vi.fn();
    const host = makeHost({ onCycleDiffCap });

    dispatchKey(host, 'd', keyD() as never);
    expect(onCycleDiffCap).not.toHaveBeenCalled();
  });

  it('does not fire onCycleDiffCap in streaming mode', () => {
    const onCycleDiffCap = vi.fn();
    const host = makeHost({ onCycleDiffCap, inputMode: 'streaming' as never });

    dispatchKey(host, '\x18', ctrlX() as never);
    dispatchKey(host, 'd', keyD() as never);
    expect(onCycleDiffCap).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Ctrl+X then Escape — chord cancelled, Escape processes normally
// ---------------------------------------------------------------------------

describe('Chord: Ctrl+X then Escape cancels chord', () => {
  it('clears pendingChordKey when Escape follows Ctrl+X', () => {
    const onCycleDiffCap = vi.fn();
    const onIdleEscape = vi.fn();
    const host = makeHost({ onCycleDiffCap, onIdleEscape });

    // Arm the chord
    dispatchKey(host, '\x18', ctrlX() as never);
    expect(host.pendingChordKey).toBe('x');

    // Escape should cancel chord and NOT fire onCycleDiffCap
    dispatchKey(host, '\x1b', keyEscape() as never);
    expect(onCycleDiffCap).not.toHaveBeenCalled();
    expect(host.pendingChordKey).toBeUndefined();
  });

  it('Escape still fires onIdleEscape after chord cancellation', () => {
    const onIdleEscape = vi.fn();
    const host = makeHost({ onIdleEscape });

    // Arm the chord then press Escape
    dispatchKey(host, '\x18', ctrlX() as never);
    dispatchKey(host, '\x1b', keyEscape() as never);

    // onIdleEscape should have been called — Escape processed normally
    expect(onIdleEscape).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 3. Ctrl+X then Ctrl+X — re-arms cleanly
// ---------------------------------------------------------------------------

describe('Chord: Ctrl+X twice re-arms cleanly', () => {
  it('second Ctrl+X re-arms the chord without double-activation', () => {
    const onCycleDiffCap = vi.fn();
    const host = makeHost({ onCycleDiffCap });

    // First Ctrl+X — arms
    dispatchKey(host, '\x18', ctrlX() as never);
    expect(host.pendingChordKey).toBe('x');

    // Second Ctrl+X — re-arms (Ctrl+X is a chord completion for itself per
    // the cancellation guard: `key?.ctrl && key?.name === 'x'` passes through
    // to handleChordCtrlX which re-sets pendingChordKey = 'x')
    dispatchKey(host, '\x18', ctrlX() as never);
    expect(host.pendingChordKey).toBe('x');
    expect(onCycleDiffCap).not.toHaveBeenCalled();

    // Now D should fire
    dispatchKey(host, 'd', keyD() as never);
    expect(onCycleDiffCap).toHaveBeenCalledOnce();
    expect(host.pendingChordKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. resetState clears pendingChordKey
// ---------------------------------------------------------------------------

describe('resetState clears pendingChordKey', () => {
  it('pendingChordKey is undefined after resetState even if set', () => {
    // Build a minimal ResetStateHost with pendingChordKey set
    const mockAutocompleteState = { reset: vi.fn() };
    const host: ResetStateHost = {
      pendingChordKey: 'x',
      overlay: 'some overlay',
      input: { buffer: 'hello', cursor: 5 } as never,
      queued: true,
      pendingSubmissions: [{ text: 'msg', displayText: 'msg', attachments: [] }] as never,
      queuedReservations: new Set(),
      canceled: true,
      backgrounded: true,
      softStopped: true,
      postEscCoalesce: true,
      postEscPayload: null,
      paused: true,
      pendingTrailingRepaint: true,
      burstActive: true,
      activeGhost: 'suggestion',
      anchorRow: 10,
      hasCommitted: true,
      placementMode: 'bottom-pinned' as never,
      commitInFlight: true,
      pendingContentRows: 5,
      pendingResizeErase: null,
      bandGeometryStale: true,
      resizeGeometryStale: true,
      lastKnownRows: 24,
      lastKnownCols: 80,
      cprPending: true,
      pickerController: null,
      inputMode: 'idle' as never,
      attachments: [],
      pasting: false,
      pasteStartBufferLen: 0,
      pasteStartCursor: 0,
      pasteRegistry: new Map(),
      clipboardFailureMsg: null,
      modeNotice: null,
      autocompleteState: mockAutocompleteState as never,
      resizeUnsub: null,
      resizeImmediateUnsub: null,
      disarmRows: 0,
      disarmCols: 0,
      suspendCommitQueue: [],
      suspendObserver: null,
      clearCommittedBand: vi.fn(),
    };

    // Confirm it's set before reset
    expect(host.pendingChordKey).toBe('x');

    resetState(host);

    // Must be cleared after reset
    expect(host.pendingChordKey).toBeUndefined();
  });

  it('pendingChordKey stays undefined if already undefined after resetState', () => {
    const host: ResetStateHost = {
      pendingChordKey: undefined,
      overlay: '',
      input: { buffer: '', cursor: 0 } as never,
      queued: false,
      pendingSubmissions: [],
      queuedReservations: new Set(),
      canceled: false,
      backgrounded: false,
      softStopped: false,
      postEscCoalesce: false,
      postEscPayload: null,
      paused: false,
      pendingTrailingRepaint: false,
      burstActive: false,
      activeGhost: null,
      anchorRow: undefined,
      hasCommitted: false,
      placementMode: 'cursor-follow' as never,
      commitInFlight: false,
      pendingContentRows: null,
      pendingResizeErase: null,
      bandGeometryStale: false,
      resizeGeometryStale: false,
      lastKnownRows: 0,
      lastKnownCols: 0,
      cprPending: false,
      pickerController: null,
      inputMode: 'streaming' as never,
      attachments: [],
      pasting: false,
      pasteStartBufferLen: 0,
      pasteStartCursor: 0,
      pasteRegistry: new Map(),
      clipboardFailureMsg: null,
      modeNotice: null,
      autocompleteState: undefined,
      resizeUnsub: null,
      resizeImmediateUnsub: null,
      disarmRows: 0,
      disarmCols: 0,
      suspendCommitQueue: [],
      suspendObserver: null,
      clearCommittedBand: vi.fn(),
    };

    resetState(host);
    expect(host.pendingChordKey).toBeUndefined();
  });
});
