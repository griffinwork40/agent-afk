/**
 * Wiring tests for the Ctrl+G output-viewer callback (PR #2739 stuck-picker fix).
 *
 * Contract under test: an open viewer is aborted on any input-mode
 * transition (turn start or turn end), so the compositor's single picker slot is released
 * and a later overlay's `enterPickerMode` cannot throw on re-entry.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from '../../terminal-compositor.js';
import { __resetStdinClaimForTests } from '../../input/stdin-claim.js';
import { makeMockStdout, makeMockStdin } from '../../terminal-compositor.test-helpers.js';

const signals: AbortSignal[] = [];
vi.mock('./bash-output-viewer.js', () => ({
  runBashOutputViewer: vi.fn(async (_c: unknown, _p: unknown, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
  }),
}));

import { buildOutputViewerCallback } from './surface-setup.viewer-callback.js';

/** Let the callback's dynamic import resolve. */
async function flushImport(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  __resetStdinClaimForTests();
  signals.length = 0;
});

describe('buildOutputViewerCallback — turn-start abort wiring', () => {
  it('idle → streaming aborts the open viewer signal', async () => {
    const c = new TerminalCompositor({ stdout: makeMockStdout(), stdin: makeMockStdin(), onCancel: vi.fn() });
    await c.arm();
    c.setInputMode('idle');
    const open = buildOutputViewerCallback({ current: undefined }, () => c);
    open();
    await flushImport();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    c.setInputMode('streaming');
    expect(signals[0]!.aborted).toBe(true);
    c.disarm();
  });

  it('streaming → idle (turn end) also aborts an open viewer, so it cannot be orphaned', async () => {
    const c = new TerminalCompositor({ stdout: makeMockStdout(), stdin: makeMockStdin(), onCancel: vi.fn() });
    await c.arm();
    const open = buildOutputViewerCallback({ current: undefined }, () => c);
    open();
    await flushImport();
    c.setInputMode('idle');
    expect(signals[0]!.aborted).toBe(true);
    c.disarm();
  });

  it('reopening aborts the previous viewer and wires the hook to the new one', async () => {
    const c = new TerminalCompositor({ stdout: makeMockStdout(), stdin: makeMockStdin(), onCancel: vi.fn() });
    await c.arm();
    c.setInputMode('idle');
    const open = buildOutputViewerCallback({ current: undefined }, () => c);
    open();
    await flushImport();
    open();
    await flushImport();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    c.setInputMode('streaming');
    expect(signals[1]!.aborted).toBe(true);
    c.disarm();
  });

  it('no compositor → no-op', async () => {
    const open = buildOutputViewerCallback({ current: undefined }, () => null);
    open();
    await flushImport();
    expect(signals).toHaveLength(0);
  });
});
