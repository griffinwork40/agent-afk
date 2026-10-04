/**
 * Per-session private temp dirs (session-tmpdir.ts).
 *
 * Regression (2026-09-30): every session and subagent shared the operator's
 * $TMPDIR, so one subagent's `rm -rf "$TMPDIR"/tmp.*` deleted concurrent
 * sessions' mktemp dirs. Each session/fork now gets its own TMPDIR.
 *
 * Every test runs under a private root (setSessionTmpdirRootForTests), so
 * nothing here touches the real $TMPDIR beyond that one mkdtemp dir.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  childTmpEnvPatch,
  cleanupSessionTmpdir,
  ensureSessionTmpdir,
  lookupSessionTmpdir,
  resolveSpawnTmpEnv,
  runInTmpdirScope,
  SESSION_DIR_MAX,
  sessionTmpdirRoot,
  setSessionTmpdirRootForTests,
  SOCKET_SUFFIX_BUDGET,
  UNIX_SOCKET_PATH_MAX,
  withSessionTmpdir,
} from './session-tmpdir.js';
import { assembleChildConfig, type AssembleChildConfigArgs } from '../subagent/fork-child-config.js';
import type { AgentConfig } from '../types.js';

let base: string;
let root: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-session-tmpdir-test-'));
  root = path.join(base, 'root');
  setSessionTmpdirRootForTests(root);
});

afterAll(() => {
  setSessionTmpdirRootForTests(undefined);
  fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function topLevel(env?: Record<string, string>): Record<string, string> {
  const config = withSessionTmpdir({ model: 'claude-sonnet-5', ...(env ? { env } : {}) } as AgentConfig);
  return config.env!;
}

function forkArgs(id: string, env?: Record<string, string>): AssembleChildConfigArgs<unknown> {
  return {
    options: {
      parent: { sessionId: 'parent-sess' },
      config: { model: 'claude-sonnet-5', ...(env ? { env } : {}) } as AgentConfig,
      agentType: 'general-purpose',
    } as AssembleChildConfigArgs<unknown>['options'],
    id,
    resume: undefined,
    registry: undefined,
    effectiveChildModel: 'claude-sonnet-5',
    effectiveTimeoutMs: 0,
    inheritedReadRoots: undefined,
    composedWriteRoots: undefined,
    childController: new AbortController(),
    parentCwd: undefined,
    parentApiKey: undefined,
    parentBaseUrl: undefined,
    parentProvider: undefined,
    parentTraceWriter: undefined,
    parentSurface: undefined,
    parentCanUseTool: undefined,
  };
}

describe('top-level injection', () => {
  it('sets TMPDIR/TMP/TEMP to one dir under the root and creates it lazily', async () => {
    const env = topLevel({ KEEP: 'me' });
    expect(env['KEEP']).toBe('me');
    expect(env['TMP']).toBe(env['TMPDIR']);
    expect(env['TEMP']).toBe(env['TMPDIR']);
    expect(path.dirname(env['TMPDIR']!)).toBe(root);
    expect(fs.existsSync(env['TMPDIR']!)).toBe(false);
    expect(ensureSessionTmpdir(env)).toBe(true);
    expect(fs.statSync(env['TMPDIR']!).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(env['TMPDIR']!).mode & 0o777).toBe(0o700);
    }
    await cleanupSessionTmpdir(env);
    expect(fs.existsSync(env['TMPDIR']!)).toBe(false);
  });

  it('gives each top-level session a distinct dir', () => {
    expect(topLevel()['TMPDIR']).not.toBe(topLevel()['TMPDIR']);
  });

  it('leaves a config that already carries TMPDIR untouched', () => {
    expect(topLevel({ TMPDIR: '/chosen' })['TMPDIR']).toBe('/chosen');
  });

  it('is a no-op when AFK_SESSION_TMPDIR_DISABLE=1', () => {
    vi.stubEnv('AFK_SESSION_TMPDIR_DISABLE', '1');
    const config = withSessionTmpdir({ model: 'claude-sonnet-5' } as AgentConfig);
    expect(config.env).toBeUndefined();
    expect(childTmpEnvPatch(undefined, 'child-1')).toEqual({});
  });
});

describe('child injection (assembleChildConfig)', () => {
  it('nests a fresh dir under the dispatching session and preserves PLUGIN_ROOT', () => {
    const parentEnv = topLevel();
    const parentDir = parentEnv['TMPDIR']!;
    const child = runInTmpdirScope(parentDir, () =>
      assembleChildConfig(forkArgs('skill-1', { ...parentEnv, PLUGIN_ROOT: '/plug' })),
    );
    expect(child.env?.['PLUGIN_ROOT']).toBe('/plug');
    expect(child.env?.['TMPDIR']).not.toBe(parentDir);
    expect(path.dirname(child.env!['TMPDIR']!)).toBe(parentDir);
    expect(child.env?.['TMP']).toBe(child.env?.['TMPDIR']);
    // Ensuring the child creates the parent chain too.
    expect(ensureSessionTmpdir(child.env)).toBe(true);
    expect(fs.existsSync(parentDir)).toBe(true);
  });

  it('gives sibling forks distinct dirs', () => {
    const parentDir = topLevel()['TMPDIR']!;
    const [a, b] = runInTmpdirScope(parentDir, () => [
      assembleChildConfig(forkArgs('agent-1')),
      assembleChildConfig(forkArgs('agent-1')),
    ]);
    expect(a!.env?.['TMPDIR']).toBeDefined();
    expect(a!.env?.['TMPDIR']).not.toBe(b!.env?.['TMPDIR']);
  });

  it('respects a caller-chosen TMPDIR that is not a session dir', () => {
    const child = assembleChildConfig(forkArgs('agent-2', { TMPDIR: '/caller/chose' }));
    expect(child.env?.['TMPDIR']).toBe('/caller/chose');
  });
});

describe('cleanup ownership', () => {
  it('never removes a dir that existed before the session created it', async () => {
    const env = topLevel();
    const dir = env['TMPDIR']!;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'foreign.txt'), 'x');
    expect(ensureSessionTmpdir(env)).toBe(true);
    expect(lookupSessionTmpdir(env)?.isOwned).toBe(false);
    await cleanupSessionTmpdir(env);
    expect(fs.existsSync(path.join(dir, 'foreign.txt'))).toBe(true);
  });

  it('never removes a foreign TMPDIR', async () => {
    const foreign = path.join(base, 'foreign');
    fs.mkdirSync(foreign);
    await cleanupSessionTmpdir({ TMPDIR: foreign });
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('refuses a session dir replaced by a symlink pointing outside the root', async () => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    const env = topLevel();
    expect(ensureSessionTmpdir(env)).toBe(true);
    fs.rmSync(env['TMPDIR']!, { recursive: true });
    fs.symlinkSync(outside, env['TMPDIR']!, 'dir');
    await cleanupSessionTmpdir(env);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  it('drops the temp-dir keys when the dir cannot be created', () => {
    const blocker = path.join(base, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    setSessionTmpdirRootForTests(blocker);
    try {
      const env = topLevel({ PLUGIN_ROOT: '/p' });
      const spawnEnv = resolveSpawnTmpEnv(env);
      expect(spawnEnv).toEqual({ PLUGIN_ROOT: '/p' });
    } finally {
      setSessionTmpdirRootForTests(root);
    }
  });
});

describe('socket path length budget (fixes listen EINVAL on macOS)', () => {
  // Invariant: POSIX sun_path is 104 bytes on macOS (NUL-terminated), 108 on
  // Linux. IPC tools like tsx create unix sockets under TMPDIR; if the session
  // dir path is too long the socket bind fails with EINVAL. These tests verify
  // the budget without platform skipIf (R4) by injecting platform/tmpdir.

  it('constants are self-consistent: SESSION_DIR_MAX = UNIX_SOCKET_PATH_MAX - SOCKET_SUFFIX_BUDGET', () => {
    expect(SESSION_DIR_MAX).toBe(UNIX_SOCKET_PATH_MAX - SOCKET_SUFFIX_BUDGET);
    expect(UNIX_SOCKET_PATH_MAX).toBe(104); // macOS struct sockaddr_un.sun_path
    expect(SOCKET_SUFFIX_BUDGET).toBe(40);  // covers "/tsx-<uid5>/<pid7>.pipe"
  });

  it('real sessionTmpdirRoot() + 8-hex leaf fits SESSION_DIR_MAX on this machine', () => {
    // Clear test override so we measure the real implementation.
    setSessionTmpdirRootForTests(undefined);
    try {
      const realRoot = sessionTmpdirRoot();
      // Leaf is always 8 hex chars; separator is 1 char.
      const sessionDir = path.join(realRoot, 'xxxxxxxx');
      expect(sessionDir.length).toBeLessThanOrEqual(SESSION_DIR_MAX);
    } finally {
      setSessionTmpdirRootForTests(root);
    }
  });

  it('session dir + worst-case tsx socket suffix stays under macOS sun_path (104)', () => {
    setSessionTmpdirRootForTests(undefined);
    try {
      const realRoot = sessionTmpdirRoot();
      const sessionDir = path.join(realRoot, 'xxxxxxxx');
      // tsx IPC socket: <TMPDIR>/tsx-<uid>/<pid>.pipe
      // Worst case uid=99999 (5 digits), pid=1234567 (7 digits)
      const tsxSuffix = '/tsx-99999/1234567.pipe'; // 23 chars
      const tsxSocket = sessionDir + tsxSuffix;
      expect(tsxSocket.length).toBeLessThan(UNIX_SOCKET_PATH_MAX);
    } finally {
      setSessionTmpdirRootForTests(root);
    }
  });

  it('top-level allocated dir path fits SESSION_DIR_MAX', () => {
    const env = topLevel();
    expect(env['TMPDIR']!.length).toBeLessThanOrEqual(SESSION_DIR_MAX);
  });
});

describe('real-spawn regression: sibling cleanup cannot reach another sibling', () => {
  it("A's cleanup of its own TMPDIR leaves B's dirs intact", async () => {
    const parentDir = topLevel()['TMPDIR']!;
    const [a, b] = runInTmpdirScope(parentDir, () => [
      assembleChildConfig(forkArgs('sibling-a')),
      assembleChildConfig(forkArgs('sibling-b')),
    ]);
    // Contract: each sibling gets its own TMPDIR that is a child of the parent's
    // TMPDIR, not of the other sibling's TMPDIR.
    const aTmpdir = a!.env!['TMPDIR']!;
    const bTmpdir = b!.env!['TMPDIR']!;
    expect(aTmpdir).not.toBe(bTmpdir);

    // Materialize both session dirs so we can create scratch dirs inside them.
    expect(ensureSessionTmpdir(a!.env!)).toBe(true);
    expect(ensureSessionTmpdir(b!.env!)).toBe(true);

    // Create a scratch dir inside each sibling's TMPDIR (portable — no mktemp shell).
    const bScratch = fs.mkdtempSync(path.join(bTmpdir, 'tmp.'));
    const aScratch = fs.mkdtempSync(path.join(aTmpdir, 'tmp.'));
    expect(fs.existsSync(bScratch)).toBe(true);
    expect(fs.existsSync(aScratch)).toBe(true);

    // Simulate `rm -rf "$TMPDIR"/tmp.*` from A's perspective: remove every
    // tmp.* entry inside A's TMPDIR.  B's TMPDIR is a sibling directory, not
    // a child of A's TMPDIR, so it must be unaffected.
    for (const entry of fs.readdirSync(aTmpdir)) {
      if (entry.startsWith('tmp.')) {
        fs.rmSync(path.join(aTmpdir, entry), { recursive: true, force: true });
      }
    }
    expect(fs.existsSync(aScratch)).toBe(false);
    expect(fs.existsSync(bScratch)).toBe(true);
  });
});
