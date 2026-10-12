import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { classifyRiskDetailed } from './risk-classifier.js';
import { setSessionTmpdirRootForTests } from './session/session-tmpdir.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const workspace = path.resolve('/opt/afk-risk-temp-perf-workspace');
const ctx = { cwd: workspace, workspaceRoot: workspace };

describe('private-temp classification validation reuse', () => {
  let root: string;
  let scratch: string;
  const classify = (filePath: string) =>
    classifyRiskDetailed('write_file', { file_path: filePath, content: 'test' }, ctx);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'afk-risk-temp-perf-')));
    scratch = path.join(root, 'scratch.md');
    writeFileSync(scratch, 'fixture');
    setSessionTmpdirRootForTests(root);
    vi.stubEnv('AFK_HOME', path.join(root, 'first-home'));
    vi.stubEnv('AFK_STATE_DIR', path.join(root, 'state'));
    vi.stubEnv('AFK_FRAMEWORK_DIR', path.join(root, 'framework'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    setSessionTmpdirRootForTests(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('validates a cached root once per classification, not once per containment check', () => {
    expect(classify(scratch).level).toBe('safe');
    vi.mocked(lstatSync).mockClear();
    for (let i = 0; i < 3; i++) expect(classify(scratch).level).toBe('safe');
    const rootProbes = vi.mocked(lstatSync).mock.calls.filter(([candidate]) => candidate === root);
    expect(rootProbes).toHaveLength(3);
  });

  it('fails closed when a cached root can no longer be inspected', () => {
    // Use one admitted root so an enclosing os.tmpdir cannot mask this check.
    vi.spyOn(os, 'tmpdir').mockReturnValue(root);
    expect(classify(scratch).level).toBe('safe');
    const original = vi.mocked(lstatSync).getMockImplementation()!;
    vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
      if (args[0] === root) throw new Error('root reaped');
      return original(...args);
    });
    expect(classify(scratch).level).toBe('high');
    vi.restoreAllMocks();
    vi.mocked(lstatSync).mockImplementation(original);
  });

  it('tracks AFK_HOME changes after the temp-root cache is populated', () => {
    const first = path.join(root, 'first-home', 'new.md');
    const second = path.join(root, 'second-home', 'new.md');
    expect(classify(first).level).toBe('high');
    expect(classify(second).level).toBe('safe');
    vi.stubEnv('AFK_HOME', path.join(root, 'second-home'));
    expect(classify(second).level).toBe('high');
    expect(classify(first).level).toBe('safe');
    vi.stubEnv('AFK_HOME', 'relative/invalid');
    expect(classify(scratch).level).toBe('high');
  });
});
