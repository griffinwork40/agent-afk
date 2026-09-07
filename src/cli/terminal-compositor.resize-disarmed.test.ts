import { describe, it, expect, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';

describe('disarmed resize characterization', () => {
  it.each([40, 16, 24])('rearms at %i rows without stale renderer geometry or transcript erasure', async (rows) => {
    vi.useFakeTimers();
    const stdout = makeMockStdout();
    stdout.rows = 24;
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    const initialListeners = process.stdout.listenerCount('resize');
    try {
      await c.arm();
      c.setOverlay('old overlay\nsecond overlay row');
      const renderer = c.logUpdate;
      expect(renderer?.topRow).toBeGreaterThan(0);
      c.disarm();
      expect(c.logUpdate).toBe(renderer);
      expect(renderer?.topRow).toBe(0);
      expect(c.lastKnownRows).toBe(0);
      expect(process.stdout.listenerCount('resize')).toBe(initialListeners);
      writes.clear();
      stdout.rows = rows;
      process.stdout.emit('resize');
      vi.advanceTimersByTime(150);
      expect(writes.all()).toBe('');
      await c.arm();
      expect(writes.all()).toContain(`\x1b[${rows - 1};1H`);
      expect(writes.all()).not.toContain('\x1b[1;1H\x1b[2K');
      expect(c.pendingResizeErase).toBeNull();
    } finally {
      c.disarm();
      c.disarm();
      vi.useRealTimers();
    }
  });
});
