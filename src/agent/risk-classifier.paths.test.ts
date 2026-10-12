import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { classifyFilePath } from './risk-classifier.paths.js';
import { setSessionTmpdirRootForTests } from './session/session-tmpdir.js';
import { _resetFsCaseCacheForTests } from './tools/fs-case.js';

const workspace = path.resolve('/opt/afk-risk-state-roots-workspace');
const ctx = { cwd: workspace, workspaceRoot: workspace };
const rootVars = ['AFK_HOME', 'AFK_STATE_DIR', 'AFK_FRAMEWORK_DIR'] as const;

describe('AFK state roots never receive the private-temp carve-out', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'afk-risk-state-roots-')));
    setSessionTmpdirRootForTests(tempRoot);
    vi.stubEnv('AFK_HOME', path.join(tempRoot, 'Home'));
    vi.stubEnv('AFK_STATE_DIR', path.join(tempRoot, 'State'));
    vi.stubEnv('AFK_FRAMEWORK_DIR', path.join(tempRoot, 'Framework'));
  });

  afterEach(() => {
    _resetFsCaseCacheForTests();
    vi.unstubAllEnvs();
    setSessionTmpdirRootForTests(undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it.each(rootVars)('excludes relocated %s itself and descendants', (variable) => {
    // Home lives elsewhere when checking the independently relocated tiers.
    vi.stubEnv('AFK_HOME', path.resolve('/opt/afk-risk-home-outside-temp'));
    const root = path.join(tempRoot, 'Protected');
    vi.stubEnv(variable, root);
    for (const target of [root, path.join(root, 'nested', 'new-file.md')]) {
      expect(classifyFilePath(target, ctx).level).toBe('high');
    }
  });

  describe.each(['darwin', 'win32'])('%s case-insensitive filesystem semantics', () => {
    it.each(rootVars)('refuses case-variant %s with missing path components', (variable) => {
      // Inject volume semantics, not the host OS: every case runs on POSIX and Windows.
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
});
