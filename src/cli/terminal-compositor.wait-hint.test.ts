/**
 * End-to-end wiring of the wait_for queue-to-stop hint through a real
 * TerminalCompositor: setRootWaitActive drives the spinner's tip row, and a
 * committed (queued) message flips the copy to the "queued" state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin } from './terminal-compositor.test-helpers.js';

const strip = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor: wait_for hint', () => {
  it('shows the waiting hint, then the queued hint, then clears', () => {
    const c = new TerminalCompositor({ stdout: makeMockStdout(), stdin: makeMockStdin(), onCancel: vi.fn() });
    const spinner = c.spinnerController;
    spinner.set({ enabled: true });
    try {
      expect(spinner.renderTipRow(120)).toBeNull(); // no wait, still in tip warmup

      c.setRootWaitActive(true);
      expect(strip(spinner.renderTipRow(120)!)).toBe('  Hint: type a message + Enter to stop waiting');

      c.pendingSubmissions.push({ text: 'stop please', attachments: [] } as (typeof c.pendingSubmissions)[number]);
      expect(strip(spinner.renderTipRow(120)!)).toBe('  Hint: message queued, the wait will stop within ~1s');

      c.setRootWaitActive(false);
      expect(spinner.renderTipRow(120)).toBeNull();
    } finally {
      spinner.dispose();
    }
  });
});
