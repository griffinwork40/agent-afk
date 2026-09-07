/**
 * Unit tests for the interrupt picker (interrupt-picker.ts).
 *
 * Uses a `FakeCompositor` that satisfies both the `PickerHost` interface
 * (used by `runPicker`) and the `TerminalCompositor` surface that
 * `showInterruptPicker` accesses directly (`commitAbove`, `isArmed`).
 *
 * Pattern mirrors src/cli/render/picker.test.ts: FakePickerHost + pressKey.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PickerController } from '../../terminal-compositor.js';
import type { TurnState } from './repl-loop-shared.js';
import {
  showInterruptPicker,
  launchInterruptPicker,
  type InterruptChoice,
} from './interrupt-picker.js';

// ---------------------------------------------------------------------------
// FakeCompositor — minimal fake that satisfies both PickerHost and the
// TerminalCompositor slice showInterruptPicker uses (commitAbove + isArmed).
// ---------------------------------------------------------------------------
class FakeCompositor {
  // PickerHost
  enterCalls = 0;
  exitCalls = 0;
  repaintCalls = 0;
  controller: PickerController | null = null;

  // TerminalCompositor slice
  commitAboveCalls: string[] = [];

  terminalRows(): number | undefined {
    return undefined;
  }

  enterPickerMode(controller: PickerController): void {
    this.enterCalls += 1;
    this.controller = controller;
  }

  exitPickerMode(): void {
    this.exitCalls += 1;
    this.controller = null;
  }

  repaintPicker(): void {
    this.repaintCalls += 1;
  }

  commitAbove(line: string): void {
    this.commitAboveCalls.push(line);
  }

  isArmed(): boolean {
    return true;
  }

  /** Helper: simulate pressing a key through the controller. */
  pressKey(
    name: string,
    opts: { char?: string; ctrl?: boolean; shift?: boolean } = {},
  ): void {
    if (!this.controller) throw new Error('FakeCompositor: no controller installed');
    this.controller.onKey(opts.char, {
      name,
      ctrl: opts.ctrl ?? false,
      shift: opts.shift ?? false,
    });
  }

  /** Helper: read the current rendered rows. */
  renderSnapshot(): readonly string[] {
    if (!this.controller) throw new Error('FakeCompositor: no controller installed');
    return this.controller.renderRows();
  }
}

function makeTurnState(): TurnState {
  return { turnInFlight: false, lastSigintAt: 0, activeCompositor: null } as TurnState;
}

// ---------------------------------------------------------------------------
// showInterruptPicker tests
// ---------------------------------------------------------------------------

describe('showInterruptPicker', () => {
  it('returns "stop" when Stop is selected (Enter on first option)', async () => {
    const compositor = new FakeCompositor();
    const ctrl = new AbortController();
    const onStop = vi.fn();
    const onCancel = vi.fn();

    const p = showInterruptPicker({
      compositor: compositor as any,
      signal: ctrl.signal,
      onStop,
      onCancel,
    });

    // Stop is index 0 — press Enter immediately
    compositor.pressKey('return');
    const result = await p;

    expect(result).toBe('stop');
    expect(onStop).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('returns "cancel" when Cancel is selected (down once, then Enter); only onCancel fires', async () => {
    const compositor = new FakeCompositor();
    const ctrl = new AbortController();
    const onStop = vi.fn();
    const onCancel = vi.fn();

    const p = showInterruptPicker({
      compositor: compositor as any,
      signal: ctrl.signal,
      onStop,
      onCancel,
    });

    // Cancel is index 1 — press down once
    compositor.pressKey('down');
    compositor.pressKey('return');
    const result = await p;

    expect(result).toBe('cancel');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('returns "dismissed" when the signal is pre-aborted', async () => {
    const compositor = new FakeCompositor();
    const ctrl = new AbortController();
    ctrl.abort();

    const result = await showInterruptPicker({
      compositor: compositor as any,
      signal: ctrl.signal,
      onStop: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(result).toBe('dismissed');
  });

  it('returns "dismissed" when the signal is aborted while picker is open', async () => {
    const compositor = new FakeCompositor();
    const ctrl = new AbortController();

    const p = showInterruptPicker({
      compositor: compositor as any,
      signal: ctrl.signal,
      onStop: vi.fn(),
      onCancel: vi.fn(),
    });

    // Abort the signal externally (simulates turn completing while picker open)
    ctrl.abort();
    const result = await p;

    expect(result).toBe('dismissed');
  });

  it('OPTIONS order: Stop=0, Cancel=1 — visible in rendered rows', async () => {
    const compositor = new FakeCompositor();
    const ctrl = new AbortController();

    const p = showInterruptPicker({
      compositor: compositor as any,
      signal: ctrl.signal,
      onStop: vi.fn(),
      onCancel: vi.fn(),
    });

    // The picker is open — inspect rendered rows
    const rows = compositor.renderSnapshot();
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const optionRows = rows.map(stripAnsi).filter(
      r => r.includes('Stop') || r.includes('Cancel'),
    );
    expect(optionRows.length).toBe(2);
    expect(optionRows[0]).toContain('Stop');
    expect(optionRows[1]).toContain('Cancel');

    // Clean up
    ctrl.abort();
    await p;
  });
});

// ---------------------------------------------------------------------------
// launchInterruptPicker tests
// ---------------------------------------------------------------------------

describe('launchInterruptPicker', () => {
  it('clears turnState.interruptPickerAbort after "stop" is chosen', async () => {
    const compositor = new FakeCompositor();
    const turnState = makeTurnState();

    launchInterruptPicker({
      compositor: compositor as any,
      turnState,
      onStop: vi.fn(),
      onCancel: vi.fn(),
    });

    // Press Enter immediately — Stop (index 0)
    compositor.pressKey('return');

    // Wait for the .then() to execute
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(turnState.interruptPickerAbort).toBeNull();
  });

  it('clears turnState.interruptPickerAbort after "cancel" is chosen', async () => {
    const compositor = new FakeCompositor();
    const turnState = makeTurnState();

    launchInterruptPicker({
      compositor: compositor as any,
      turnState,
      onStop: vi.fn(),
      onCancel: vi.fn(),
    });

    // Press down once (Cancel = index 1) then Enter
    compositor.pressKey('down');
    compositor.pressKey('return');

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(turnState.interruptPickerAbort).toBeNull();
  });

  it('sets turnState.interruptPickerAbort to a non-null AbortController immediately', () => {
    const compositor = new FakeCompositor();
    const turnState = makeTurnState();

    launchInterruptPicker({
      compositor: compositor as any,
      turnState,
      onStop: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(turnState.interruptPickerAbort).not.toBeNull();
    expect(turnState.interruptPickerAbort).toBeInstanceOf(AbortController);

    // Clean up
    turnState.interruptPickerAbort?.abort();
  });
});
