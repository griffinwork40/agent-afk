import { defineConfig } from 'vitest/config';

/**
 * Dedicated config for the real-PTY scrollback harness (issue #541).
 *
 * These tests spawn a native pseudo-terminal (node-pty) per scenario and drive
 * the real TerminalCompositor through it, then assert on a reconstructed xterm
 * emulator's SCROLLBACK buffer. They are split out of the default `pnpm test`
 * run (which excludes the pty-test glob) because:
 *   - they need the native node-pty build (not required by the rest of the suite),
 *   - pty timing can be flaky → `retry`, and
 *   - concurrent ptys contend → serial execution.
 *
 * Run with: `pnpm test:pty`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [
      './src/__test-utils__/stdin-claim-reset.ts',
      './src/__test-utils__/redirect-paths-env.ts',
      './src/__test-utils__/clean-config-env.ts',
    ],
    include: ['tests/pty/**/*.pty.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Real ptys are timing-sensitive; a spawn/flush hiccup should retry, not
    // fail the gate. Two retries is enough to absorb transient CI jitter.
    retry: 2,
    // Never run two ptys at once — they contend on stdin/stdout scheduling.
    fileParallelism: false,
    maxConcurrency: 1,
    // Each test spawns node+tsx+native build; give the harness generous headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
