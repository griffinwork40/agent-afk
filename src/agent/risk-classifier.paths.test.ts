import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { classifyFilePath } from './risk-classifier.paths.js';
import { setSessionTmpdirRootForTests } from './session/session-tmpdir.js';
import { _resetFsCaseCacheForTests } from './tools/fs-case.js';
import { _resetWriteDenylistCacheForTests } from './tools/handlers/write-denylist.js';

const workspace = path.resolve('/opt/afk-risk-state-roots-workspace');
const ctx = { cwd: workspace, workspaceRoot: workspace };
const rootVars = ['AFK_HOME', 'AFK_STATE_DIR', 'AFK_FRAMEWORK_DIR'] as const;

describe('AFK state roots never receive the private-temp carve-out', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'afk-risk-state-roots-')));
    setSessionTmpdirRootForTests(tempRoot);
    // Only stub AFK_HOME here when it is not the variable under test; individual
    // tests that test AFK_HOME behaviour re-stub it as needed (item 3 fix).
    vi.stubEnv('AFK_HOME', path.join(tempRoot, 'Home'));
    vi.stubEnv('AFK_STATE_DIR', path.join(tempRoot, 'State'));
    vi.stubEnv('AFK_FRAMEWORK_DIR', path.join(tempRoot, 'Framework'));
  });

  afterEach(() => {
    _resetFsCaseCacheForTests();
    _resetWriteDenylistCacheForTests(); // item 5: reset denylist cache for consistency
    vi.unstubAllEnvs();
    setSessionTmpdirRootForTests(undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it.each(rootVars)('excludes relocated %s itself and descendants', (variable) => {
    // When testing AFK_HOME itself, the beforeEach stub is correct — re-stub
    // to the protected root below. For other variables, move AFK_HOME outside
    // temp so the independent relocation is exercised (item 3 fix).
    if (variable !== 'AFK_HOME') {
      vi.stubEnv('AFK_HOME', path.resolve('/opt/afk-risk-home-outside-temp'));
    }
    const root = path.join(tempRoot, 'Protected');
    vi.stubEnv(variable, root);
    for (const target of [root, path.join(root, 'nested', 'new-file.md')]) {
      expect(classifyFilePath(target, ctx).level).toBe('high');
    }
  });

  // item 4 fix: the platform string was never used inside the suite — collapse
  // to a single describe and pass the case-insensitive flag directly.
  describe('case-insensitive filesystem semantics', () => {
    it.each(rootVars)('refuses case-variant %s with missing path components', (variable) => {
      // Inject volume semantics, not the host OS: runs on POSIX and Windows.
      _resetFsCaseCacheForTests(true);
      const root = path.join(tempRoot, 'Missing', 'Protected');
      vi.stubEnv(variable, root);
      const variant = path.join(tempRoot, 'mISSING', 'pROTECTED');
      for (const target of [variant, path.join(variant, 'skills', 'new-file.md')]) {
        const verdict = classifyFilePath(target, ctx);
        expect(verdict.level).toBe('high');
        expect(verdict.reason).toMatch(/^workspace-escape:/);
      }
    });
  });

  it('keeps boundary-sharing siblings and ordinary scratch writes safe', () => {
    _resetFsCaseCacheForTests(true);
    for (const name of ['Home-extra', 'State-extra', 'Framework-extra', 'scratch']) {
      expect(classifyFilePath(path.join(tempRoot, name, 'new-file.md'), ctx).level).toBe('safe');
    }
  });

  it.each(rootVars)('fails closed for malformed %s', (variable) => {
    vi.stubEnv(variable, 'relative/root');
    expect(classifyFilePath(path.join(tempRoot, 'scratch.md'), ctx).level).toBe('high');
  });

  // item 1 contract: afkStateRootsResolved() is fail-closed — if ANY root
  // cannot be resolved the whole function returns null and the private-temp
  // carve-out is denied. A malformed AFK_FRAMEWORK_DIR must therefore deny
  // writes under AFK_HOME and AFK_STATE_DIR (which are valid), AND also deny
  // a plain temp write that would otherwise be outside all AFK roots.
  //
  // This test would fail if someone changed the function to return partial roots:
  // the plain-temp write would become 'safe' because it is outside the two
  // resolvable roots, proving the hole that partial roots create.
  it('malformed AFK_FRAMEWORK_DIR is fail-closed: denies AFK-root writes AND plain temp writes', () => {
    vi.stubEnv('AFK_FRAMEWORK_DIR', 'relative/bad-framework');
    // Writes under valid AFK roots must be denied.
    const homeTarget = path.join(tempRoot, 'Home', 'config', 'secret.json');
    const stateTarget = path.join(tempRoot, 'State', 'sessions', 'data.json');
    expect(classifyFilePath(homeTarget, ctx).level).toBe('high');
    expect(classifyFilePath(stateTarget, ctx).level).toBe('high');
    // A plain temp write outside all AFK roots must also be denied — because
    // we cannot prove it is outside the unresolvable AFK_FRAMEWORK_DIR.
    // If afkStateRootsResolved() returned partial roots this would be 'safe'.
    const plainTemp = path.join(tempRoot, 'scratch', 'unrelated.txt');
    expect(classifyFilePath(plainTemp, ctx).level).toBe('high');
  });

  // item 6: relocated AFK_STATE_DIR is hard-blocked by getWriteDenylist().
  it('relocated AFK_STATE_DIR is hard-blocked by getWriteDenylist()', () => {
    // Place AFK_STATE_DIR somewhere real so the denylist entry is registered.
    const stateDir = path.join(tempRoot, 'RelocatedState');
    vi.stubEnv('AFK_STATE_DIR', stateDir);
    _resetWriteDenylistCacheForTests();

    // A write directly into the relocated state dir must be hard-blocked (high)
    // regardless of whether the path escapes the workspace — the denylist wins.
    const target = path.join(stateDir, 'sessions', 'new-file.json');
    const verdict = classifyFilePath(target, ctx);
    expect(verdict.level).toBe('high');
  });
});
