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
//
// Invariant: HOME (and USERPROFILE on win32) point at a SEPARATE per-file
// throwaway dir, so `os.homedir()` can never resolve to the developer's real
// home inside a test. Several security tests deliberately aim writes at
// `~/.ssh/authorized_keys`, `~/.aws/credentials` and `~/Library/LaunchAgents`
// and pass only if a guard refuses; if the guard ever misses (#2905: under
// `--no-isolate` a module-load-time denylist captured a different HOME), the
// write must land in a throwaway dir, not on real credentials. This redirect is
// NOT governed by AFK_TEST_NO_PATH_REDIRECT: that hatch is for AFK_HOME
// debugging, and no debugging session needs tests writing to the real ~/.ssh.
// It is a separate dir from the AFK_HOME sentinel so `~/.afk` and AFK_HOME
// stay distinct, as they are for real users. Tests that save/restore HOME
// capture this fake as `prev`, so restores never reach the real home.
//
// Invariant: the fake home lives under the repo's gitignored
// `node_modules/.cache/afk-test-homes/`, NOT under os.tmpdir(), and is
// realpath-canonical. Real homes are never inside tmp, and the security code
// under test treats tmp specially: the bash hook exempts scratch roots
// (bash-scan-exempt.ts) so `~/.ssh` under tmp would stop being blocked, and
// macOS aliases /var/folders to /private/var/folders so realpath'd denylist
// entries would stop matching homedir(). Either would make the security
// suites test an environment no user has.
//
// Invariant: the tripwire below throws at setup time unless `os.homedir()`
// returns exactly the fake home, i.e. unless the redirect really took effect.
// Checking "is it the real home" is not enough. Under `--pool=threads` each
// test file runs in a worker_threads Worker, where `process.env` is a per-
// thread JS copy and `os.homedir()` keeps reading the process's C environment:
// NO in-test HOME redirect works there (verified on Node 24; this is how the
// #2905 plist reached the real ~/Library/LaunchAgents while its AFK_HOME log
// paths went to tmp). A setup-file throw fails every test file, including
// under `--no-isolate`, instead of letting one test write for real. The suite
// is therefore unsupported under the threads pool; use the default forks pool.
// Real-home writes from production code are not possible on forks because the
// main-thread `process.env` setter calls setenv(3).
//
// Invariant: the fake home is created FRESH at setup-module eval time and never
// reused across files, so the `homedir() === fakeUserHome` check below is exact.
import { afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { homedir, tmpdir, userInfo } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Escape hatch for the rare debugging session that intentionally wants tests
 * to run against a caller-chosen AFK_HOME. Never set in CI.
 */
const OPT_OUT = process.env['AFK_TEST_NO_PATH_REDIRECT'] === '1'; // audit-env-access: allow — test-only escape hatch, not a runtime config var

/** Exported for the regression-guard test (tests/state-isolation.test.ts). */
export const SENTINEL_PREFIX = 'afk-test-home-';

/** Prefix of the fake user HOME. Exported for tests/state-isolation.test.ts. */
export const FAKE_USER_HOME_PREFIX = 'afk-test-userhome-';

/** Parent of every fake user HOME: gitignored, outside os.tmpdir(). */
export const FAKE_USER_HOME_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'node_modules',
  '.cache',
  'afk-test-homes',
);

/**
 * The OS account's real home dir, read from the passwd/profile record (not
 * from HOME). `undefined` when the record is unavailable (e.g. a container
 * uid with no passwd entry), in which case the tripwire cannot compare.
 */
function accountHome(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
}

mkdirSync(FAKE_USER_HOME_ROOT, { recursive: true });
const fakeUserHome = realpathSync(mkdtempSync(join(FAKE_USER_HOME_ROOT, FAKE_USER_HOME_PREFIX)));
process.env['HOME'] = fakeUserHome; // audit-env-access: allow — test isolation: os.homedir() must never be the real home (#2905)
if (process.platform === 'win32') {
  process.env['USERPROFILE'] = fakeUserHome; // audit-env-access: allow — os.homedir() reads USERPROFILE on win32
}

if (homedir() !== fakeUserHome) {
  const realHome = accountHome();
  throw new Error(
    `[redirect-paths-env] os.homedir() is ${homedir()} after redirecting HOME to ` +
      `${fakeUserHome}${homedir() === realHome ? ' (the REAL user home)' : ''}. ` +
      'The redirect did not take effect, which happens under --pool=threads ' +
      '(worker threads do not propagate in-JS env writes to os.homedir()). Refusing ' +
      'to run tests that may write to ~/.ssh, ~/.aws or ~/Library/LaunchAgents. ' +
      'Use the default forks pool. See issue #2905.',
  );
}

let sentinelDir: string | undefined;

if (!OPT_OUT) {
  sentinelDir = mkdtempSync(join(tmpdir(), SENTINEL_PREFIX));
  process.env['AFK_HOME'] = sentinelDir; // audit-env-access: allow — test-setup redirect of the paths tier
  delete process.env['AFK_STATE_DIR']; // audit-env-access: allow — derive from sentinel AFK_HOME
  delete process.env['AFK_FRAMEWORK_DIR']; // audit-env-access: allow — derive from sentinel AFK_HOME
}

afterAll(() => {
  for (const dir of [sentinelDir, fakeUserHome]) {
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: a leaked dir under os.tmpdir() is harmless and the OS
      // reaps it eventually. Never fail the suite over cleanup.
    }
  }
});
