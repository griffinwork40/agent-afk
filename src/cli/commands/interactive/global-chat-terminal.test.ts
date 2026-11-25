import { describe, it, expect, vi, afterEach } from 'vitest';
import { onProcessExitOrSignal } from './global-chat-terminal.js';

describe('onProcessExitOrSignal', () => {
  const other = vi.fn();
  afterEach(() => { process.removeListener('SIGTERM', other); other.mockReset(); });

  it('runs before the REPL SIGTERM handler, so the alt screen is left before the exit summary', () => {
    const order: string[] = [];
    other.mockImplementation(() => order.push('repl'));
    process.on('SIGTERM', other);
    const remove = onProcessExitOrSignal(() => order.push('view'));
    try {
      process.emit('SIGTERM', 'SIGTERM');
      expect(order).toEqual(['view', 'repl']);
    } finally { remove(); }
  });

  it('remove() detaches the exit and signal listeners', () => {
    const before = { exit: process.listenerCount('exit'), term: process.listenerCount('SIGTERM'), hup: process.listenerCount('SIGHUP') };
    const remove = onProcessExitOrSignal(() => undefined);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    remove();
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup);
  });
});
