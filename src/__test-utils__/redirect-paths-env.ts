// Global test setup: redirect the AFK paths tier (AFK_HOME + derived state/
// framework dirs) to a per-test-file temp dir so `pnpm test` NEVER writes to
// the real ~/.afk.
//
// History: before this file existed, the paths category was deliberately left
// untouched by clean-config-env.ts (see its Invariant header) and any test
// that exercised state-writing production code WITHOUT redirecting env wrote
// into the developer's real ~/.afk/state — the observed damage was ~6,700
// fixture-named witness dirs (t-*, task-a-*, ss-task-*), literal fixture ids
// under state/sessions/ (parent-session, some-resumed-id), and ~30k `/extra`
// rows in state/session-grants.jsonl appended by dispatcher.test.ts's
// grant-audit-log path. Clearing/sealing the paths vars in a beforeEach was
// previously verified to break two groups: ~11 test files that assign paths
// vars at module-eval time, and ~44 tests that assert the UNSET fallback
// (getAfkHome() → ~/.afk). This file threads that needle — see the Invariants.
//
// Invariant: the redirect happens ONCE, at setup-module EVAL time, never in a
// beforeEach/afterEach hook. Vitest evaluates setupFiles before the test-file
// module in the same worker, so:
//   - test files that assign AFK_HOME/AFK_STATE_DIR at module-eval time or in
//     their own hooks run AFTER this file and cleanly override the sentinel;
//   - their save/restore idiom (snapshot AFK_HOME into `prev`, override,
//     restore `prev` in afterEach) captures the SENTINEL as `prev` and
//     restores it, keeping later tests in the same file isolated;
//   - tests that assert the unset fallback delete AFK_HOME/AFK_STATE_DIR
//     themselves (and point HOME at a tmp dir), which this file must not
//     re-instate mid-file — hence no beforeEach.
//
// Invariant: the sentinel dir is a fresh mkdtemp per TEST FILE (vitest's
// default isolation gives each file its own worker module registry, so this
// module re-evaluates per file). Per-file freshness prevents cross-file bleed
// through shared state paths (e.g. listSessions() counting another file's
// saves). The dir is removed in afterAll, best-effort.
//
// Invariant: AFK_STATE_DIR and AFK_FRAMEWORK_DIR are DELETED, not set — both
// derive from AFK_HOME when unset (src/paths.ts), so deleting them makes the
// sentinel AFK_HOME govern the whole tier AND removes bleed from a developer
// shell that exports them (AFK_FRAMEWORK_DIR is commonly exported by
// src/cli/index.ts into child sessions).
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Escape hatch for the rare debugging session that intentionally wants tests
 * to run against a caller-chosen AFK_HOME. Never set in CI.
 */
const OPT_OUT = process.env['AFK_TEST_NO_PATH_REDIRECT'] === '1'; // audit-env-access: allow — test-only escape hatch, not a runtime config var

/** Exported for the regression-guard test (tests/state-isolation.test.ts). */
export const SENTINEL_PREFIX = 'afk-test-home-';

let sentinelDir: string | undefined;

if (!OPT_OUT) {
  sentinelDir = mkdtempSync(join(tmpdir(), SENTINEL_PREFIX));
  process.env['AFK_HOME'] = sentinelDir; // audit-env-access: allow — test-setup redirect of the paths tier
  delete process.env['AFK_STATE_DIR']; // audit-env-access: allow — derive from sentinel AFK_HOME
  delete process.env['AFK_FRAMEWORK_DIR']; // audit-env-access: allow — derive from sentinel AFK_HOME
}

afterAll(() => {
  if (sentinelDir !== undefined) {
    try {
      rmSync(sentinelDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a leaked dir under os.tmpdir() is harmless and the OS
      // reaps it eventually. Never fail the suite over cleanup.
    }
  }
});
