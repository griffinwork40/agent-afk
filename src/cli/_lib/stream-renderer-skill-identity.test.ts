import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { Writer } from '../slash/types.js';
import { displayWidth, stripAnsi } from '../display.js';
import * as terminalSize from '../terminal-size.js';

const identity = { name: 'review', purpose: 'Check changes', arguments: 'src/index.ts' };
function writer() {
  const line = vi.fn();
  return { line, raw: line, info: line, warn: line, error: line, success: line } satisfies Writer;
}
afterEach(() => vi.restoreAllMocks());
describe('renderer skill identity', () => {
  it.each([false, true])('commits once per invocation (capture=%s)', async (captureMode) => {
    const out = writer();
    for (let i = 0; i < 2; i++) {
      const renderer = new StreamRenderer({ out, skillIdentity: identity, forceNonTty: true, captureMode });
      await renderer.arm();
      await renderer.arm();
      renderer.process({ type: 'done' }, { subagentId: 'child' });
      await renderer.dispose();
      await renderer.dispose();
    }
    const intros = out.line.mock.calls.filter(([line]) => String(line).includes('Check changes'));
    expect(intros).toHaveLength(2);
    expect(intros[0]![0]).toContain('args: src/index.ts');
    expect(intros[0]![0]).not.toContain('\x1b');
  });
  // Regression (#2895 duplicate preview): the identity is committed to
  // scrollback once at arm and must never be repeated in the live overlay.
  it.each([20, 40, 80])('commits identity once and keeps it out of live frames, with stopping feedback at %i columns', async (width) => {
    vi.spyOn(terminalSize, 'getTerminalWidth').mockReturnValue(width);
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const compositor = { setOverlay: vi.fn(), commitAbove: vi.fn(), setInputMode: vi.fn(), getOnCancel: vi.fn(), setOnCancel: vi.fn(), setSpinner: vi.fn() };
    const renderer = new StreamRenderer({ out: writer(), skillIdentity: identity, compositor: compositor as unknown as TerminalCompositor, reducedMotion: true });
    try {
      await renderer.arm();
      const intros = compositor.commitAbove.mock.calls.filter(([text]) => stripAnsi(String(text)).includes('/review'));
      expect(intros).toHaveLength(1);
      expect(stripAnsi(String(intros[0]![0]))).toContain('Check changes');
      renderer.process({ type: 'progress', progress: { taskId: 't', description: 'Working', totalTokens: 0, toolUses: 1, durationMs: 10 } });
      renderer.notifyFirstContent();
      await Promise.resolve();
      renderer.setSoftStopping(true);
      await Promise.resolve();
      const frame = String(compositor.setOverlay.mock.lastCall?.[0]);
      expect(stripAnsi(frame)).toContain('stopping…');
      for (const row of frame.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(width);
      for (const [overlay] of compositor.setOverlay.mock.calls) expect(stripAnsi(String(overlay))).not.toContain('/review');
    } finally {
      await renderer.dispose();
      if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty); else Reflect.deleteProperty(process.stdout, 'isTTY');
      if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty); else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
    expect(compositor.setOverlay.mock.lastCall?.[0]).toBe('');
    expect(compositor.setInputMode.mock.lastCall?.[0]).toBe('idle');
    expect(compositor.setSpinner).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});
