/**
 * Tests for TerminalCompositor — arm/disarm lifecycle + suspend/resume.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369);
 * these were nested describes under the top-level TerminalCompositor suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests, currentStdinClaimHolder } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

describe('TerminalCompositor — arm/disarm lifecycle + suspend/resume', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
    // Reset the process-wide StdinClaim singleton so each test starts clean.
    __resetStdinClaimForTests();
  });

  describe('arm/disarm lifecycle', () => {
    it('arm() enables raw mode and marks armed', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      expect(stdin.setRawMode).toHaveBeenCalledWith(true);
      expect(c.isArmed()).toBe(true);
    });

    it('arm() throws if called while already armed', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      await expect(c.arm()).rejects.toThrow('already armed');
      c.disarm();
    });

    it('disarm() restores prior raw mode', async () => {
      stdin.isRaw = false;
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.disarm();
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(c.isArmed()).toBe(false);
    });

    it('disarm() is idempotent when not armed', () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      expect(() => c.disarm()).not.toThrow();
      expect(c.isArmed()).toBe(false);
    });

    it('arm() on non-TTY stdout is a no-op (no raw mode)', async () => {
      const nonTtyStdout = makeMockStdout(false);
      const c = new TerminalCompositor({ stdout: nonTtyStdout, stdin, onCancel: vi.fn() });
      await c.arm();
      expect(stdin.setRawMode).not.toHaveBeenCalled();
      expect(c.isArmed()).toBe(false);
    });

    it('disarm() calls logUpdate.done() so the cursor is restored', async () => {
      // log-update hides the cursor on every render() and only calls
      // cliCursor.show() from done() — not clear(). Without this call the
      // cursor stays hidden for the rest of the session after the very
      // first turn finishes.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // After arm(), the compositor's logUpdate instance exists. Swap in a
      // spy pair to observe disarm()'s teardown calls.
      const internals = c as unknown as {
        logUpdate: { clear: () => void; done: () => void } | null;
      };
      const clearSpy = vi.fn();
      const doneSpy = vi.fn();
      internals.logUpdate = { clear: clearSpy, done: doneSpy };
      c.disarm();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(doneSpy).toHaveBeenCalledTimes(1);
    });

    it('arm() acquires the stdin claim under TerminalCompositor.arm', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      expect(currentStdinClaimHolder()).toBeNull();
      await c.arm();
      expect(currentStdinClaimHolder()).toBe('TerminalCompositor.arm');
      c.disarm();
      expect(currentStdinClaimHolder()).toBeNull();
    });

    it('arm() throws a conflict error if another holder already holds the claim', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      // Manually acquire before arm() to simulate a concurrent consumer.
      const { acquireStdinClaim } = await import('./input/stdin-claim.js');
      const handle = acquireStdinClaim('test-interloper');
      try {
        await expect(c.arm()).rejects.toThrow('stdin claim conflict');
      } finally {
        handle.release();
      }
    });

    it('arm() rejecting on a stdin-claim conflict does not leak raw mode or bracketed-paste', async () => {
      // Regression: arm() enabled raw mode + bracketed-paste BEFORE acquiring the
      // stdin claim, then threw on conflict with armed=false — so disarm()'s
      // restore path never ran and the terminal leaked raw mode for the process
      // lifetime. After a failed arm(): raw mode must be off, and bracketed-paste
      // must not be left enabled (either never enabled, or re-disabled).
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      const { acquireStdinClaim } = await import('./input/stdin-claim.js');
      const handle = acquireStdinClaim('test-interloper');
      const chunks: string[] = [];
      stdout.on('data', (ch: unknown) => chunks.push(String(ch)));
      try {
        await expect(c.arm()).rejects.toThrow('stdin claim conflict');
        expect(stdin.isRaw).toBe(false);
        const out = chunks.join('');
        if (out.includes('\x1b[?2004h')) expect(out).toContain('\x1b[?2004l');
      } finally {
        handle.release();
      }
    });
  });

  describe('suspendInput / resumeInput', () => {
    const BRAILLE_FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

    it('repaint short-circuits while suspended: setOverlay produces no writes', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Establish a baseline frame so the next paint would otherwise produce
      // visible clear+redraw bytes.
      c.setOverlay('initial');
      c.suspendInput();
      writes.clear();
      c.setOverlay('would-clobber-the-elicitation-prompt');
      // No paint should occur — the suspended gate blocks repaint entirely.
      expect(writes.all()).toBe('');
    });

    it('spinner tick fires no paint while suspended (regression for ask_question clobbering)', async () => {
      vi.useFakeTimers();
      try {
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        c.setSpinner({ enabled: true });
        // Drain the initial spinner paint so the assertion below isolates the
        // ticker-driven repaints.
        writes.clear();
        c.suspendInput();
        // Advance well past the 80ms tick interval — multiple ticks should
        // fire while suspended.
        writes.clear();
        vi.advanceTimersByTime(500);
        expect(writes.all()).not.toMatch(BRAILLE_FRAME_RE);
        // The spinner state itself still advances internally (frameIndex
        // bumps); only the paint is suppressed. resumeInput's terminal
        // repaint will surface the latest frame.
        c.resumeInput();
        expect(writes.all()).toMatch(BRAILLE_FRAME_RE);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resumeInput is idempotent (calling twice does not double-paint)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.suspendInput();
      writes.clear();
      c.resumeInput();
      const firstResumeBytes = writes.all();
      writes.clear();
      c.resumeInput();
      // Second resume is a no-op (already resumed); no further paint.
      expect(writes.all()).toBe('');
      expect(firstResumeBytes.length).toBeGreaterThan(0);
    });

    it('suspendInput is idempotent (calling twice does not throw or re-clear)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setOverlay('hello');
      writes.clear();
      c.suspendInput();
      const firstSuspendBytes = writes.all();
      writes.clear();
      c.suspendInput();
      // Second suspend short-circuits before the clear path runs.
      expect(writes.all()).toBe('');
      // First suspend did emit clear bytes (overlay was non-empty).
      expect(firstSuspendBytes.length).toBeGreaterThan(0);
    });

    it('suspendInput before arm is a safe no-op', () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      expect(() => c.suspendInput()).not.toThrow();
      expect(() => c.resumeInput()).not.toThrow();
    });
  });

  describe('keypresses ignored when disarmed', () => {
    it('does not call onCancel on ESC after disarm', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      c.disarm();
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('does not mutate buffer on keypress after disarm', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.disarm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      expect(c.getBuffer().text).toBe('');
    });
  });
});
