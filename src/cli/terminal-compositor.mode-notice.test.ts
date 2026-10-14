/**
 * Transient Shift+Tab mode notice: lives in the live frame, is replaced by the
 * next Shift+Tab, cleared by any other keystroke, and never commits to
 * scrollback (the stacking `✓ ● plan mode ON` lines it replaces).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { gatherChromeRows } from './terminal-compositor.frame.layout.js';
import { clearModeNoticeOnKey, setModeNotice } from './terminal-compositor.mode-notice.js';
import { SpinnerController } from './input/spinner.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';

const strip = (s: string): string => s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('mode-notice helpers', () => {
  it('setModeNotice refuses (returns false, no mutation) when disarmed', () => {
    const host = { armed: false, modeNotice: null as string | null, repaint: vi.fn() };
    expect(setModeNotice(host, 'x')).toBe(false);
    expect(host.modeNotice).toBeNull();
    expect(host.repaint).not.toHaveBeenCalled();
  });

  it('setModeNotice replaces the notice and repaints when armed', () => {
    const host = { armed: true, modeNotice: 'old' as string | null, repaint: vi.fn() };
    expect(setModeNotice(host, 'new')).toBe(true);
    expect(host.modeNotice).toBe('new');
    expect(host.repaint).toHaveBeenCalledTimes(1);
  });

  it('clearModeNoticeOnKey keeps the notice for Shift+Tab, clears it otherwise', () => {
    const host = { modeNotice: 'n' as string | null, scheduleRepaint: vi.fn() };
    clearModeNoticeOnKey(host, { name: 'tab', shift: true });
    expect(host.modeNotice).toBe('n');
    clearModeNoticeOnKey(host, { name: 'tab' });
    expect(host.modeNotice).toBeNull();
    expect(host.scheduleRepaint).toHaveBeenCalledTimes(1);
    // No-op (no repaint) once already clear.
    clearModeNoticeOnKey(host, { name: 'a' });
    expect(host.scheduleRepaint).toHaveBeenCalledTimes(1);
  });
});

describe('gatherChromeRows: modeNotice slot', () => {
  const spinner = new SpinnerController({ captureMode: false, onTick: () => {} });

  it('renders the notice, truncated to the terminal width, without consuming it', () => {
    const ref = { value: null as string | null };
    const rows = gatherChromeRows('', spinner, [], ref, 20, 'x'.repeat(50));
    expect(strip(rows.attachmentRow!).length).toBeLessThanOrEqual(19);
    expect(strip(rows.attachmentRow!).endsWith('…')).toBe(true);
  });

  it('yields to a pending clipboard-failure message', () => {
    const ref = { value: '[clipboard: no image found]' as string | null };
    const rows = gatherChromeRows('', spinner, [], ref, 80, 'mode');
    expect(strip(rows.attachmentRow!)).toBe('[clipboard: no image found]');
  });

  it('defaults to no row when no notice is supplied', () => {
    const rows = gatherChromeRows('', spinner, [], { value: null }, 80);
    expect(rows.attachmentRow).toBeNull();
  });
});

describe('TerminalCompositor: mode notice end-to-end', () => {
  it('Shift+Tab replaces one live row; a later keystroke clears it; nothing is committed', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    let n = 0;
    const labels = ['PLAN-ON-NOTICE', 'BYPASS-ON-NOTICE'];
    // Mirror the REPL wiring: onShiftTab → cyclePermissionMode → setModeNotice.
    (c as unknown as { onShiftTab: () => void }).onShiftTab = () => {
      c.setModeNotice(labels[n++ % labels.length]!);
    };
    const commitSpy = vi.spyOn(c, 'commitAbove');
    await c.arm();
    c.setInputMode('idle');

    stdin.emit('keypress', undefined, { name: 'tab', shift: true });
    expect(c.modeNotice).toBe('PLAN-ON-NOTICE');
    expect(strip(writes.all())).toContain('PLAN-ON-NOTICE');

    writes.clear();
    stdin.emit('keypress', undefined, { name: 'tab', shift: true });
    expect(c.modeNotice).toBe('BYPASS-ON-NOTICE');
    const second = strip(writes.all());
    expect(second).toContain('BYPASS-ON-NOTICE');
    expect(second).not.toContain('PLAN-ON-NOTICE');

    stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
    expect(c.modeNotice).toBeNull();
    expect(c.getBuffer().text).toBe('h');

    // The notice is frame chrome, never a scrollback commit.
    expect(commitSpy).not.toHaveBeenCalled();
    c.disarm();
  });

  it('setModeNotice returns false before arm so callers fall back to scrollback', () => {
    const c = new TerminalCompositor({ stdout: makeMockStdout(), stdin: makeMockStdin(), onCancel: vi.fn() });
    expect(c.setModeNotice('x')).toBe(false);
    expect(c.modeNotice).toBeNull();
  });
});
