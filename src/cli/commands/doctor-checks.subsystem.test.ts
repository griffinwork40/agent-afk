import { describe, it, expect } from 'vitest';
import {
  checkMemoryStore,
  checkDaemonState,
  checkNodeVersion,
  checkHookConfig,
  checkWitnessDir,
} from './doctor-checks.subsystem.js';
import { constants } from 'fs/promises';

// ---------------------------------------------------------------------------
// checkMemoryStore
// ---------------------------------------------------------------------------

describe('checkMemoryStore', () => {
  it('passes when openAndCount succeeds', async () => {
    const result = await checkMemoryStore({
      dbPath: '/fake/kv.db',
      openAndCount: async () => 5,
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('/fake/kv.db');
    expect(result.detail).toContain('5');
  });

  it('passes (not yet created) when ENOENT is thrown', async () => {
    const result = await checkMemoryStore({
      dbPath: '/fake/kv.db',
      openAndCount: async () => {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      },
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('not yet created');
  });

  it('warns when openAndCount throws a non-ENOENT error', async () => {
    const result = await checkMemoryStore({
      dbPath: '/fake/kv.db',
      openAndCount: async () => {
        throw new Error('disk I/O error');
      },
    });
    expect(result.state).toBe('warn');
    expect(result.fix).toContain('disk I/O error');
  });
});

// ---------------------------------------------------------------------------
// checkDaemonState
// ---------------------------------------------------------------------------

describe('checkDaemonState', () => {
  it('passes with "not running" when lock file is absent (ENOENT)', async () => {
    const result = await checkDaemonState({
      lockPath: '/fake/daemon.lock',
      readLockFile: async () => {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      },
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toBe('not running');
  });

  it('passes when lock file contains a live PID', async () => {
    const result = await checkDaemonState({
      lockPath: '/fake/daemon.lock',
      readLockFile: async () => '99999\n',
      isAlive: () => true,
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('99999');
  });

  it('warns when lock file exists but PID is dead (stale lock)', async () => {
    const result = await checkDaemonState({
      lockPath: '/fake/daemon.lock',
      readLockFile: async () => '99999\n',
      isAlive: () => false,
    });
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('stale');
    expect(result.fix).toContain('/fake/daemon.lock');
  });

  it('warns when lock file content is not a number', async () => {
    const result = await checkDaemonState({
      lockPath: '/fake/daemon.lock',
      readLockFile: async () => 'not-a-pid',
      isAlive: () => false,
    });
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('non-numeric');
  });

  it('warns when lock file cannot be read (non-ENOENT error)', async () => {
    const result = await checkDaemonState({
      lockPath: '/fake/daemon.lock',
      readLockFile: async () => {
        throw new Error('permission denied');
      },
    });
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('could not read');
  });
});

// ---------------------------------------------------------------------------
// checkNodeVersion
// ---------------------------------------------------------------------------

describe('checkNodeVersion', () => {
  const range = '^22.22.2 || ^24.15.0 || >=26.0.0';

  it('passes when current version satisfies the range', async () => {
    const result = await checkNodeVersion({
      enginesNode: range,
      currentVersion: 'v22.22.2',
      satisfies: () => true,
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('v22.22.2');
    expect(result.detail).toContain(range);
  });

  it('fails when current version does not satisfy the range', async () => {
    const result = await checkNodeVersion({
      enginesNode: range,
      currentVersion: 'v18.0.0',
      satisfies: () => false,
    });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('v18.0.0');
    expect(result.fix).toContain(range);
  });

  it('warns when enginesNode is missing', async () => {
    const result = await checkNodeVersion({
      enginesNode: null,
      currentVersion: 'v22.0.0',
      satisfies: () => true,
    });
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('engines.node not found');
  });

  it('warns when satisfies is not available', async () => {
    const result = await checkNodeVersion({
      enginesNode: range,
      currentVersion: 'v22.22.2',
      satisfies: null,
    });
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('version range check unavailable');
  });
});

// ---------------------------------------------------------------------------
// checkHookConfig
// ---------------------------------------------------------------------------

describe('checkHookConfig', () => {
  it('passes when settings.json is absent (ENOENT)', async () => {
    const result = await checkHookConfig({
      settingsPath: '/fake/settings.json',
      readFile: async () => {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      },
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('no settings.json');
  });

  it('fails when settings.json is not valid JSON', async () => {
    const result = await checkHookConfig({
      settingsPath: '/fake/settings.json',
      readFile: async () => '{ invalid json',
    });
    expect(result.state).toBe('fail');
    expect(result.fix).toContain('not valid JSON');
  });

  it('passes when settings.json has no hooks key', async () => {
    const result = await checkHookConfig({
      settingsPath: '/fake/settings.json',
      readFile: async () => JSON.stringify({ model: 'claude-opus-4-5' }),
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('no hooks defined');
  });

  it('passes when all hook events are valid', async () => {
    const result = await checkHookConfig({
      settingsPath: '/fake/settings.json',
      readFile: async () =>
        JSON.stringify({ hooks: { PreToolUse: [], PostToolUse: [] } }),
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('2 events');
  });

  it('warns when an unknown hook event name is present', async () => {
    const result = await checkHookConfig({
      settingsPath: '/fake/settings.json',
      readFile: async () =>
        JSON.stringify({ hooks: { PreToolUse: [], UnknownEvent: [] } }),
    });
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('UnknownEvent');
    expect(result.fix).toContain('PreToolUse');
  });

  it('warns when settings.json cannot be read (non-ENOENT)', async () => {
    const result = await checkHookConfig({
      settingsPath: '/fake/settings.json',
      readFile: async () => {
        throw new Error('permission denied');
      },
    });
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('could not read');
  });

  it('passes with singular "event" label when exactly one hook is configured', async () => {
    const result = await checkHookConfig({
      settingsPath: '/fake/settings.json',
      readFile: async () => JSON.stringify({ hooks: { SessionStart: [] } }),
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('1 event configured');
    expect(result.detail).not.toContain('events');
  });
});

// ---------------------------------------------------------------------------
// checkWitnessDir
// ---------------------------------------------------------------------------

describe('checkWitnessDir', () => {
  it('passes when directory is writable and probe write succeeds', async () => {
    const result = await checkWitnessDir({
      witnessRoot: '/fake/witness',
      checkAccess: async () => {},
      writeProbe: async () => {},
      removeProbe: async () => {},
    });
    expect(result.state).toBe('pass');
    expect(result.detail).toBe('/fake/witness');
  });

  it('fails when directory exists but is not writable (non-ENOENT access error)', async () => {
    const result = await checkWitnessDir({
      witnessRoot: '/fake/witness',
      checkAccess: async () => {
        const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
        throw err;
      },
      writeProbe: async () => {},
      removeProbe: async () => {},
    });
    expect(result.state).toBe('fail');
    expect(result.fix).toContain('not writable');
  });

  it('fails when probe write throws ENOSPC (disk full)', async () => {
    const result = await checkWitnessDir({
      witnessRoot: '/fake/witness',
      checkAccess: async () => {},
      writeProbe: async () => {
        const err = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        throw err;
      },
      removeProbe: async () => {},
    });
    expect(result.state).toBe('fail');
    expect(result.fix).toContain('Disk is full');
  });

  it('fails when probe write throws a generic error', async () => {
    const result = await checkWitnessDir({
      witnessRoot: '/fake/witness',
      checkAccess: async () => {},
      writeProbe: async () => {
        throw new Error('read-only filesystem');
      },
      removeProbe: async () => {},
    });
    expect(result.state).toBe('fail');
    expect(result.fix).toContain('read-only filesystem');
  });

  it('proceeds to probe write when directory does not exist yet (ENOENT on access)', async () => {
    let probeWritten = false;
    const result = await checkWitnessDir({
      witnessRoot: '/fake/witness',
      checkAccess: async () => {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      },
      writeProbe: async () => {
        probeWritten = true;
      },
      removeProbe: async () => {},
    });
    expect(probeWritten).toBe(true);
    expect(result.state).toBe('pass');
  });
});
