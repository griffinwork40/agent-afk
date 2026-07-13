import { describe, it, expect, vi, afterEach } from 'vitest';
import { createReplRenderer } from './repl-renderer.js';

function makeStdout(isTTY: boolean) {
  const write = vi.fn();
  return { write, isTTY } as unknown as NodeJS.WriteStream & { write: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createReplRenderer', () => {
  describe('armed compositor routing', () => {
    it('routes writeLine through commitAbove when compositor is armed', () => {
      const stdout = makeStdout(true);
      const commitAbove = vi.fn();
      const compositor = { isArmed: () => true, commitAbove };
      const renderer = createReplRenderer(stdout);
      renderer.setCompositor(compositor);

      renderer.writeLine('hello');

      expect(commitAbove).toHaveBeenCalledWith('hello');
      expect(stdout.write).not.toHaveBeenCalled();
    });
  });

  describe('unarmed compositor routing', () => {
    it('writes directly to stdout when compositor is set but not armed', () => {
      const stdout = makeStdout(true);
      const commitAbove = vi.fn();
      const compositor = { isArmed: () => false, commitAbove };
      const renderer = createReplRenderer(stdout);
      renderer.setCompositor(compositor);

      renderer.writeLine('hello');

      expect(stdout.write).toHaveBeenCalledWith('hello\n');
      expect(commitAbove).not.toHaveBeenCalled();
    });

    it('writes directly to stdout when no compositor is set', () => {
      const stdout = makeStdout(true);
      const renderer = createReplRenderer(stdout);

      renderer.writeLine('hello');

      expect(stdout.write).toHaveBeenCalledWith('hello\n');
    });
  });

  describe('non-TTY surface', () => {
    it('always writes to stdout regardless of compositor state', () => {
      const stdout = makeStdout(false);
      const commitAbove = vi.fn();
      const compositor = { isArmed: () => true, commitAbove };
      const renderer = createReplRenderer(stdout);
      renderer.setCompositor(compositor);

      renderer.writeLine('hello');

      expect(stdout.write).toHaveBeenCalledWith('hello\n');
      expect(commitAbove).not.toHaveBeenCalled();
    });

    it('setCompositor is a no-op on non-TTY surfaces', () => {
      const stdout = makeStdout(false);
      const renderer = createReplRenderer(stdout);
      expect(() => renderer.setCompositor(null)).not.toThrow();
    });
  });

  describe('writeLine empty string', () => {
    it('emits a blank line via stdout.write when unarmed', () => {
      const stdout = makeStdout(true);
      const renderer = createReplRenderer(stdout);
      renderer.writeLine('');
      expect(stdout.write).toHaveBeenCalledWith('\n');
    });
  });

  describe('AFK_PLAIN_OUTPUT opt-in', () => {
    it('selects the plain path on a TTY when AFK_PLAIN_OUTPUT=1, bypassing the compositor', () => {
      vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
      const stdout = makeStdout(true);
      const commitAbove = vi.fn();
      const compositor = { isArmed: () => true, commitAbove };
      const renderer = createReplRenderer(stdout);
      renderer.setCompositor(compositor);

      renderer.writeLine('hello');

      expect(stdout.write).toHaveBeenCalledWith('hello\n');
      expect(commitAbove).not.toHaveBeenCalled();
    });

    it('selects the plain path on a TTY when AFK_PLAIN_OUTPUT=true (case-insensitive)', () => {
      vi.stubEnv('AFK_PLAIN_OUTPUT', 'TRUE');
      const stdout = makeStdout(true);
      const renderer = createReplRenderer(stdout);

      renderer.writeLine('hello');

      expect(stdout.write).toHaveBeenCalledWith('hello\n');
    });

    it('setCompositor is a no-op on the plain path forced by AFK_PLAIN_OUTPUT', () => {
      vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
      const stdout = makeStdout(true);
      const renderer = createReplRenderer(stdout);
      expect(() => renderer.setCompositor(null)).not.toThrow();
    });

    it('does not force the plain path for unrecognized values (e.g. "0")', () => {
      vi.stubEnv('AFK_PLAIN_OUTPUT', '0');
      const stdout = makeStdout(true);
      const commitAbove = vi.fn();
      const compositor = { isArmed: () => true, commitAbove };
      const renderer = createReplRenderer(stdout);
      renderer.setCompositor(compositor);

      renderer.writeLine('hello');

      expect(commitAbove).toHaveBeenCalledWith('hello');
      expect(stdout.write).not.toHaveBeenCalled();
    });

    it('leaves the default TTY live-overlay path unchanged when AFK_PLAIN_OUTPUT is unset', () => {
      vi.stubEnv('AFK_PLAIN_OUTPUT', undefined as unknown as string);
      const stdout = makeStdout(true);
      const commitAbove = vi.fn();
      const compositor = { isArmed: () => true, commitAbove };
      const renderer = createReplRenderer(stdout);
      renderer.setCompositor(compositor);

      renderer.writeLine('hello');

      expect(commitAbove).toHaveBeenCalledWith('hello');
      expect(stdout.write).not.toHaveBeenCalled();
    });
  });
});
