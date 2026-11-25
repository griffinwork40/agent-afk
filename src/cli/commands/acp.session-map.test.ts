/**
 * Tests for acp.session-map.ts — ACP id → AFK journal id mapping.
 *
 * Uses a temp AFK_HOME so reads/writes do not pollute the real state dir.
 *
 * @module cli/commands/acp.session-map.test
 */

import { mkdirSync, openSync, rmSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// node:fs injection flags
//
// vi.mock is hoisted above all imports. Per-test, set a flag to inject a
// one-shot failure; the mock forwards all other calls to the real implementation.
// ---------------------------------------------------------------------------

let openSyncThrowEexist = false;   // when true, every openSync call throws EEXIST
let readFileSyncEioPath = '';       // when non-empty, readFileSync throws EIO for that path

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (openSyncThrowEexist) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      return real.openSync(...args);
    },
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      const path = args[0];
      if (readFileSyncEioPath && typeof path === 'string' && path === readFileSyncEioPath) {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.readFileSync as any)(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Temp home — override AFK_HOME via the env module mock
// ---------------------------------------------------------------------------

let tmpHome: string;

vi.mock('../../config/env.js', () => ({
  env: new Proxy({} as Record<string, string | undefined>, {
    get(_t, k: string) {
      if (k === 'AFK_HOME') return tmpHome;
      return undefined;
    },
  }),
}));

// Import AFTER mock registration so paths resolve against tmpHome.
const { readAcpSessionMap, writeAcpSessionMap, recordAcpMapping, resolveAcpId, deleteAcpMapping } =
  await import('./acp.session-map.js');

beforeEach(() => {
  tmpHome = join(tmpdir(), `acp-map-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('readAcpSessionMap', () => {
  it('returns {} when the file does not exist', () => {
    expect(readAcpSessionMap()).toEqual({});
  });
});

describe('writeAcpSessionMap + readAcpSessionMap', () => {
  it('round-trips a mapping', async () => {
    await writeAcpSessionMap({ 'acp-1': 'afk-1', 'acp-2': 'afk-2' });
    expect(readAcpSessionMap()).toEqual({ 'acp-1': 'afk-1', 'acp-2': 'afk-2' });
  });
});

describe('recordAcpMapping', () => {
  it('no-op when acpId === afkId', async () => {
    await recordAcpMapping('same-id', 'same-id');
    expect(readAcpSessionMap()).toEqual({});
  });

  it('writes an entry when ids differ', async () => {
    await recordAcpMapping('acp-id', 'afk-id');
    expect(readAcpSessionMap()).toEqual({ 'acp-id': 'afk-id' });
  });

  it('merges with existing entries without clobbering', async () => {
    await recordAcpMapping('acp-1', 'afk-1');
    await recordAcpMapping('acp-2', 'afk-2');
    expect(readAcpSessionMap()).toEqual({ 'acp-1': 'afk-1', 'acp-2': 'afk-2' });
  });

  it('concurrent callers do not drop each other\'s mapping (item 2)', async () => {
    // Fire N concurrent recordAcpMapping calls; every entry must survive.
    const pairs = Array.from({ length: 8 }, (_, i) => [`acp-c${i}`, `afk-c${i}`] as const);
    await Promise.all(pairs.map(([a, b]) => recordAcpMapping(a, b)));
    const map = readAcpSessionMap();
    for (const [a, b] of pairs) {
      expect(map[a]).toBe(b);
    }
  });
});

describe('resolveAcpId', () => {
  it('returns acpId itself when no mapping exists', () => {
    expect(resolveAcpId('11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('returns the mapped afkId when a mapping exists', async () => {
    await writeAcpSessionMap({ 'acp-id': 'afk-other-id' });
    expect(resolveAcpId('acp-id')).toBe('afk-other-id');
  });
});

describe('lock contention', () => {
  afterEach(() => {
    // Reset all injection flags after every test in this describe block.
    openSyncThrowEexist = false;
    readFileSyncEioPath = '';
  });

  it('exhausts LOCK_RETRIES when openSync always throws EEXIST', async () => {
    openSyncThrowEexist = true;
    await expect(recordAcpMapping('a', 'b')).rejects.toThrow(
      'acp session-map lock contested after retries',
    );
  });

  it('clears a stale lock left by a dead PID and succeeds', async () => {
    // Spawn a child that exits immediately — its PID is guaranteed dead.
    const child = spawnSync(process.execPath, ['-e', '']);
    const deadPid = child.pid!;

    // Derive the lock path: same dir as the map file, filename session-map.lock.
    const { getAcpSessionMapPath } = await import('../../paths.js');
    const lockPath = join(dirname(getAcpSessionMapPath()), 'session-map.lock');

    // Write the lock file with the dead-PID token so openSync('wx') gets EEXIST.
    mkdirSync(dirname(lockPath), { recursive: true });
    const fd = openSync(lockPath, 'w');
    writeSync(fd, `${deadPid}:${Date.now()}:dead-uuid`);
    closeSync(fd);

    // acquireMapLock should detect the stale lock, clear it, and succeed.
    await expect(recordAcpMapping('acp-esrch', 'afk-esrch')).resolves.toBeUndefined();
    expect(readAcpSessionMap()['acp-esrch']).toBe('afk-esrch');
  });

  it('swallows EIO when reading the lock token and treats the lock as live (exhausts retries)', async () => {
    // Derive the lock path.
    const { getAcpSessionMapPath } = await import('../../paths.js');
    const lockPath = join(dirname(getAcpSessionMapPath()), 'session-map.lock');

    // Write a real lock file so openSync('wx') gets EEXIST and enters the stale-check branch.
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '99999:0:some-uuid');

    // Inject EIO for readFileSync on the lock path only.
    // The outer catch in acquireMapLock swallows it and treats the lock as live,
    // so all LOCK_RETRIES exhaust and the call throws the retries error.
    readFileSyncEioPath = lockPath;
    try {
      await expect(recordAcpMapping('io-err', 'afk-io')).rejects.toThrow(
        'acp session-map lock contested after retries',
      );
    } finally {
      readFileSyncEioPath = '';
      try { rmSync(lockPath); } catch { /* already gone */ }
    }
  });
});

describe('deleteAcpMapping', () => {
  it('removes a stale entry from the map', async () => {
    await recordAcpMapping('acp-stale', 'afk-stale');
    expect(readAcpSessionMap()['acp-stale']).toBe('afk-stale');
    await deleteAcpMapping('acp-stale');
    expect(readAcpSessionMap()['acp-stale']).toBeUndefined();
  });

  it('no-op when entry does not exist', async () => {
    await expect(deleteAcpMapping('nonexistent')).resolves.toBeUndefined();
  });
});

describe('legacy object entries (written by an earlier build)', () => {
  it('an object entry still resolves its afkId', async () => {
    await writeAcpSessionMap({ 'acp-id': { afkId: 'afk-id', cwd: '/ws' } });
    expect(resolveAcpId('acp-id')).toBe('afk-id');
  });

  it('a cwd-only entry resolves to the acp id itself', async () => {
    await writeAcpSessionMap({ 'acp-1': { cwd: '/ws' } });
    expect(resolveAcpId('acp-1')).toBe('acp-1');
  });

  it('a string entry resolves normally', async () => {
    await writeAcpSessionMap({ 'acp-legacy': 'afk-legacy' });
    expect(resolveAcpId('acp-legacy')).toBe('afk-legacy');
  });

  it('recording a mapping over a legacy object entry writes only the afkId string', async () => {
    await writeAcpSessionMap({ 'acp-id': { cwd: '/ws' } });
    await recordAcpMapping('acp-id', 'afk-id');
    expect(resolveAcpId('acp-id')).toBe('afk-id');
    expect(readAcpSessionMap()['acp-id']).toBe('afk-id');
  });

  it('readLegacyAcpCwd is no longer exported', async () => {
    const mod: Record<string, unknown> = await import('./acp.session-map.js');
    expect(mod['readLegacyAcpCwd']).toBeUndefined();
    expect(mod['recordAcpCwd']).toBeUndefined();
    expect(mod['acpSessionMapSettled']).toBeUndefined();
  });
});
