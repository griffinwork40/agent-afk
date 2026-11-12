/**
 * Unit tests for `src/cli/input/reader.keypress.submit.ts`.
 *
 * Covers the two gaps identified in PR #4322 / issue #4358:
 *   1. `selectedIndex=-1` guard: Enter with an open dropdown but no candidate
 *      selected must NOT submit (applySelection returns false → no onSubmit).
 *   2. File-submit path: Enter with kind='file' and a non-directory candidate
 *      (shouldFilePickerSubmit returns true) must submit after applying.
 *
 * Strategy: handleReturnKey and handleTabKey are pure functions of their
 * arguments. We construct minimal ReaderState / RepaintCtx objects by hand
 * and inject spy implementations for the function-parameter collaborators so
 * no real TTY is needed.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleReturnKey } from './reader.keypress.submit.js';
import { InputCore } from '../input-core.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx, repaint as _repaint, schedulePaint as _schedulePaint } from './reader.repaint.js';
import type { applySelection as _applySelection } from './reader.selection.js';
import type { KeyInfo } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(buffer = '', cursor?: number) {
  return { buffer, cursor: cursor ?? buffer.length };
}

function makeState(overrides: Partial<ReaderState['ac']> = {}): ReaderState {
  return {
    input: makeInput(),
    ac: {
      dropdownOpen: false,
      candidates: [],
      selectedIndex: 0,
      viewportStart: 0,
      suppressedSignature: null,
      trigger: null,
      reset: vi.fn(),
      ...overrides,
    },
    rowsBelow: 0,
    pasting: false,
    clipboardInFlight: false,
    pasteStartBufferLen: 0,
    prevBufferRows: 0,
    prevStatusRows: 0,
    clipboardFailureMsg: null,
    attachments: [],
    maxDropdownRows: 6,
    lastKeypressAt: 0,
    repaintPending: false,
    settled: false,
    reverseSearch: {
      active: false,
      query: '',
      matchIndex: -1,
      savedBuffer: '',
    } as ReaderState['reverseSearch'],
  };
}

function makeCtx(): RepaintCtx {
  return {
    stdout: { columns: 80 } as NodeJS.WriteStream,
    promptText: '> ',
    promptVisibleLen: 2,
    slashRegistryView: { has: () => false },
    historyGetEntries: undefined,
  } as unknown as RepaintCtx;
}

function returnKey(shift = false): KeyInfo {
  return { name: 'return', shift, meta: false, ctrl: false, sequence: '\r' } as KeyInfo;
}

// ---------------------------------------------------------------------------
// selectedIndex = -1 guard (#4322)
// ---------------------------------------------------------------------------

describe('handleReturnKey — selectedIndex=-1: no candidate selected, dropdown open', () => {
  it('does NOT call onSubmit when selectedIndex is -1 and applySelection returns false', () => {
    // Simulate: slash dropdown is open but cursor is above the first candidate
    // (selectedIndex=-1 is a valid UI state for "none highlighted").
    const st = makeState({
      dropdownOpen: true,
      candidates: [{ value: '/ship' }],
      selectedIndex: -1,
      trigger: { kind: 'slash', query: 'sh' },
    });
    const ctx = makeCtx();
    const onSubmit = vi.fn();
    const repaintFn = vi.fn() as unknown as typeof _repaint;
    const schedulePaintFn = vi.fn() as unknown as typeof _schedulePaint;
    // applySelection must return false when selectedIndex is -1
    // (no real candidate to apply); we model that here.
    const applySelection = vi.fn().mockReturnValue(false) as unknown as typeof _applySelection;

    const consumed = handleReturnKey(
      returnKey(),
      '\r',
      st,
      { history: undefined } as never,
      false,
      { onSubmit },
      repaintFn,
      schedulePaintFn,
      applySelection,
      ctx,
    );

    expect(consumed).toBe(true);            // key was consumed (dropdown was open)
    expect(applySelection).toHaveBeenCalledOnce();
    // COR-2: applySelection returned false → must NOT submit.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('DOES call onSubmit when selectedIndex=0 and applySelection returns true (baseline)', () => {
    const st = makeState({
      dropdownOpen: true,
      candidates: [{ value: '/ship' }],
      selectedIndex: 0,
      trigger: { kind: 'slash', query: 'sh' },
    });
    const ctx = makeCtx();
    const onSubmit = vi.fn();
    const repaintFn = vi.fn() as unknown as typeof _repaint;
    const schedulePaintFn = vi.fn() as unknown as typeof _schedulePaint;
    const applySelection = vi.fn().mockReturnValue(true) as unknown as typeof _applySelection;

    handleReturnKey(
      returnKey(),
      '\r',
      st,
      { history: undefined } as never,
      false,
      { onSubmit },
      repaintFn,
      schedulePaintFn,
      applySelection,
      ctx,
    );

    expect(applySelection).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// File-submit path (#4322)
// ---------------------------------------------------------------------------

describe('handleReturnKey — kind=file: file pick submits, directory pick does not', () => {
  it('submits when kind=file and selected candidate is a plain file (shouldFilePickerSubmit=true)', () => {
    // A non-directory file value: no trailing '/'.
    const fileValue = '@src/main.ts';
    const st = makeState({
      dropdownOpen: true,
      candidates: [{ value: fileValue }],
      selectedIndex: 0,
      trigger: { kind: 'file', query: 'src/m' },
    });
    const ctx = makeCtx();
    const onSubmit = vi.fn();
    const repaintFn = vi.fn() as unknown as typeof _repaint;
    const schedulePaintFn = vi.fn() as unknown as typeof _schedulePaint;
    // applySelection returns true (candidate was applied).
    const applySelection = vi.fn().mockReturnValue(true) as unknown as typeof _applySelection;

    handleReturnKey(
      returnKey(),
      '\r',
      st,
      { history: undefined } as never,
      false,
      { onSubmit },
      repaintFn,
      schedulePaintFn,
      applySelection,
      ctx,
    );

    expect(applySelection).toHaveBeenCalledOnce();
    // Plain file → shouldFilePickerSubmit returns true → submit must fire.
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('does NOT submit when kind=file and selected candidate is a directory (shouldFilePickerSubmit=false)', () => {
    // Directory value ends with '/'.
    const dirValue = '@src/';
    const st = makeState({
      dropdownOpen: true,
      candidates: [{ value: dirValue }],
      selectedIndex: 0,
      trigger: { kind: 'file', query: 'src' },
    });
    const ctx = makeCtx();
    const onSubmit = vi.fn();
    const repaintFn = vi.fn() as unknown as typeof _repaint;
    const schedulePaintFn = vi.fn() as unknown as typeof _schedulePaint;
    const applySelection = vi.fn().mockReturnValue(true) as unknown as typeof _applySelection;

    handleReturnKey(
      returnKey(),
      '\r',
      st,
      { history: undefined } as never,
      false,
      { onSubmit },
      repaintFn,
      schedulePaintFn,
      applySelection,
      ctx,
    );

    expect(applySelection).toHaveBeenCalledOnce();
    // Directory → shouldFilePickerSubmit returns false → must NOT submit.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does NOT submit when kind=file and applySelection returns false (no candidate applied)', () => {
    const st = makeState({
      dropdownOpen: true,
      candidates: [],
      selectedIndex: -1,
      trigger: { kind: 'file', query: 'z' },
    });
    const ctx = makeCtx();
    const onSubmit = vi.fn();
    const repaintFn = vi.fn() as unknown as typeof _repaint;
    const schedulePaintFn = vi.fn() as unknown as typeof _schedulePaint;
    const applySelection = vi.fn().mockReturnValue(false) as unknown as typeof _applySelection;

    handleReturnKey(
      returnKey(),
      '\r',
      st,
      { history: undefined } as never,
      false,
      { onSubmit },
      repaintFn,
      schedulePaintFn,
      applySelection,
      ctx,
    );

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Plain submit (no dropdown) — baseline sanity
// ---------------------------------------------------------------------------

describe('handleReturnKey — plain submit (dropdown closed)', () => {
  it('calls onSubmit when no dropdown is open and input is non-empty', () => {
    const st = makeState({ dropdownOpen: false });
    st.input = InputCore.insert(st.input, 'hello');
    const ctx = makeCtx();
    const onSubmit = vi.fn();
    const repaintFn = vi.fn() as unknown as typeof _repaint;
    const schedulePaintFn = vi.fn() as unknown as typeof _schedulePaint;
    const applySelection = vi.fn() as unknown as typeof _applySelection;

    const consumed = handleReturnKey(
      returnKey(),
      '\r',
      st,
      { history: undefined } as never,
      false,
      { onSubmit },
      repaintFn,
      schedulePaintFn,
      applySelection,
      ctx,
    );

    expect(consumed).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
