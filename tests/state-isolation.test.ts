/**
 * Regression guard: the vitest run must be isolated from the real ~/.afk.
 *
 * Contract: src/__test-utils__/redirect-paths-env.ts (a global setupFile)
 * points AFK_HOME at a per-file mkdtemp sentinel under os.tmpdir() BEFORE any
 * test module evaluates, so production code that resolves paths via
 * src/paths.ts writes into the sentinel — never into the developer's real
 * ~/.afk/state. This suite verifies that redirect is actually in place and
 * actually governs the resolved path helpers. If someone removes the setup
 * file from vitest.config.ts, reorders it after a conflicting setup, or adds
 * a beforeEach that clears the paths category, these assertions fail loudly.
 *
 * History: before the redirect existed, `pnpm test` accumulated ~6,700
 * fixture-named dirs under ~/.afk/state/witness/, fixture session ids under
 * ~/.afk/state/sessions/, and ~30k audit rows in
 * ~/.afk/state/session-grants.jsonl. See PR "test: isolate vitest state
 * writes from real ~/.afk".
 */

import { describe, it, expect } from 'vitest';
import { tmpdir, homedir } from 'os';
import { join, sep } from 'path';
import { realpathSync } from 'fs';
import { SENTINEL_PREFIX } from '../src/__test-utils__/redirect-paths-env.js';
import {
  getAfkHome,
  getAfkStateDir,
  getSessionsDir,
  getSessionGrantsPath,
  getTraceDir,
  getAgentFrameworkDir,
} from '../src/paths.js';

const REAL_AFK = join(homedir(), '.afk');

/**
 * True when `p` lives inside the OS temp tree. Checks both the literal
 * tmpdir() and its realpath because macOS aliases /tmp and /var/folders
 * through /private.
 */
function isUnderTmp(p: string): boolean {
  const tmpReal = realpathSync(tmpdir());
  return p.startsWith(tmpdir() + sep) || p.startsWith(tmpReal + sep);
}

describe('test-run state isolation (real ~/.afk must never be written)', () => {
  it('AFK_HOME is redirected to a sentinel temp dir by the global setup', () => {
    const afkHome = process.env['AFK_HOME'];
    expect(afkHome, 'redirect-paths-env.ts setup did not run').toBeDefined();
    expect(afkHome).toContain(SENTINEL_PREFIX);
    expect(isUnderTmp(afkHome!)).toBe(true);
    expect(afkHome).not.toBe(REAL_AFK);
  });

  it('AFK_STATE_DIR and AFK_FRAMEWORK_DIR do not leak in from the dev shell', () => {
    // The setup deletes both so the sentinel AFK_HOME governs the whole tier.
    expect(process.env['AFK_STATE_DIR']).toBeUndefined();
    expect(process.env['AFK_FRAMEWORK_DIR']).toBeUndefined();
  });

  it('every state-tier path helper resolves under the sentinel, not real ~/.afk', () => {
    const sentinel = process.env['AFK_HOME']!;
    expect(getAfkHome()).toBe(sentinel);
    for (const p of [
      getAfkStateDir(),
      getSessionsDir(),
      getSessionGrantsPath(),
      getTraceDir('isolation-guard-probe'),
      getAgentFrameworkDir(),
    ]) {
      expect(p.startsWith(sentinel + sep)).toBe(true);
      expect(p.startsWith(REAL_AFK + sep)).toBe(false);
    }
  });
});
