/**
 * Integration tests: real TerminalCompositor + real bash-output-viewer.
 *
 * Regression for the PR #2739 stuck-picker blocker and its follow-up: an open
 * Ctrl+G viewer must close on any external input-mode transition, and the
 * transition must then land in the REQUESTED mode (the viewer's
 * exitPickerMode restores the saved mode; that write must not clobber the
 * new mode), preserving `inputMode === 'picker'` ⇔ `pickerController !== null`.
 *
 * The viewer is opened with no capture path, so it renders its error frame,
 * which is still a real picker (enterPickerMode + abort listener).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from '../../terminal-compositor.js';
import { __resetStdinClaimForTests } from '../../input/stdin-claim.js';
import { makeMockStdout, makeMockStdin } from '../../terminal-compositor.test-helpers.js';
import { buildOutputViewerCallback } from './surface-setup.viewer-callback.js';

/** Wait until the lazily-imported viewer has actually installed its picker. */
async function viewerOpen(c: TerminalCompositor): Promise<void> {
  await vi.waitFor(() => { expect(c.pickerController).not.toBeNull(); }, { timeout: 5000 });
}

async function armed(): Promise<TerminalCompositor> {
  const c = new TerminalCompositor({ stdout: makeMockStdout(), stdin: makeMockStdin(), onCancel: vi.fn() });
  await c.arm();
  return c;
}

const noopPicker = { renderRows: () => ['x'], onKey: () => {} };

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('output viewer × input-mode transitions (real compositor)', () => {
  it('viewer opened at idle, turn starts → lands in streaming, picker released', async () => {
    const c = await armed();
    c.setInputMode('idle');
    buildOutputViewerCallback({ current: undefined }, () => c)();
    await viewerOpen(c);
    expect(c.getInputMode()).toBe('picker');

    c.setInputMode('streaming');
    expect(c.getInputMode()).toBe('streaming');
    expect(c.pickerController).toBeNull();
    expect(() => c.enterPickerMode(noopPicker)).not.toThrow();
    c.exitPickerMode();
    c.disarm();
  });

  it('viewer opened mid-stream, turn ends → lands in idle, picker released', async () => {
    const c = await armed();
    expect(c.getInputMode()).toBe('streaming');
    buildOutputViewerCallback({ current: undefined }, () => c)();
    await viewerOpen(c);
    expect(c.getInputMode()).toBe('picker');

    c.setInputMode('idle');
    expect(c.getInputMode()).toBe('idle');
    expect(c.pickerController).toBeNull();
    c.disarm();
  });

  it('viewer orphan-free across streaming → idle → streaming', async () => {
    const c = await armed();
    buildOutputViewerCallback({ current: undefined }, () => c)();
    await viewerOpen(c);
    c.setInputMode('idle');
    c.setInputMode('streaming');
    expect(c.getInputMode()).toBe('streaming');
    expect(c.pickerController).toBeNull();
    c.disarm();
  });

  it('a non-viewer picker is untouched by the hook once the viewer has closed', async () => {
    const c = await armed();
    c.setInputMode('idle');
    buildOutputViewerCallback({ current: undefined }, () => c)();
    await viewerOpen(c);
    c.setInputMode('streaming'); // closes the viewer
    c.enterPickerMode(noopPicker); // e.g. an elicitation picker mid-turn
    c.setInputMode('idle'); // hook fires again, but targets the already-closed viewer
    // The stale hook aborts only the viewer's (already-aborted) controller.
    // The elicitation picker's controller is not exited by it.
    expect(c.pickerController).not.toBeNull();
    c.exitPickerMode();
    c.disarm();
  });
});
