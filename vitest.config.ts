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
    // Exclude the real-PTY harness (*.pty.test.ts) — it needs the native
    // node-pty build and a real pseudo-terminal; run it via `pnpm test:pty`
    // (vitest.pty.config.ts). See tests/pty/ and issue #541.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Live/network tests (*.live.test.ts) need real credentials + network, so
      // they are excluded from the default run. Opt in with RUN_LIVE_API=1 — a
      // bare `pnpm test <file>` / `pnpm vitest run <file>` can't override a
      // config-level exclude, so the env flag is the supported way in, e.g.
      //   RUN_LIVE_API=1 OPENAI_API_KEY=sk-... pnpm vitest run src/agent/providers/openai-compatible/openai-compatible.live.test.ts
      ...(process.env['RUN_LIVE_API'] === '1' ? [] : ['**/*.live.test.ts']),
      '**/*.pty.test.ts',
    ],
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
      // Ratchet floor. Floors are set ~1pt below current so CI fails when
      // coverage regresses. Raise (never lower) as real tests are added.
      //
      // History: re-baselined in the Vitest 2.1.9 -> 4.1.11 upgrade. v4's v8
      // provider replaced v8-to-istanbul with AST-aware remapping, which
      // changes what is counted (statements 126,968 -> 68,474; functions
      // 7,339 -> 9,902), not what runs. Same tree, same 24,826 passing tests:
      //   v2.1.9: stmts 88.40 / branch 86.48 / fn 91.38 / lines 88.40
      //   v4.1.11: stmts 85.75 / branch 78.99 / fn 85.61 / lines 87.15
      // Of 6,583 functions hit under v2, 6,582 are also hit under v4. Evidence
      // is in the upgrade PR body.
      thresholds: {
        statements: 84,
        branches: 78,
        functions: 84,
        lines: 86,
      },
    },
  },
});
