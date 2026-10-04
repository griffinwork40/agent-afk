import { expect, it, vi } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import * as terminalSize from '../terminal-size.js';
import { displayWidth } from '../display.js';

it('repaints identity on resize alone within one pause tick, without progress events', async () => {
  vi.useFakeTimers();
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const width = vi.spyOn(terminalSize, 'getTerminalWidth').mockReturnValue(80);
  const compositor = { setOverlay: vi.fn(), commitAbove: vi.fn(), setInputMode: vi.fn(), getOnCancel: vi.fn(), setOnCancel: vi.fn(), setSpinner: vi.fn() };
  const line = vi.fn();
  const renderer = new StreamRenderer({
    out: { line, raw: line, info: line, warn: line, error: line, success: line },
    skillIdentity: { name: 'review', purpose: 'Check the complete change set', arguments: 'src/index.ts' },
    compositor: compositor as unknown as TerminalCompositor, reducedMotion: true,
  });
  try {
    await renderer.arm();
    for (const cols of [40, 20, 80]) {
      width.mockReturnValue(cols);
      compositor.setOverlay.mockClear();
      terminalSize.__flushResizeBusForTests();
      await vi.advanceTimersByTimeAsync(80);
      expect(compositor.setOverlay).toHaveBeenCalledTimes(1);
      const frame = String(compositor.setOverlay.mock.lastCall?.[0]);
      expect(frame).toContain('/review');
      for (const row of frame.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(cols);
    }
  } finally {
    await renderer.dispose();
    if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty); else Reflect.deleteProperty(process.stdout, 'isTTY');
    if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty); else Reflect.deleteProperty(process.stdin, 'isTTY');
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
