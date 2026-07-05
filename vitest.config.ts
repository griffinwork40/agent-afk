import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [
      './src/__test-utils__/stdin-claim-reset.ts',
      // Redirect the AFK paths tier (AFK_HOME) to a per-file temp sentinel so
      // no test can write into the real ~/.afk. Runs at setup-module eval time
      // (before the test file's module eval) so per-suite overrides still win.
      './src/__test-utils__/redirect-paths-env.ts',
      // Neutralize the developer's ambient AFK_*/provider config so tests
      // assert framework defaults, not the dev's shell / ~/.afk/config/afk.env.
      './src/__test-utils__/clean-config-env.ts',
    ],
    // testTimeout: bumped from vitest default 5000ms to 15000ms.
    // Many CLI/bootstrap tests do `await import('./bootstrap.js')` (directly or
    // via vi.doMock setup) and the transitive import graph can exceed 5s under
    // CI load. v3.47.1 silently never published to npm (2026-05-29) because two
    // such tests timed out — see git log around this commit for the postmortem.
    // A 15s ceiling still catches real hangs without false-positive timeouts.
    testTimeout: 15_000,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Exclude live/network tests from the default run — they require RUN_LIVE_API=1
    // and real credentials. Run them explicitly:
    //   RUN_LIVE_API=1 pnpm vitest run src/agent/providers/anthropic-direct.live.test.ts
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/*.test.ts',
        'src/**/__fixtures__/**',
        'src/**/__test-utils__/**',
      ],
      // Ratchet floor. Current: stmts 75.42 / branch 80.65 / fn 83.9 /
      // lines 75.42. Floors are set ~1pt below current so CI fails when
      // coverage regresses. Raise (never lower) as real tests are added.
      thresholds: {
        statements: 74,
        branches: 79,
        functions: 82,
        lines: 74,
      },
    },
  },
});
