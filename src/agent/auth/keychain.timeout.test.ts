/**
 * The macOS keychain read is a synchronous `security` subprocess, so a locked
 * keychain or an access prompt would block the whole process. Covered here:
 *
 *  - the read passes a `timeout` to execFileSync;
 *  - a TIMEOUT arms a backoff: further reads skip the subprocess until reset;
 *  - a non-timeout failure (entry missing) does NOT arm the backoff, so a
 *    `claude login` run while a daemon is live is seen on the next read;
 *  - `quiet: true` suppresses the "token is expired" stderr warning that a
 *    per-turn background check would otherwise print every turn.
 *
 * Portable by construction: `process.platform` is overridden to darwin and
 * `execFileSync` is mocked, so this runs identically on every CI leg.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: execFileSyncMock };
});
vi.mock('../providers/shared/h1-fetch.js', () => ({ h1ModelFetch: vi.fn() }));

const { loadClaudeCodeOauthToken, _resetKeychainReadCache } = await import('./keychain.js');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function blob(expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'tok-a', expiresAt } });
}

function timeoutError(): Error {
  return Object.assign(new Error('spawnSync security ETIMEDOUT'), { code: 'ETIMEDOUT' });
}

describe('keychain read on darwin: timeout, backoff, quiet', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
    _resetKeychainReadCache();
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    _resetKeychainReadCache();
    vi.restoreAllMocks();
  });

  it('bounds the security subprocess with a timeout', () => {
    execFileSyncMock.mockReturnValue(blob(Date.now() + 3_600_000));
    expect(loadClaudeCodeOauthToken()).toBe('tok-a');
    const opts = execFileSyncMock.mock.calls[0]?.[2] as { timeout?: number };
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('after a timeout, skips the subprocess until the backoff is reset', () => {
    execFileSyncMock.mockImplementation(() => { throw timeoutError(); });
    expect(loadClaudeCodeOauthToken()).toBeUndefined();
    expect(loadClaudeCodeOauthToken()).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    _resetKeychainReadCache();
    execFileSyncMock.mockReturnValue(blob(Date.now() + 3_600_000));
    expect(loadClaudeCodeOauthToken()).toBe('tok-a');
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('a non-timeout failure (entry missing) does not arm the backoff', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('exit 44'), { status: 44 });
    });
    expect(loadClaudeCodeOauthToken()).toBeUndefined();

    execFileSyncMock.mockReturnValue(blob(Date.now() + 3_600_000));
    expect(loadClaudeCodeOauthToken()).toBe('tok-a');
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('warns about an expired token by default, and stays silent with quiet', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    execFileSyncMock.mockReturnValue(blob(Date.now() - 1_000));

    expect(loadClaudeCodeOauthToken({ quiet: true })).toBeUndefined();
    expect(write).not.toHaveBeenCalled();

    expect(loadClaudeCodeOauthToken()).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
