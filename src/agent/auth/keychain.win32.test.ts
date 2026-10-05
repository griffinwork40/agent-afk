/**
 * Regression: on win32, Claude Code stores its OAuth credentials in
 * `%USERPROFILE%\.claude\.credentials.json` (same file as Linux). The reader
 * used to be linux-only, so Windows users who had run `claude login` were
 * still asked for an API key by `afk login`.
 *
 * Portable by construction: `process.platform` is overridden and `homedir()`
 * is redirected to a temp dir, so this runs identically on every CI leg.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = { dir: '' };

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome.dir };
});

const {
  loadClaudeCodeOauthToken,
  refreshClaudeCodeOauthToken,
  claudeCodeCredentialsPath,
  _resetKeychainReadCache,
} = await import('./keychain.js');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: p });
}

function writeCreds(blob: unknown): string {
  const path = claudeCodeCredentialsPath();
  mkdirSync(join(fakeHome.dir, '.claude'), { recursive: true });
  writeFileSync(path, JSON.stringify(blob), 'utf-8');
  return path;
}

describe('Claude Code credentials on win32', () => {
  beforeEach(() => {
    fakeHome.dir = mkdtempSync(join(tmpdir(), 'afk-keychain-win32-'));
    _resetKeychainReadCache();
    setPlatform('win32');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    _resetKeychainReadCache();
    vi.unstubAllGlobals();
    rmSync(fakeHome.dir, { recursive: true, force: true });
  });

  it('resolves the credentials file under the home directory', () => {
    expect(claudeCodeCredentialsPath()).toBe(join(fakeHome.dir, '.claude', '.credentials.json'));
  });

  it('reads the OAuth access token from ~/.claude/.credentials.json', () => {
    writeCreds({
      claudeAiOauth: { accessToken: 'sk-ant-oat-win', expiresAt: Date.now() + 3_600_000 },
    });
    expect(loadClaudeCodeOauthToken()).toBe('sk-ant-oat-win');
  });

  it('returns undefined when the credentials file is absent', () => {
    expect(loadClaudeCodeOauthToken()).toBeUndefined();
  });

  it('writes a refreshed token back to the credentials file, preserving other fields', async () => {
    const path = writeCreds({
      claudeAiOauth: { accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() - 1_000 },
      mcpOAuth: { keep: true },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'new', refresh_token: 'rt-2', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(refreshClaudeCodeOauthToken()).resolves.toBe('new');

    const written = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(written['claudeAiOauth']?.['accessToken']).toBe('new');
    expect(written['claudeAiOauth']?.['refreshToken']).toBe('rt-2');
    expect(written['mcpOAuth']).toEqual({ keep: true });
  });
});
