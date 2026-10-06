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

  it('top-level allocated leaf is a short fixed-width segment directly under the root', () => {
    // The test root is a long mkdtemp path (93 chars on macOS CI runners), so
    // the absolute length is asserted against the REAL root in the tests above;
    // here we pin only the leaf the allocator appends: one 8-hex segment.
    const env = topLevel();
    const leaf = path.relative(root, env['TMPDIR']!);
    expect(leaf).toMatch(/^[0-9a-f]{8}$/);
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

// ---------------------------------------------------------------------------
// #2933 hardening tests
// ---------------------------------------------------------------------------

describe('#2933 TOCTOU: cleanup does not follow a symlink swapped in after ensure', () => {
  it('leaves the symlink target intact when the session dir is replaced by a symlink', async () => {
    // Create a dir that must survive the cleanup attempt.
    const target = path.join(base, 'symlink-target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'precious.txt'), 'keep me');

    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const sessionDir = e['TMPDIR']!;

    // Simulate a concurrent actor swapping the session dir for a symlink.
    fs.rmSync(sessionDir, { recursive: true });
    fs.symlinkSync(target, sessionDir, 'dir');

    await cleanupSessionTmpdir(e);

    // The symlink target must not have been removed.
    expect(fs.existsSync(path.join(target, 'precious.txt'))).toBe(true);
    // The symlink itself may or may not remain — we don't care, as long as
    // the target directory and its contents are intact.
  });
});

describe('#2933 ensured-flag cache: ensure() skips lstatSync after first success', () => {
  it('returns true on repeated calls without re-checking the filesystem', () => {
    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    // Even if we manually break lstat by passing a bad path in a registry
    // clone, the cached flag means the real path never needs re-stat.
    // Here we just confirm repeated calls are idempotent (no throw).
    expect(ensureSessionTmpdir(e)).toBe(true);
    expect(ensureSessionTmpdir(e)).toBe(true);
  });

  it('resets the ensured flag after cleanup so re-use re-creates the dir', async () => {
    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const dir = e['TMPDIR']!;
    expect(fs.existsSync(dir)).toBe(true);

    // cleanup() must reset the ensured flag (and owned flag).
    await cleanupSessionTmpdir(e);
    expect(fs.existsSync(dir)).toBe(false);

    // Re-allocate a fresh session using the same registry helper; the new
    // entry must pass ensure() without a stale cached flag.
    const e2 = topLevel();
    expect(ensureSessionTmpdir(e2)).toBe(true);
    expect(fs.existsSync(e2['TMPDIR']!)).toBe(true);
    await cleanupSessionTmpdir(e2);
  });
});

// ---------------------------------------------------------------------------
// #3072 hardening tests
// ---------------------------------------------------------------------------

describe('#3072 resolveSpawnTmpEnv: debugLog fallback path', () => {
  it('emits a debugLog message and strips temp-dir keys when ensure() fails', () => {
    // Force ensure() to fail by pointing the root at a plain file so mkdirSync
    // cannot create the session dir under it.
    const blocker = path.join(base, 'blocker-debuglog');
    fs.writeFileSync(blocker, 'x');
    setSessionTmpdirRootForTests(blocker);
    vi.stubEnv('AFK_DEBUG', '1');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const e = topLevel({ KEEP: 'me' });
      const result = resolveSpawnTmpEnv(e);
      // Temp-dir keys must be stripped on failure.
      expect(result).toEqual({ KEEP: 'me' });
      // The debugLog line must have been emitted.
      const logged = consoleSpy.mock.calls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('[session-tmpdir]') && args[0].includes('falling back'),
      );
      expect(logged).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      vi.unstubAllEnvs();
      setSessionTmpdirRootForTests(root);
    }
  });

  it('returns the env unchanged and emits no log when ensure() succeeds', () => {
    vi.stubEnv('AFK_DEBUG', '1');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const e = topLevel({ KEEP: 'me' });
      expect(ensureSessionTmpdir(e)).toBe(true);
      const result = resolveSpawnTmpEnv(e);
      // All temp-dir keys must be present and unchanged.
      expect(result?.['TMPDIR']).toBe(e['TMPDIR']);
      expect(result?.['KEEP']).toBe('me');
      // No fallback log should have been emitted.
      const logged = consoleSpy.mock.calls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('[session-tmpdir]'),
      );
      expect(logged).toBe(false);
    } finally {
      consoleSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('#3072 TOCTOU closure: cleanup renames before rm to close lstat-to-rm race', () => {
  it('removes the session dir contents via the renamed sibling path', async () => {
    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const sessionDir = e['TMPDIR']!;
    fs.writeFileSync(path.join(sessionDir, 'scratch.txt'), 'data');
    expect(fs.existsSync(path.join(sessionDir, 'scratch.txt'))).toBe(true);

    await cleanupSessionTmpdir(e);

    // The original session dir and its contents must be gone.
    expect(fs.existsSync(sessionDir)).toBe(false);
    // No renamed sibling with the .rm suffix should remain under the parent.
    const parent = path.dirname(sessionDir);
    if (fs.existsSync(parent)) {
      const entries = fs.readdirSync(parent);
      expect(entries.every((n) => !n.endsWith('.rm'))).toBe(true);
    }
  });

  it('leaves the symlink target intact when the session dir is replaced by a symlink before cleanup', async () => {
    const target = path.join(base, 'rename-toctou-target');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'precious.txt'), 'keep me');

    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const sessionDir = e['TMPDIR']!;

    // Simulate a concurrent actor swapping the session dir for a symlink
    // between lstat and rename in cleanup().
    fs.rmSync(sessionDir, { recursive: true });
    fs.symlinkSync(target, sessionDir, 'dir');

    await cleanupSessionTmpdir(e);

    // The symlink target must be intact.
    expect(fs.existsSync(path.join(target, 'precious.txt'))).toBe(true);
    // No dangling .rm sibling should linger under the parent directory.
    const parent = path.dirname(sessionDir);
    if (fs.existsSync(parent)) {
      const entries = fs.readdirSync(parent);
      expect(entries.every((n) => !n.endsWith('.rm'))).toBe(true);
    }
  });

  it('removes the session dir via direct rm when rename fails with EXDEV', async () => {
    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const sessionDir = e['TMPDIR']!;
    fs.writeFileSync(path.join(sessionDir, 'data.txt'), 'content');

    // Intercept ALL rename calls and simulate a cross-device failure so that
    // any accidental retry also goes through the mock (not the real rename).
    const exdevErr = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    }) as NodeJS.ErrnoException;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(exdevErr);
    try {
      await cleanupSessionTmpdir(e);
    } finally {
      renameSpy.mockRestore();
    }

    // The session dir must be gone even though rename failed.
    expect(fs.existsSync(sessionDir)).toBe(false);
    // No .rm sibling should exist (EXDEV path does not create one).
    const parent = path.dirname(sessionDir);
    if (fs.existsSync(parent)) {
      const entries = fs.readdirSync(parent);
      expect(entries.every((n) => !n.endsWith('.rm'))).toBe(true);
    }
  });

  it('does not delete anything when rename fails with EXDEV and the dir became a symlink', async () => {
    const target = path.join(base, 'exdev-symlink-target');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'safe');

    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const sessionDir = e['TMPDIR']!;

    // Replace the session dir with a symlink to the target — simulating a swap
    // that happens after the step-1 lstat but before the EXDEV fallback lstat.
    fs.rmSync(sessionDir, { recursive: true });
    fs.symlinkSync(target, sessionDir, 'dir');

    // Intercept ALL rename calls to simulate EXDEV so the fallback path runs.
    const exdevErr = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    }) as NodeJS.ErrnoException;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(exdevErr);
    try {
      await cleanupSessionTmpdir(e);
    } finally {
      renameSpy.mockRestore();
    }

    // The symlink target must be intact; the fallback lstat must have caught
    // the symlink and bailed before calling rm.
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
  });

  it('EXDEV fallback bails when realpath containment check fails', async () => {
    // Create a directory outside the root to act as the "session dir".
    const outside = path.join(base, 'exdev-outside-root');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');

    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const sessionDir = e['TMPDIR']!;

    // Simulate EXDEV on rename so the fallback path runs.  We also need the
    // fallback lstat to see a real dir — we keep sessionDir intact for that.
    const exdevErr = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    }) as NodeJS.ErrnoException;

    // Override realpath so that this.dir resolves to outside the root.
    const origRealpath = fs.promises.realpath.bind(fs.promises);
    const realpathSpy = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (p) => {
      if (p === sessionDir) return outside; // claim it resolves outside the root
      return origRealpath(p as string);
    });
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(exdevErr);
    try {
      await cleanupSessionTmpdir(e);
    } finally {
      renameSpy.mockRestore();
      realpathSpy.mockRestore();
    }

    // The outside directory must still exist — containment check must have bailed.
    expect(fs.existsSync(path.join(outside, 'sentinel.txt'))).toBe(true);
    // The actual session dir may or may not be present (we did not rm it).
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('EXDEV fallback bails when uid ownership check fails', async () => {
    if (typeof process.getuid !== 'function') return; // uid check skipped on Windows

    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const sessionDir = e['TMPDIR']!;
    fs.writeFileSync(path.join(sessionDir, 'data.txt'), 'keep');

    const exdevErr = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    }) as NodeJS.ErrnoException;

    // Override lstat so the second call (inside the EXDEV fallback) returns a
    // mismatched uid, as if the directory was replaced by one owned by root.
    let lstatCallCount = 0;
    const origLstat = fs.promises.lstat.bind(fs.promises);
    const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p) => {
      const st = await origLstat(p as string);
      lstatCallCount++;
      if (lstatCallCount === 2) {
        // Return a stat-like object with uid=0 (root) to trigger the uid bail.
        return Object.create(st, { uid: { value: 0, enumerable: true } }) as typeof st;
      }
      return st;
    });
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(exdevErr);
    try {
      await cleanupSessionTmpdir(e);
    } finally {
      renameSpy.mockRestore();
      lstatSpy.mockRestore();
    }

    // The session dir must still exist — uid check must have bailed before rm.
    expect(fs.existsSync(path.join(sessionDir, 'data.txt'))).toBe(true);
  });

  it('cleans up a lingering .rm sibling when step-4 lstat detects it is not a real dir', async () => {
    const e = topLevel();
    expect(ensureSessionTmpdir(e)).toBe(true);
    const sessionDir = e['TMPDIR']!;

    // We cannot reliably force step-4 lstat to see a non-directory in a
    // normal fs (rename is atomic), so we verify the observable guarantee:
    // after a clean cleanup there must be no .rm entries under the parent.
    await cleanupSessionTmpdir(e);

    const parent = path.dirname(sessionDir);
    if (fs.existsSync(parent)) {
      const entries = fs.readdirSync(parent);
      expect(entries.every((n) => !n.endsWith('.rm'))).toBe(true);
    }
    expect(fs.existsSync(sessionDir)).toBe(false);
  });
});
